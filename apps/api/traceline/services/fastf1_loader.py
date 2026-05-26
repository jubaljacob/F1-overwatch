"""Thin wrapper around FastF1 with disk caching enabled once at import.

Never call these functions from a synchronous request hot path — they may take
1-3 minutes on a cold cache. P1+ will move heavy loads behind a background job
queue; for P0 the smoke endpoints accept the latency.
"""

from __future__ import annotations

import logging
import time
from functools import lru_cache

import fastf1
from fastf1.core import Session
from requests.adapters import HTTPAdapter
from requests.exceptions import ChunkedEncodingError

from traceline.config import settings
from traceline.schemas.session import DriverInfo, SampleLap, SessionMeta

logger = logging.getLogger(__name__)

_CACHE_INITIALISED = False


def _ensure_cache() -> None:
    global _CACHE_INITIALISED
    if _CACHE_INITIALISED:
        return
    settings.fastf1_cache_dir.mkdir(parents=True, exist_ok=True)
    fastf1.Cache.enable_cache(str(settings.fastf1_cache_dir))
    # Mount a retry adapter on FastF1's cached session so IncompleteRead /
    # connection drops on large telemetry files (CarData, Position ~8MB) are
    # retried at the HTTP level rather than surfacing as a load failure.
    _patch_fastf1_session_retries()
    _CACHE_INITIALISED = True
    logger.info("FastF1 cache enabled at %s", settings.fastf1_cache_dir)


class _ChunkedRetryAdapter(HTTPAdapter):
    """Retry on IncompleteRead / ChunkedEncodingError for large F1 telemetry files.

    requests_cache reads response.content after send() returns. If the server
    drops the connection mid-stream, that raises ChunkedEncodingError which
    propagates as a FastF1 telemetry load failure. Pre-reading the body inside
    send() lets us retry the whole request before requests_cache ever sees it.
    """

    _MAX_ATTEMPTS = 5
    _RETRY_DELAY = 2.0

    def send(self, request, **kwargs):  # type: ignore[override]
        last_exc: Exception | None = None
        for attempt in range(1, self._MAX_ATTEMPTS + 1):
            try:
                resp = super().send(request, **kwargs)
                # Force full body read now so IncompleteRead surfaces here.
                _ = resp.content
                return resp
            except ChunkedEncodingError as exc:
                last_exc = exc
                logger.warning(
                    "ChunkedEncodingError on %s (attempt %d/%d) — retrying",
                    request.url,
                    attempt,
                    self._MAX_ATTEMPTS,
                )
                if attempt < self._MAX_ATTEMPTS:
                    time.sleep(self._RETRY_DELAY)
        raise last_exc  # type: ignore[misc]


def _patch_fastf1_session_retries() -> None:
    from fastf1 import req as f1req

    adapter = _ChunkedRetryAdapter()
    sess = f1req.Cache._requests_session_cached
    sess.mount("https://", adapter)
    sess.mount("http://", adapter)
    logger.info("Mounted ChunkedRetryAdapter on FastF1 cached session")


class TelemetryFetchError(RuntimeError):
    """FastF1's load() completed but position data is missing.

    FastF1 sometimes silently warns ("Failed to load telemetry data!") when
    the F1 live-timing endpoint hiccups, rather than raising. We detect that
    after the fact so the API can return an actionable error instead of a
    DataNotLoadedError deep in the request pipeline. Retrying usually works
    because the second fetch lands cleanly and FastF1 caches it to disk.
    """


@lru_cache(maxsize=8)
def _load_session_cached(year: int, round_: int, session_type: str) -> Session:
    _ensure_cache()
    session = fastf1.get_session(year, round_, session_type)
    session.load()
    return session


@lru_cache(maxsize=8)
def _load_session_with_telemetry_cached(year: int, round_: int, session_type: str) -> Session:
    _ensure_cache()
    max_attempts = 4
    for attempt in range(1, max_attempts + 1):
        session = fastf1.get_session(year, round_, session_type)
        try:
            session.load()
        except Exception as e:
            logger.warning("session.load() raised on attempt %d/%d: %s", attempt, max_attempts, e)
            _load_session_with_telemetry_cached.cache_clear()
            if attempt == max_attempts:
                raise TelemetryFetchError(f"FastF1 session.load() failed after {max_attempts} attempts: {e}") from e
            continue
        if _has_position_data(session):
            return session
        logger.warning("No position data on attempt %d/%d — retrying", attempt, max_attempts)
        _load_session_with_telemetry_cached.cache_clear()
    raise TelemetryFetchError(
        f"FastF1 failed to fetch position_data for {year} R{round_} {session_type} "
        f"after {max_attempts} attempts (IncompleteRead from F1 timing server). "
        "Check network stability."
    )


def _has_position_data(session: Session) -> bool:
    try:
        pos = session.pos_data
    except Exception:
        return False
    return bool(pos)


def load_session(
    year: int, round_: int, session_type: str = "R", with_telemetry: bool = False
) -> Session:
    """Load a session, cached per process.

    Pass `with_telemetry=True` for endpoints that need position/car data.
    That variant raises `TelemetryFetchError` if position data is absent.
    """
    if with_telemetry:
        return _load_session_with_telemetry_cached(year, round_, session_type)
    return _load_session_cached(year, round_, session_type)


def get_session_meta(year: int, round_: int, session_type: str = "R") -> SessionMeta:
    session = load_session(year, round_, session_type)
    drivers: list[DriverInfo] = []
    for drv in session.drivers:
        info = session.get_driver(drv)
        drivers.append(
            DriverInfo(
                number=int(info.get("DriverNumber", drv)),
                code=str(info.get("Abbreviation", "")),
                full_name=f"{info.get('FirstName', '')} {info.get('LastName', '')}".strip(),
                team=str(info.get("TeamName", "")),
                team_colour=_normalise_colour(info.get("TeamColor")),
            )
        )
    total_laps = int(session.total_laps) if session.total_laps else None
    return SessionMeta(
        year=year,
        round=round_,
        circuit=str(session.event.get("EventName", "")),
        session_type=session_type,
        total_laps=total_laps,
        drivers=drivers,
    )


def get_sample_lap(year: int, round_: int, driver_code: str, session_type: str = "R") -> SampleLap:
    """Return the driver's fastest lap from the session — P0 smoke endpoint."""
    session = load_session(year, round_, session_type)
    laps = session.laps.pick_drivers(driver_code)
    if laps.empty:
        raise ValueError(f"No laps found for driver {driver_code}")
    fastest = laps.pick_fastest()
    return SampleLap(
        driver_code=driver_code,
        lap_number=int(fastest["LapNumber"]),
        lap_time_seconds=float(fastest["LapTime"].total_seconds()),
        compound=str(fastest["Compound"]) if fastest["Compound"] else None,
    )


def _normalise_colour(value: object) -> str | None:
    if not value:
        return None
    s = str(value).lstrip("#")
    return s if len(s) == 6 else None
