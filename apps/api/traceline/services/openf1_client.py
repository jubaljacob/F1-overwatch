"""Thin HTTP client for the OpenF1 API (https://api.openf1.org).

OpenF1 is a public, schema-clean alternative to scraping F1's livetiming
endpoint directly. It mirrors much of the same data via JSON HTTP, which lets
us keep F1Overwatch working when F1's CDN is blocking FastF1 (the situation as
of 2026-05-26).

Scope here is deliberately small: only the endpoints the RaceData loader
needs, and only with the filters we actually use. No global response cache —
the higher-level loader memoises full RaceData blobs anyway.

OpenF1 lookup model:
  /meetings?year=Y           → meetings (one per GP), ordered by date
  /sessions?meeting_key=M    → sessions within a meeting (FP1/Q/Sprint/Race)
  /drivers?session_key=S     → driver roster for that session
  /location?session_key=S    → x, y, z position over time, per driver
  /laps?session_key=S        → per-lap metadata (lap_duration, sectors, pits)
  /position?session_key=S    → race position over time, per driver
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import random
import time
from pathlib import Path
from typing import Any

import httpx

from traceline.config import settings

logger = logging.getLogger(__name__)

OPENF1_BASE_URL = "https://api.openf1.org/v1"
DEFAULT_TIMEOUT_S = 30.0
MAX_RETRIES = 3
RETRY_BACKOFF_S = 2.0
# 429s are expected on bursty per-driver fan-outs; give them their own,
# larger retry budget so a rate-limited burst doesn't consume the small
# server-error budget that 5xx/network errors share.
MAX_RATE_LIMIT_RETRIES = 6
# Cap on how long we'll honour a server-provided Retry-After hint. OpenF1
# occasionally suggests minute-scale waits that would blow past the route
# timeout; bound it and let our own backoff do the rest.
MAX_RETRY_AFTER_S = 15.0


class OpenF1Error(RuntimeError):
    """Raised when OpenF1 fails to satisfy a request after retries."""


class OpenF1Client:
    """Synchronous httpx wrapper with linear-backoff retry on 5xx / network errors.

    We use sync rather than async because the FastAPI route already runs the
    heavy loader on a worker thread; mixing event loops there is more friction
    than it's worth at this scale.
    """

    def __init__(
        self,
        base_url: str = OPENF1_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_S,
        max_retries: int = MAX_RETRIES,
    ) -> None:
        self._client = httpx.Client(base_url=base_url, timeout=timeout)
        self._max_retries = max_retries

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> OpenF1Client:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def get(self, path: str, **params: Any) -> list[dict[str, Any]]:
        """GET a list endpoint; returns the decoded JSON array.

        Every OpenF1 list endpoint returns a JSON array, so we type-narrow
        here rather than at every call site.

        Two layers of resilience:
          1. Disk cache (dev-only, see config.openf1_cache_enabled): keyed
             by (path, params). Past-session data is immutable, so a hit
             skips the network entirely. This makes failed builds resumable
             across retries instead of re-burning the rate limit each time.
          2. Retry policy: 5xx and network errors share `_max_retries` with
             linear backoff; 429 gets its own larger budget and honours the
             server's Retry-After header (clamped) with jitter on top.
        """
        # Drop None params so the URL doesn't get cluttered with empty values.
        clean = {k: v for k, v in params.items() if v is not None}

        cache_path = _cache_path_for(path, clean)
        if cache_path is not None:
            cached = _read_cache(cache_path)
            if cached is not None:
                return cached

        last_err: Exception | None = None
        server_attempts = 0  # 5xx / network errors
        rate_limit_attempts = 0  # 429s — separate budget
        while True:
            try:
                resp = self._client.get(path, params=clean)
                if resp.status_code == 429:
                    rate_limit_attempts += 1
                    if rate_limit_attempts > MAX_RATE_LIMIT_RETRIES:
                        raise OpenF1Error(
                            f"OpenF1 {path} rate-limited after "
                            f"{MAX_RATE_LIMIT_RETRIES} retries"
                        )
                    delay = _retry_after_delay(resp, rate_limit_attempts)
                    logger.warning(
                        "OpenF1 %s 429 (attempt %d/%d), sleeping %.1fs",
                        path,
                        rate_limit_attempts,
                        MAX_RATE_LIMIT_RETRIES,
                        delay,
                    )
                    time.sleep(delay)
                    continue
                if resp.status_code >= 500:
                    raise httpx.HTTPStatusError(
                        f"server error {resp.status_code}",
                        request=resp.request,
                        response=resp,
                    )
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, list):
                    raise OpenF1Error(f"{path} returned non-array body: {type(data).__name__}")
                if cache_path is not None:
                    _write_cache(cache_path, data)
                return data
            except (httpx.HTTPStatusError, httpx.RequestError) as exc:
                last_err = exc
                server_attempts += 1
                logger.warning(
                    "OpenF1 %s attempt %d/%d failed: %s",
                    path,
                    server_attempts,
                    self._max_retries,
                    exc,
                )
                if server_attempts >= self._max_retries:
                    break
                time.sleep(RETRY_BACKOFF_S * server_attempts)
        raise OpenF1Error(f"OpenF1 {path} failed after {self._max_retries} attempts: {last_err}")

    # --- typed convenience wrappers ---------------------------------------

    def meetings(self, year: int) -> list[dict[str, Any]]:
        """All meetings (GPs) for a given calendar year."""
        return self.get("/meetings", year=year)

    def sessions(self, meeting_key: int, session_name: str | None = None) -> list[dict[str, Any]]:
        """Sessions (FP1/FP2/FP3/Q/Sprint/Race) for a meeting."""
        return self.get("/sessions", meeting_key=meeting_key, session_name=session_name)

    def drivers(self, session_key: int) -> list[dict[str, Any]]:
        return self.get("/drivers", session_key=session_key)

    def location(self, session_key: int, driver_number: int | None = None) -> list[dict[str, Any]]:
        """Position samples (x, y, z) for one or all drivers in a session.

        Volume warning: full-session pulls are ~10-50MB; prefer per-driver
        fetches when possible. The loader paginates by driver to keep memory
        bounded.
        """
        return self.get("/location", session_key=session_key, driver_number=driver_number)

    def laps(self, session_key: int, driver_number: int | None = None) -> list[dict[str, Any]]:
        return self.get("/laps", session_key=session_key, driver_number=driver_number)

    def position(
        self, session_key: int, driver_number: int | None = None
    ) -> list[dict[str, Any]]:
        """Race-order position over time. Last row per driver = final classification."""
        return self.get("/position", session_key=session_key, driver_number=driver_number)

    def stints(self, session_key: int, driver_number: int | None = None) -> list[dict[str, Any]]:
        """Tyre stints per driver: one row per (driver, stint_number) with
        compound + lap range + tyre age at stint start. OpenF1's /laps does
        not carry compound info — this is the source of truth.
        """
        return self.get("/stints", session_key=session_key, driver_number=driver_number)

    def weather(self, session_key: int) -> list[dict[str, Any]]:
        """Session weather samples. Each row: air_temperature, track_temperature,
        humidity, pressure, rainfall, wind_speed, wind_direction, date."""
        return self.get("/weather", session_key=session_key)

    def race_control(self, session_key: int) -> list[dict[str, Any]]:
        """Race-control timeline: flags, safety-car deployments, VSC, etc.
        One row per event; rows are not deduped — adjacent same-status events
        do occur (e.g., SC deployed twice during a long caution period)."""
        return self.get("/race_control", session_key=session_key)

    def car_data(
        self, session_key: int, driver_number: int | None = None
    ) -> list[dict[str, Any]]:
        """Per-driver telemetry: speed, n_gear, throttle, brake, drs, rpm.

        Volume warning: full-session pulls can be 50MB+ per driver at 4 Hz
        native rate. The loader paginates by driver to keep memory bounded
        and processes each driver's payload before fetching the next.
        """
        return self.get("/car_data", session_key=session_key, driver_number=driver_number)


# --- dev-only response cache ---------------------------------------------
# TODO(prod): remove this block (and the config flags) before deploy.
# It exists to make local development survive OpenF1 rate limits during
# cold builds; production should serve from the racedata blob cache and
# never re-burst the upstream API.


def _cache_path_for(path: str, params: dict[str, Any]) -> Path | None:
    if not settings.openf1_cache_enabled:
        return None
    # Stable key: endpoint + sorted param pairs. Hash keeps filenames
    # short and filesystem-safe even if params grow.
    key_src = path + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params))
    digest = hashlib.sha1(key_src.encode("utf-8")).hexdigest()[:16]
    # Endpoint slug in the filename makes the cache dir grep-friendly.
    slug = path.strip("/").replace("/", "_") or "root"
    return settings.openf1_cache_dir / f"{slug}_{digest}.json.gz"


def _read_cache(path: Path) -> list[dict[str, Any]] | None:
    if not path.exists():
        return None
    try:
        with gzip.open(path, "rb") as f:
            data = json.loads(f.read())
        if isinstance(data, list):
            return data
        return None
    except Exception as e:
        logger.warning("OpenF1 cache read failed for %s: %s", path.name, e)
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
        return None


def _write_cache(path: Path, data: list[dict[str, Any]]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with gzip.open(tmp, "wb") as f:
            f.write(json.dumps(data, separators=(",", ":")).encode("utf-8"))
        tmp.replace(path)
    except Exception as e:
        logger.warning("OpenF1 cache write failed for %s: %s", path.name, e)
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass


def _retry_after_delay(resp: httpx.Response, attempt: int) -> float:
    """Decide how long to wait after a 429.

    Prefer the server's Retry-After header (seconds or HTTP-date); fall
    back to exponential backoff with jitter when it's absent or unparseable.
    Always clamp to MAX_RETRY_AFTER_S so a hostile/buggy hint can't stall
    the request beyond the route timeout.
    """
    header = resp.headers.get("retry-after")
    if header:
        try:
            value = float(header)
            if value >= 0:
                return min(value, MAX_RETRY_AFTER_S) + random.uniform(0, 0.5)
        except ValueError:
            # HTTP-date form — ignore and fall through to backoff. We
            # don't bother parsing it; OpenF1 uses seconds in practice.
            pass
    # Exponential with jitter, capped.
    backoff = min(RETRY_BACKOFF_S * (2 ** (attempt - 1)), MAX_RETRY_AFTER_S)
    return backoff + random.uniform(0, 0.5)


def resolve_session_key(
    client: OpenF1Client,
    year: int,
    round_: int,
    session_name: str = "Race",
) -> tuple[int, dict[str, Any]]:
    """Map (year, round) → OpenF1 session_key + the session dict.

    OpenF1 doesn't index meetings by round number directly, but the meetings
    list comes back date-sorted, so `round_ = 1` is the first event. Mirrors
    the FastF1 round convention.
    """
    meetings = client.meetings(year)
    if not meetings:
        raise OpenF1Error(f"OpenF1 returned no meetings for {year}")
    # Date-sort defensively in case OpenF1 ever changes ordering.
    meetings_sorted = sorted(meetings, key=lambda m: m.get("date_start", ""))
    if round_ < 1 or round_ > len(meetings_sorted):
        raise OpenF1Error(
            f"round {round_} out of range for {year} (have {len(meetings_sorted)} meetings)"
        )
    meeting = meetings_sorted[round_ - 1]
    meeting_key = meeting["meeting_key"]
    sessions = client.sessions(meeting_key=meeting_key, session_name=session_name)
    if not sessions:
        raise OpenF1Error(
            f"OpenF1 meeting {meeting_key} ({meeting.get('meeting_name')}) "
            f"has no session named {session_name!r}"
        )
    session = sessions[0]
    return int(session["session_key"]), session
