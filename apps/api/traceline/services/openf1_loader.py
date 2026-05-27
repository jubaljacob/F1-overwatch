"""Build a RaceData blob from OpenF1 instead of FastF1.

This is the fallback data path while F1's livetiming CDN blocks FastF1's IP
range. The output schema is identical to the FastF1 path so the rest of the
pipeline (frontend, validation harness, leaderboard) needs no changes.

Scope is intentionally minimal in the MVP:

- Positions (x, y) come from OpenF1 `/location` at ~3.7 Hz; we resample to the
  same 10 Hz grid the FastF1 path uses.
- Telemetry (speed, throttle, brake, gear, drs) is *not* fetched. OpenF1's
  `/car_data` payload is huge and we don't need it for the leaderboard or the
  track renderer. Fields default to 0 / None and will be lit up in a later
  pass if needed.
- Pit-in / pit-out comes from `/pit` (preferred) with `/laps` as a fallback.
- Final classification comes from `/position` (last row per driver).

Everything that already works (segment projection, pit-cycle freeze, race-end
override) is reused via the shared helpers in race_data.py.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import datetime
from typing import Any

import numpy as np
from scipy.spatial import cKDTree

from traceline.schemas.session import (
    CircuitGeometry,
    DriverInfo,
    RaceData,
    RaceDataMeta,
)
from traceline.services.openf1_client import OpenF1Client, resolve_session_key
from traceline.services.race_data import (
    CENTRELINE_TARGET_POINTS,
    FRAME_DT,
    FRAME_HZ,
    PRE_RACE_LEAD_IN_S,
    _apply_pit_freeze,
    _assemble_frames,
    _DriverArrays,
    _project_to_centreline,
)

logger = logging.getLogger(__name__)


def compute_race_data_openf1(year: int, round_: int, session_type: str = "R") -> RaceData:
    session_name = _map_session_type(session_type)
    with OpenF1Client() as client:
        session_key, session_meta = resolve_session_key(client, year, round_, session_name)
        logger.info(
            "OpenF1 session_key=%d (%s)", session_key, session_meta.get("session_name")
        )

        drivers_raw = client.drivers(session_key)
        drivers = [_to_driver_info(d) for d in drivers_raw]

        # Pulling location per-driver bounds peak memory and lets us bail
        # cleanly on drivers with no data instead of one giant array.
        per_driver_loc: dict[int, list[dict[str, Any]]] = {}
        for d in drivers_raw:
            num = int(d["driver_number"])
            samples = client.location(session_key, driver_number=num)
            if samples:
                per_driver_loc[num] = samples

        laps_raw = client.laps(session_key)
        positions_raw = client.position(session_key)
        stints_raw = client.stints(session_key)

    # Resolve a reference timestamp (race start) so we can convert OpenF1's
    # absolute ISO timestamps into seconds-from-zero, matching FastF1.
    t0 = _race_start_iso(session_meta, laps_raw)
    if t0 is None:
        raise RuntimeError("OpenF1 session missing both date_start and lap timestamps")

    # Time bounds: from the earliest location sample to the latest. Then trim
    # the front so the replay starts 8 minutes before lap 1 (matches the
    # FastF1 path; see PRE_RACE_LEAD_IN_S).
    raw_t_start, raw_t_end = _location_time_bounds(per_driver_loc, t0)
    race_start = _race_start_seconds(laps_raw, t0)
    t_start = raw_t_start
    if race_start is not None:
        t_start = max(raw_t_start, race_start - PRE_RACE_LEAD_IN_S)
    times = np.arange(t_start, raw_t_end + FRAME_DT, FRAME_DT)

    # Centreline: derive from the fastest individual lap's position trail.
    centreline_xy, cum_dist = _build_centreline_from_location(per_driver_loc, laps_raw, t0)
    track_len_m = float(cum_dist[-1]) if len(cum_dist) else 0.0
    tree = cKDTree(centreline_xy) if len(centreline_xy) else None

    per_driver_arrs: dict[int, _DriverArrays] = {}
    for num, samples in per_driver_loc.items():
        try:
            arrs = _resample_driver_location(num, samples, times, t0, laps_raw)
        except Exception as e:  # pragma: no cover — defensive on malformed rows
            logger.warning("OpenF1: skipping driver %d: %s", num, e)
            continue
        if arrs is None:
            continue
        arrs["d"] = _project_to_centreline(
            arrs["x"], arrs["y"], tree, cum_dist, track_len_m, centreline=centreline_xy
        )
        arrs["d"], arrs["lap"] = _apply_pit_freeze(
            arrs["d"], arrs["lap"], arrs["status"], track_len_m
        )
        per_driver_arrs[num] = arrs

    frames = _assemble_frames(times, per_driver_arrs)
    lap_records = _build_lap_records_openf1(laps_raw, stints_raw)
    race_end_t, classification = _extract_race_end_openf1(positions_raw, laps_raw, t0)

    return RaceData(
        meta=RaceDataMeta(
            year=year,
            round=round_,
            circuit=str(session_meta.get("circuit_short_name") or session_meta.get("location", "")),
            session_type=session_type,
            total_laps=_total_laps_from_laps(laps_raw),
            frame_hz=FRAME_HZ,
            t_start=float(t_start),
            t_end=float(raw_t_end),
            race_end_t=race_end_t,
            final_classification=classification,
            race_start_t=race_start,
        ),
        drivers=drivers,
        circuit=CircuitGeometry(
            name=str(session_meta.get("circuit_short_name", "")),
            track_length_m=track_len_m,
            centreline=[(float(p[0]), float(p[1])) for p in centreline_xy],
            cumulative_distance=[float(d) for d in cum_dist],
        ),
        frames=frames,
        laps=lap_records,
    )


# --- helpers ---------------------------------------------------------------


_SESSION_TYPE_MAP = {
    "R": "Race",
    "Q": "Qualifying",
    "S": "Sprint",
    "SS": "Sprint Shootout",
    "FP1": "Practice 1",
    "FP2": "Practice 2",
    "FP3": "Practice 3",
}


def _map_session_type(session_type: str) -> str:
    return _SESSION_TYPE_MAP.get(session_type.upper(), session_type)


def _parse_iso(ts: str) -> datetime:
    # OpenF1 emits "2024-07-21T13:00:00+00:00" (zoned). datetime.fromisoformat
    # handles that natively on 3.11+.
    return datetime.fromisoformat(ts)


def _race_start_iso(
    session_meta: dict[str, Any], laps_raw: Iterable[dict[str, Any]]
) -> datetime | None:
    """Pick a reference timestamp for "session-time = 0".

    Prefers the session's own date_start so we line up with FastF1's
    convention; falls back to the earliest lap_1 date_start if missing.
    """
    if ds := session_meta.get("date_start"):
        try:
            return _parse_iso(ds)
        except ValueError:
            pass
    for lap in laps_raw:
        if lap.get("lap_number") == 1 and (ds := lap.get("date_start")):
            try:
                return _parse_iso(ds)
            except ValueError:
                continue
    return None


def _race_start_seconds(laps_raw: Iterable[dict[str, Any]], t0: datetime) -> float | None:
    earliest: float | None = None
    for lap in laps_raw:
        if lap.get("lap_number") != 1:
            continue
        ds = lap.get("date_start")
        if not ds:
            continue
        try:
            t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        if earliest is None or t < earliest:
            earliest = t
    return earliest


def _location_time_bounds(
    per_driver_loc: dict[int, list[dict[str, Any]]], t0: datetime
) -> tuple[float, float]:
    starts: list[float] = []
    ends: list[float] = []
    for samples in per_driver_loc.values():
        if not samples:
            continue
        try:
            ts = [(_parse_iso(s["date"]) - t0).total_seconds() for s in samples if "date" in s]
        except ValueError:
            continue
        if ts:
            starts.append(min(ts))
            ends.append(max(ts))
    if not starts:
        return 0.0, 0.0
    return min(starts), max(ends)


def _to_driver_info(d: dict[str, Any]) -> DriverInfo:
    return DriverInfo(
        number=int(d["driver_number"]),
        code=str(d.get("name_acronym") or "")[:3].upper(),
        full_name=str(d.get("full_name") or d.get("broadcast_name") or ""),
        team=str(d.get("team_name") or ""),
        team_colour=_normalise_colour(d.get("team_colour")),
    )


def _normalise_colour(value: object) -> str | None:
    if not value:
        return None
    s = str(value).lstrip("#")
    return s if len(s) == 6 else None


def _build_centreline_from_location(
    per_driver_loc: dict[int, list[dict[str, Any]]],
    laps_raw: list[dict[str, Any]],
    t0: datetime,
) -> tuple[np.ndarray, np.ndarray]:
    """Pick the driver+lap with the shortest lap_duration; trace their
    position data through that lap as the centreline. Mirrors what FastF1's
    pick_fastest() trail gives the FastF1 path."""
    # Find fastest (driver_number, lap_number, start, end).
    best: tuple[int, int, float, float] | None = None
    for lap in laps_raw:
        dur = lap.get("lap_duration")
        ds = lap.get("date_start")
        num = lap.get("driver_number")
        ln = lap.get("lap_number")
        if dur is None or not ds or num is None or ln is None:
            continue
        try:
            start_s = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        end_s = start_s + float(dur)
        if best is None or dur < best[3] - best[2]:
            best = (int(num), int(ln), start_s, end_s)

    if best is None:
        return np.empty((0, 2)), np.empty(0)

    drv_num, _, start_s, end_s = best
    samples = per_driver_loc.get(drv_num)
    if not samples:
        return np.empty((0, 2)), np.empty(0)

    pts: list[tuple[float, float]] = []
    for s in samples:
        ds = s.get("date")
        if not ds or s.get("x") is None or s.get("y") is None:
            continue
        try:
            t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        if start_s <= t <= end_s:
            pts.append((float(s["x"]), float(s["y"])))
    if len(pts) < 2:
        return np.empty((0, 2)), np.empty(0)

    xy = np.array(pts, dtype=float)
    stride = max(1, len(xy) // CENTRELINE_TARGET_POINTS)
    xy = xy[::stride]
    if not np.allclose(xy[0], xy[-1]):
        xy = np.vstack([xy, xy[0]])
    segs = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    cum = np.concatenate(([0.0], np.cumsum(segs)))
    return xy, cum


def _resample_driver_location(
    driver_number: int,
    samples: list[dict[str, Any]],
    times: np.ndarray,
    t0: datetime,
    laps_raw: list[dict[str, Any]],
) -> _DriverArrays | None:
    """Resample one driver's OpenF1 /location into the uniform 10 Hz grid."""
    raw_t: list[float] = []
    raw_x: list[float] = []
    raw_y: list[float] = []
    raw_z: list[float] = []
    for s in samples:
        ds = s.get("date")
        if not ds or s.get("x") is None or s.get("y") is None:
            continue
        try:
            t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        raw_t.append(t)
        raw_x.append(float(s["x"]))
        raw_y.append(float(s["y"]))
        raw_z.append(float(s.get("z") or 0.0))
    if len(raw_t) < 2:
        return None

    src_t = np.asarray(raw_t)
    order = np.argsort(src_t)
    src_t = src_t[order]
    src_x = np.asarray(raw_x)[order]
    src_y = np.asarray(raw_y)[order]
    src_z = np.asarray(raw_z)[order]

    x = np.interp(times, src_t, src_x, left=np.nan, right=np.nan)
    y = np.interp(times, src_t, src_y, left=np.nan, right=np.nan)
    z = np.interp(times, src_t, src_z, left=np.nan, right=np.nan)

    lap = _lap_index_for_driver(driver_number, laps_raw, times, t0)
    status = _status_for_driver(driver_number, laps_raw, times, t0)

    n = len(times)
    return _DriverArrays(
        number=driver_number,
        t=times,
        x=x,
        y=y,
        z=z,
        spd=np.zeros(n),  # MVP: telemetry not fetched
        gear=np.zeros(n, dtype=int),
        thr=np.zeros(n),
        brk=np.zeros(n),
        drs=np.zeros(n, dtype=bool),
        lap=lap,
        status=status,
        d=np.zeros(n),
    )


def _lap_index_for_driver(
    driver_number: int,
    laps_raw: list[dict[str, Any]],
    times: np.ndarray,
    t0: datetime,
) -> np.ndarray:
    starts: list[float] = []
    nums: list[int] = []
    for lap in laps_raw:
        if lap.get("driver_number") != driver_number:
            continue
        ds = lap.get("date_start")
        ln = lap.get("lap_number")
        if not ds or ln is None:
            continue
        try:
            t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        starts.append(t)
        nums.append(int(ln))
    if not starts:
        return np.ones_like(times, dtype=int)
    arr_t = np.asarray(starts)
    arr_n = np.asarray(nums, dtype=int)
    order = np.argsort(arr_t)
    arr_t = arr_t[order]
    arr_n = arr_n[order]
    idx = np.searchsorted(arr_t, times, side="right") - 1
    idx = np.clip(idx, 0, len(arr_n) - 1)
    out = arr_n[idx]
    out[times < arr_t[0]] = arr_n[0]
    return out


def _status_for_driver(
    driver_number: int,
    laps_raw: list[dict[str, Any]],
    times: np.ndarray,
    t0: datetime,
) -> np.ndarray:
    """Approximate the in-pit window from OpenF1 lap fields.

    OpenF1 laps expose `pit_in_time` / `pit_out_time` as seconds-since-lap-start
    rather than absolute timestamps. We convert by adding to the lap's
    `date_start`. Missing values fall back to a 25s default window so the
    pit-freeze step still triggers.
    """
    status = np.zeros_like(times, dtype=int)
    pit_windows: list[tuple[float, float]] = []
    for lap in laps_raw:
        if lap.get("driver_number") != driver_number:
            continue
        ds = lap.get("date_start")
        if not ds:
            continue
        try:
            lap_t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        pit_in = lap.get("pit_in_time")
        pit_out = lap.get("pit_out_time")
        if pit_in is None and pit_out is None:
            continue
        in_s = lap_t + float(pit_in) if pit_in is not None else lap_t
        out_s = (
            lap_t + float(pit_out)
            if pit_out is not None and pit_out > (pit_in or 0)
            else in_s + 25.0
        )
        pit_windows.append((in_s, out_s))

    for in_s, out_s in pit_windows:
        mask = (times >= in_s) & (times <= out_s)
        status[mask] = 1
    return status


def _build_lap_records_openf1(
    laps_raw: list[dict[str, Any]], stints_raw: list[dict[str, Any]]
) -> list:
    from traceline.schemas.session import LapRecord

    # Index stints by driver so per-lap lookup is O(stints-per-driver) instead
    # of O(total stints). Sorted by lap_start so the linear scan in
    # _stint_for_lap can short-circuit.
    stints_by_driver = _stints_by_driver(stints_raw)

    out: list[LapRecord] = []
    for lap in laps_raw:
        try:
            drv = int(lap["driver_number"])
            ln = int(lap["lap_number"])
        except (KeyError, ValueError, TypeError):
            continue

        compound, tyre_age = _compound_and_age_for_lap(stints_by_driver.get(drv, []), ln)

        out.append(
            LapRecord(
                driver=drv,
                lap=ln,
                lap_time_s=_float_or_none(lap.get("lap_duration")),
                sector_1_s=_float_or_none(lap.get("duration_sector_1")),
                sector_2_s=_float_or_none(lap.get("duration_sector_2")),
                sector_3_s=_float_or_none(lap.get("duration_sector_3")),
                compound=compound,
                tyre_age=tyre_age,
                pit_in=lap.get("pit_in_time") is not None,
                pit_out=lap.get("pit_out_time") is not None,
            )
        )
    return out


def _stints_by_driver(
    stints_raw: list[dict[str, Any]],
) -> dict[int, list[dict[str, Any]]]:
    out: dict[int, list[dict[str, Any]]] = {}
    for s in stints_raw:
        try:
            drv = int(s["driver_number"])
        except (KeyError, ValueError, TypeError):
            continue
        out.setdefault(drv, []).append(s)
    for arr in out.values():
        arr.sort(key=lambda s: s.get("lap_start") or 0)
    return out


def _compound_and_age_for_lap(
    driver_stints: list[dict[str, Any]], lap_number: int
) -> tuple[str | None, int | None]:
    """Find the stint covering `lap_number` and return its compound +
    accumulated tyre age. Age is 1-indexed at the *end* of the lap to
    match FastF1's TyreLife convention and F1 broadcast usage ("5 laps
    on those mediums" = age 5 on the fifth lap of the stint).
    Returns (None, None) if no stint matches (e.g., driver retired before
    stint metadata stabilised).
    """
    for stint in driver_stints:
        lap_start = stint.get("lap_start")
        lap_end = stint.get("lap_end")
        if lap_start is None or lap_end is None:
            continue
        try:
            ls = int(lap_start)
            le = int(lap_end)
        except (TypeError, ValueError):
            continue
        if ls <= lap_number <= le:
            compound_raw = stint.get("compound")
            compound = str(compound_raw).upper() if compound_raw else None
            age_at_start = stint.get("tyre_age_at_start")
            try:
                base_age = int(age_at_start) if age_at_start is not None else 0
            except (TypeError, ValueError):
                base_age = 0
            return compound, base_age + (lap_number - ls) + 1
    return None, None


def _extract_race_end_openf1(
    positions_raw: list[dict[str, Any]],
    laps_raw: list[dict[str, Any]],
    t0: datetime,
) -> tuple[float | None, dict[int, int] | None]:
    if not positions_raw:
        return None, None
    # Latest row per driver wins — that's the final classified position.
    final: dict[int, tuple[datetime, int]] = {}
    for row in positions_raw:
        num = row.get("driver_number")
        pos = row.get("position")
        date = row.get("date")
        if num is None or pos is None or not date:
            continue
        try:
            ts = _parse_iso(date)
        except ValueError:
            continue
        current = final.get(int(num))
        if current is None or ts > current[0]:
            final[int(num)] = (ts, int(pos))
    if not final:
        return None, None
    classification = {num: pos for num, (_, pos) in final.items()}

    # Chequered flag = winner's max-lap_number date_start + lap_duration.
    winner = next((n for n, p in classification.items() if p == 1), None)
    if winner is None:
        return None, classification
    winner_laps = [lap for lap in laps_raw if lap.get("driver_number") == winner]
    if not winner_laps:
        return None, classification
    # The lap whose lap_number is maximum and has a duration is the final one.
    last_lap = max(
        (lap for lap in winner_laps if lap.get("lap_duration") is not None),
        key=lambda lap: lap.get("lap_number", 0),
        default=None,
    )
    if last_lap is None or not last_lap.get("date_start"):
        return None, classification
    try:
        start = (_parse_iso(last_lap["date_start"]) - t0).total_seconds()
    except ValueError:
        return None, classification
    return float(start + float(last_lap["lap_duration"])), classification


def _total_laps_from_laps(laps_raw: list[dict[str, Any]]) -> int:
    best = 0
    for lap in laps_raw:
        ln = lap.get("lap_number")
        if isinstance(ln, int) and ln > best:
            best = ln
    return best


def _float_or_none(v: object) -> float | None:
    if v is None:
        return None
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
