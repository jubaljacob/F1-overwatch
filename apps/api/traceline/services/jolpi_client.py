"""Thin HTTP client for the Jolpi mirror of Ergast.

Jolpi (https://api.jolpi.ca/ergast/f1/) is the community-maintained drop-in
replacement for the original Ergast F1 API, which is being deprecated. We
use it for two things the OpenF1 / FastF1 path doesn't give us cheaply:

  - Per-year driver and constructor championship standings (aggregated
    across every completed round of that season).
  - A clean, authoritative race calendar with circuit metadata.

Standings change after each completed race, so we cache responses on disk
with a short TTL rather than treating them as immutable.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

from traceline.config import settings

logger = logging.getLogger(__name__)

JOLPI_BASE_URL = "https://api.jolpi.ca/ergast/f1"
DEFAULT_TIMEOUT_S = 15.0
MAX_RETRIES = 3
RETRY_BACKOFF_S = 2.0


class JolpiError(RuntimeError):
    """Raised when Jolpi fails to satisfy a request after retries."""


class JolpiClient:
    """Synchronous httpx wrapper with disk cache + linear-backoff retry.

    Caches are keyed by `(path, params)` under `.jolpi-cache/` with a TTL
    embedded in the file's mtime check, since standings move after every
    race weekend and we want to surface fresh data without DoSing Jolpi.
    """

    def __init__(
        self,
        base_url: str = JOLPI_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT_S,
        max_retries: int = MAX_RETRIES,
        cache_ttl_s: float = 3600.0,
    ) -> None:
        # User-Agent identifies the project so Jolpi maintainers can spot
        # us if our usage ever becomes a problem.
        self._client = httpx.Client(
            base_url=base_url,
            timeout=timeout,
            headers={"User-Agent": "F1Overwatch/0.1 (+github.com/jubaljacob/F1-overwatch)"},
        )
        self._max_retries = max_retries
        self._cache_ttl_s = cache_ttl_s

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> JolpiClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def get(self, path: str) -> dict[str, Any]:
        """GET `{path}.json` and return the parsed body. Cached on disk."""
        cache_path = _cache_path_for(path)
        cached = _read_cache(cache_path, self._cache_ttl_s)
        if cached is not None:
            return cached

        last_err: Exception | None = None
        for attempt in range(1, self._max_retries + 1):
            try:
                resp = self._client.get(f"{path}.json")
                if resp.status_code == 429:
                    # Jolpi rate-limits aggressive callers; back off and retry.
                    delay = RETRY_BACKOFF_S * (2 ** (attempt - 1))
                    logger.warning("Jolpi %s 429 (attempt %d), sleeping %.1fs", path, attempt, delay)
                    time.sleep(delay)
                    continue
                resp.raise_for_status()
                data = resp.json()
                if not isinstance(data, dict):
                    raise JolpiError(f"{path} returned non-object body")
                _write_cache(cache_path, data)
                return data
            except (httpx.HTTPStatusError, httpx.RequestError) as exc:
                last_err = exc
                logger.warning(
                    "Jolpi %s attempt %d/%d failed: %s", path, attempt, self._max_retries, exc
                )
                if attempt < self._max_retries:
                    time.sleep(RETRY_BACKOFF_S * attempt)
        raise JolpiError(f"Jolpi {path} failed after {self._max_retries} attempts: {last_err}")

    # --- typed convenience wrappers ---------------------------------------

    def schedule(self, year: int) -> list[dict[str, Any]]:
        """Race calendar for a given season."""
        data = self.get(f"/{year}")
        return data.get("MRData", {}).get("RaceTable", {}).get("Races", [])

    def driver_standings(self, year: int) -> tuple[int, list[dict[str, Any]]]:
        """Returns `(round_completed, standings)`. round=0 if season hasn't started."""
        data = self.get(f"/{year}/driverStandings")
        lists = data.get("MRData", {}).get("StandingsTable", {}).get("StandingsLists", [])
        if not lists:
            return 0, []
        head = lists[0]
        return int(head.get("round", 0)), head.get("DriverStandings", [])

    def race_results(self, year: int, round_: int) -> list[dict[str, Any]]:
        """Top-N finishers for a single race. Empty list if the race hasn't
        run yet or upstream returned no data."""
        data = self.get(f"/{year}/{round_}/results")
        races = data.get("MRData", {}).get("RaceTable", {}).get("Races", [])
        if not races:
            return []
        return races[0].get("Results", [])

    def constructor_standings(self, year: int) -> tuple[int, list[dict[str, Any]]]:
        data = self.get(f"/{year}/constructorStandings")
        lists = data.get("MRData", {}).get("StandingsTable", {}).get("StandingsLists", [])
        if not lists:
            return 0, []
        head = lists[0]
        return int(head.get("round", 0)), head.get("ConstructorStandings", [])


# --- disk cache helpers ---------------------------------------------------


def _cache_path_for(path: str) -> Path:
    digest = hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]
    slug = path.strip("/").replace("/", "_") or "root"
    return settings.jolpi_cache_dir / f"{slug}_{digest}.json.gz"


def _read_cache(path: Path, ttl_s: float) -> dict[str, Any] | None:
    if not path.exists():
        return None
    # TTL check via mtime — older than `ttl_s` and we treat the file as
    # expired and refetch. Cheap and avoids embedding timestamps in the
    # cache payload.
    age = time.time() - path.stat().st_mtime
    if age > ttl_s:
        return None
    try:
        with gzip.open(path, "rb") as f:
            data = json.loads(f.read())
        return data if isinstance(data, dict) else None
    except Exception as e:
        logger.warning("Jolpi cache read failed for %s: %s", path.name, e)
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
        return None


def _write_cache(path: Path, data: dict[str, Any]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with gzip.open(tmp, "wb") as f:
            f.write(json.dumps(data, separators=(",", ":")).encode("utf-8"))
        tmp.replace(path)
    except Exception as e:
        logger.warning("Jolpi cache write failed for %s: %s", path.name, e)
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
