"""Live-season endpoint — schedule + standings for the landing dashboard."""

from __future__ import annotations

import logging
import re
from functools import partial

from anyio import to_thread
from fastapi import APIRouter, HTTPException

from traceline.config import settings
from traceline.schemas.season import RaceResultsPayload, SeasonPayload
from traceline.services.season_loader import fetch_race_results, fetch_season

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/seasons", tags=["seasons"])


@router.get("/{year}", response_model=SeasonPayload)
async def get_season(year: int) -> SeasonPayload:
    """Return schedule + driver standings + constructor standings for a year.

    Backed by Jolpi (Ergast mirror) with a 1-hour disk cache, so repeated
    calls are cheap. Errors degrade gracefully: a partial payload with
    `isStub=true` is still returned rather than a 5xx, so the frontend can
    fall back to its static stub.
    """
    if year < 1950 or year > 2050:
        # Ergast covers 1950+; a future-year guard prevents accidental
        # zero-result responses from typos.
        raise HTTPException(status_code=400, detail=f"year {year} out of supported range")
    try:
        return await to_thread.run_sync(partial(fetch_season, year))
    except Exception as e:  # pragma: no cover — defensive blanket
        logger.exception("season fetch failed for %d", year)
        raise HTTPException(status_code=502, detail=f"season fetch failed: {e}") from e


@router.get("/{year}/{round_}/results", response_model=RaceResultsPayload)
async def get_race_results(year: int, round_: int) -> RaceResultsPayload:
    """Top finishers for a single race. Empty `results` for races that
    haven't happened yet — the frontend decides how to render that."""
    if year < 1950 or year > 2050:
        raise HTTPException(status_code=400, detail=f"year {year} out of supported range")
    if round_ < 1 or round_ > 30:
        raise HTTPException(status_code=400, detail=f"round {round_} out of range")
    try:
        return await to_thread.run_sync(partial(fetch_race_results, year, round_))
    except Exception as e:  # pragma: no cover
        logger.exception("race results fetch failed for %d/%d", year, round_)
        raise HTTPException(status_code=502, detail=f"results fetch failed: {e}") from e


# Cache filename pattern from sessions.py: `{year}_{round:02d}_{TYPE}_{src}.json.gz`.
_CACHE_FILE_RE = re.compile(
    r"^(?P<year>\d{4})_(?P<round>\d{2})_(?P<type>[A-Z]+)_(?P<src>[a-z0-9]+)\.json\.gz$"
)


@router.get("/{year}/cached", response_model=dict[int, list[str]])
def list_cached_rounds(year: int) -> dict[int, list[str]]:
    """Map of `round → list[session_type]` for every blob persisted on disk
    for this year. The replay flow caches each (year, round, session_type)
    once and serves it from disk forever afterwards — past sessions are
    immutable. The frontend uses this to mark calendar rows as
    "downloaded" so users can tell at a glance which races (and which
    sessions of those races) won't need a network round-trip.

    Example response: `{12: ["R", "Q"], 13: ["R"]}` — round 12 has both
    race and qualifying cached, round 13 has just the race.
    """
    if year < 1950 or year > 2050:
        raise HTTPException(status_code=400, detail=f"year {year} out of supported range")
    out: dict[int, list[str]] = {}
    try:
        for entry in settings.racedata_cache_dir.iterdir():
            m = _CACHE_FILE_RE.match(entry.name)
            if not m:
                continue
            if int(m.group("year")) != year:
                continue
            round_no = int(m.group("round"))
            types = out.setdefault(round_no, [])
            t = m.group("type")
            if t not in types:
                types.append(t)
    except FileNotFoundError:
        # Cache dir was never created — nothing downloaded yet.
        return {}
    # Stable order per round so the UI doesn't reshuffle on refresh.
    for types in out.values():
        types.sort()
    return out
