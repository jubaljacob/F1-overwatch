"""Thin HTTP client for the OpenF1 API (https://api.openf1.org).

OpenF1 is a public, schema-clean alternative to scraping F1's livetiming
endpoint directly. It mirrors much of the same data via JSON HTTP, which lets
us keep TraceLine working when F1's CDN is blocking FastF1 (the situation as
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

import logging
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

OPENF1_BASE_URL = "https://api.openf1.org/v1"
DEFAULT_TIMEOUT_S = 30.0
MAX_RETRIES = 3
RETRY_BACKOFF_S = 2.0


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
        """
        # Drop None params so the URL doesn't get cluttered with empty values.
        clean = {k: v for k, v in params.items() if v is not None}
        last_err: Exception | None = None
        for attempt in range(1, self._max_retries + 1):
            try:
                resp = self._client.get(path, params=clean)
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
                return data
            except (httpx.HTTPStatusError, httpx.RequestError) as exc:
                last_err = exc
                logger.warning(
                    "OpenF1 %s attempt %d/%d failed: %s",
                    path,
                    attempt,
                    self._max_retries,
                    exc,
                )
                if attempt < self._max_retries:
                    time.sleep(RETRY_BACKOFF_S * attempt)
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
