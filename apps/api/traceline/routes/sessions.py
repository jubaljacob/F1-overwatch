import gzip
import logging
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from pathlib import Path

from anyio import to_thread
from fastapi import APIRouter, HTTPException, Query

from traceline.config import settings
from traceline.schemas.session import RaceData, SampleLap, SessionMeta
from traceline.services import fastf1_loader, openf1_loader
from traceline.services import race_data as race_data_service
from traceline.services.fastf1_loader import TelemetryFetchError
from traceline.services.openf1_client import OpenF1Error

logger = logging.getLogger(__name__)


def _racedata_cache_path(year: int, round_: int, session_type: str, source: str) -> Path:
    # Filename embeds every input the build is sensitive to. Source is
    # part of the key so flipping fastf1↔openf1 doesn't silently serve a
    # stale blob built by the other loader.
    name = f"{year}_{round_:02d}_{session_type.upper()}_{source.lower()}.json.gz"
    return settings.racedata_cache_dir / name


def _read_racedata_cache(path: Path) -> RaceData | None:
    if not path.exists():
        return None
    try:
        with gzip.open(path, "rb") as f:
            payload = f.read()
        return RaceData.model_validate_json(payload)
    except Exception as e:
        # A corrupt cache file shouldn't poison the route — log, delete,
        # and fall through to a fresh build.
        logger.warning("RaceData cache read failed for %s: %s", path.name, e)
        try:
            path.unlink(missing_ok=True)
        except Exception:
            pass
        return None


def _write_racedata_cache(path: Path, data: RaceData) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with gzip.open(tmp, "wb") as f:
            # exclude_none keeps the gzipped payload small — the schema
            # has many optional fields that are None for most sessions.
            f.write(data.model_dump_json(exclude_none=True).encode("utf-8"))
        tmp.replace(path)
    except Exception as e:
        logger.warning("RaceData cache write failed for %s: %s", path.name, e)
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass

router = APIRouter(prefix="/sessions", tags=["sessions"])

# FastF1 IO is blocking — run it on a worker thread so we don't stall the loop.
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="fastf1")


@router.get("/{year}/{round_}", response_model=SessionMeta)
async def get_session(
    year: int,
    round_: int,
    session_type: str = Query("R", description="R, Q, S, FP1, FP2, FP3"),
) -> SessionMeta:
    try:
        return await to_thread.run_sync(
            partial(fastf1_loader.get_session_meta, year, round_, session_type)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"FastF1 load failed: {e}") from e


@router.get("/{year}/{round_}/sample-lap", response_model=SampleLap)
async def get_sample_lap(
    year: int,
    round_: int,
    driver: str = Query(..., min_length=3, max_length=3, description="3-letter code, e.g. VER"),
    session_type: str = Query("R"),
) -> SampleLap:
    try:
        return await to_thread.run_sync(
            partial(fastf1_loader.get_sample_lap, year, round_, driver.upper(), session_type)
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"FastF1 load failed: {e}") from e


@router.get("/{year}/{round_}/race-data", response_model=RaceData, response_model_exclude_none=True)
async def get_race_data(
    year: int,
    round_: int,
    session_type: str = Query("R"),
) -> RaceData:
    """Full pre-computed replay payload. Slow on a cold cache (1-3 min)."""
    source = settings.data_source.lower()
    cache_path = _racedata_cache_path(year, round_, session_type, source)

    # Disk cache: gzipped JSON of the assembled RaceData. Reads in ~50 ms
    # versus 1–3 min for a cold rebuild. Keep the read off the event loop
    # because gzip + JSON parse is non-trivial (~1.5 MB compressed).
    cached = await to_thread.run_sync(partial(_read_racedata_cache, cache_path))
    if cached is not None:
        logger.info("RaceData cache hit: %s", cache_path.name)
        return cached

    # Pick the data source per env config. FastF1 has been blocked by F1's
    # CloudFront since mid-2026; OpenF1 is the working fallback. See
    # traceline/services/openf1_loader.py for scope notes (MVP — no telemetry).
    if source == "openf1":
        build = partial(openf1_loader.compute_race_data_openf1, year, round_, session_type)
    else:
        build = partial(race_data_service.compute_race_data, year, round_, session_type)

    try:
        result = await to_thread.run_sync(build)
        # Best-effort write — failures are logged but don't fail the
        # request, since the caller already has a valid payload in hand.
        await to_thread.run_sync(partial(_write_racedata_cache, cache_path, result))
        return result
    except TelemetryFetchError as e:
        logger.warning("Telemetry fetch failed for %s/%s/%s: %s", year, round_, session_type, e)
        raise HTTPException(status_code=503, detail=str(e)) from e
    except OpenF1Error as e:
        logger.warning("OpenF1 fetch failed for %s/%s/%s: %s", year, round_, session_type, e)
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        logger.exception("RaceData build failed for %s/%s/%s", year, round_, session_type)
        raise HTTPException(
            status_code=502, detail=f"RaceData build failed: {type(e).__name__}: {e}"
        ) from e
