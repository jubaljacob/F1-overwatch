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
    QualiSegment,
    RaceData,
    RaceDataMeta,
    TrackStatusEvent,
    WeatherSummary,
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
        # Weather + race-control come back small (few hundred rows each)
        # so we don't bother paginating. Wrapped in try so a 404/empty
        # response degrades to no-data rather than crashing the whole
        # session build — these are nice-to-haves, not load-bearing.
        try:
            weather_raw = client.weather(session_key)
        except Exception as e:
            logger.warning("OpenF1 weather fetch failed: %s", e)
            weather_raw = []
        try:
            race_control_raw = client.race_control(session_key)
        except Exception as e:
            logger.warning("OpenF1 race_control fetch failed: %s", e)
            race_control_raw = []

        # Telemetry: fetch per-driver to keep memory bounded. ~4 Hz native;
        # downstream resampling pulls it onto the 10 Hz grid alongside
        # location data. Drivers without car_data (e.g. retired before
        # any telemetry was recorded) silently skip.
        per_driver_car: dict[int, list[dict[str, Any]]] = {}
        for d in drivers_raw:
            num = int(d["driver_number"])
            try:
                samples = client.car_data(session_key, driver_number=num)
            except Exception as e:
                logger.warning("OpenF1 car_data fetch failed for driver %d: %s", num, e)
                continue
            if samples:
                per_driver_car[num] = samples

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
    centreline_xy, cum_dist, centreline_z = _build_centreline_from_location(
        per_driver_loc, laps_raw, t0
    )
    track_len_m = float(cum_dist[-1]) if len(cum_dist) else 0.0
    tree = cKDTree(centreline_xy) if len(centreline_xy) else None

    per_driver_arrs: dict[int, _DriverArrays] = {}
    for num, samples in per_driver_loc.items():
        try:
            arrs = _resample_driver_location(
                num, samples, times, t0, laps_raw, per_driver_car.get(num, [])
            )
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
    lap_records = _build_lap_records_openf1(
        laps_raw, stints_raw, session_type, t0, race_control_raw
    )
    race_end_t, classification = _extract_race_end_openf1(positions_raw, laps_raw, t0)
    weather = _extract_weather_openf1(weather_raw)
    track_status = _extract_track_status_openf1(race_control_raw, t0)

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
            weather=weather,
            track_status=track_status,
        ),
        drivers=drivers,
        circuit=CircuitGeometry(
            name=str(session_meta.get("circuit_short_name", "")),
            track_length_m=track_len_m,
            centreline=[(float(p[0]), float(p[1])) for p in centreline_xy],
            cumulative_distance=[float(d) for d in cum_dist],
            elevation=[float(v) for v in centreline_z],
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
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Pick the driver+lap with the shortest lap_duration; trace their
    position data through that lap as the centreline. Mirrors what FastF1's
    pick_fastest() trail gives the FastF1 path.

    Returns (xy [N,2], cum_dist [N], elevation [N]) — Z column is harvested
    from OpenF1's /location.z so the P6 3D viewer can extrude the ribbon
    with real elevation. Zeros when z is missing on every sample.
    """
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
        return np.empty((0, 2)), np.empty(0), np.empty(0)

    drv_num, _, start_s, end_s = best
    samples = per_driver_loc.get(drv_num)
    if not samples:
        return np.empty((0, 2)), np.empty(0), np.empty(0)

    pts: list[tuple[float, float, float]] = []
    for s in samples:
        ds = s.get("date")
        if not ds or s.get("x") is None or s.get("y") is None:
            continue
        try:
            t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        if start_s <= t <= end_s:
            pts.append((float(s["x"]), float(s["y"]), float(s.get("z") or 0.0)))
    if len(pts) < 2:
        return np.empty((0, 2)), np.empty(0), np.empty(0)

    arr = np.array(pts, dtype=float)
    xy = arr[:, :2]
    z = arr[:, 2]
    stride = max(1, len(xy) // CENTRELINE_TARGET_POINTS)
    xy = xy[::stride]
    z = z[::stride]
    if not np.allclose(xy[0], xy[-1]):
        xy = np.vstack([xy, xy[0]])
        z = np.concatenate([z, z[:1]])
    segs = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    cum = np.concatenate(([0.0], np.cumsum(segs)))
    return xy, cum, z


def _resample_driver_location(
    driver_number: int,
    samples: list[dict[str, Any]],
    times: np.ndarray,
    t0: datetime,
    laps_raw: list[dict[str, Any]],
    car_samples: list[dict[str, Any]],
) -> _DriverArrays | None:
    """Resample one driver's OpenF1 /location + /car_data onto the uniform
    10 Hz grid. Position uses linear interpolation; categorical fields
    (gear, drs) use last-known-value to avoid synthesising in-between
    states that never existed on the real car."""
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
    spd, gear, thr, brk, drs = _resample_car_data(car_samples, times, t0)

    return _DriverArrays(
        number=driver_number,
        t=times,
        x=x,
        y=y,
        z=z,
        spd=spd,
        gear=gear,
        thr=thr,
        brk=brk,
        drs=drs,
        lap=lap,
        status=status,
        d=np.zeros(len(times)),
    )


def _resample_car_data(
    samples: list[dict[str, Any]], times: np.ndarray, t0: datetime
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Resample OpenF1 /car_data onto `times`.

    Returns (spd, gear, thr, brk, drs). Empty input or all-bad rows yield
    arrays filled with zeros / False — the leaderboard's TelemetryStrip
    already hides itself when speed reads 0 and gear is None-ish, so a
    no-data driver degrades gracefully.

    OpenF1 fields used:
      speed         km/h
      n_gear        int (0-8)
      throttle      0-100
      brake         0 or 100 (binary on/off in current OpenF1 schema)
      drs           int code; >=10 = active (mirrors FastF1's convention)
    """
    n = len(times)
    if not samples:
        return (
            np.zeros(n),
            np.zeros(n, dtype=int),
            np.zeros(n),
            np.zeros(n),
            np.zeros(n, dtype=bool),
        )

    raw_t: list[float] = []
    raw_spd: list[float] = []
    raw_gear: list[int] = []
    raw_thr: list[float] = []
    raw_brk: list[float] = []
    raw_drs: list[int] = []
    for s in samples:
        ds = s.get("date")
        if not ds:
            continue
        try:
            t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        raw_t.append(t)
        raw_spd.append(float(s.get("speed") or 0.0))
        raw_gear.append(int(s.get("n_gear") or 0))
        raw_thr.append(float(s.get("throttle") or 0.0))
        raw_brk.append(float(s.get("brake") or 0.0))
        raw_drs.append(int(s.get("drs") or 0))
    if len(raw_t) < 2:
        return (
            np.zeros(n),
            np.zeros(n, dtype=int),
            np.zeros(n),
            np.zeros(n),
            np.zeros(n, dtype=bool),
        )

    arr_t = np.asarray(raw_t)
    order = np.argsort(arr_t)
    arr_t = arr_t[order]
    arr_spd = np.asarray(raw_spd)[order]
    arr_gear = np.asarray(raw_gear, dtype=int)[order]
    arr_thr = np.asarray(raw_thr)[order]
    arr_brk = np.asarray(raw_brk)[order]
    arr_drs = np.asarray(raw_drs, dtype=int)[order]

    # Continuous fields → linear interp; categorical fields → last-known.
    spd = np.interp(times, arr_t, arr_spd, left=0.0, right=0.0)
    thr = np.interp(times, arr_t, arr_thr, left=0.0, right=0.0)
    brk = np.interp(times, arr_t, arr_brk, left=0.0, right=0.0)

    idx = np.searchsorted(arr_t, times, side="right") - 1
    idx = np.clip(idx, 0, len(arr_t) - 1)
    gear = arr_gear[idx]
    drs_code = arr_drs[idx]
    # FastF1 uses DRS >= 10 as "active"; OpenF1 mirrors the same encoding
    # (codes 10, 12, 14 are open/active, lower values are armed/closed).
    drs = (drs_code >= 10).astype(bool)
    # Zero out telemetry preceding the first real sample so we don't show
    # a phantom 200 kph reading during the pre-race lead-in.
    pre_mask = times < arr_t[0]
    spd[pre_mask] = 0.0
    thr[pre_mask] = 0.0
    brk[pre_mask] = 0.0
    gear[pre_mask] = 0
    drs[pre_mask] = False

    return spd, gear, thr, brk, drs


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


# --- weather, track status, quali, telemetry ------------------------------


def _extract_weather_openf1(rows: list[dict[str, Any]]) -> WeatherSummary | None:
    """Reduce OpenF1 /weather samples to a single header summary.

    OpenF1 emits one row per ~1 minute with absolute values for each
    metric. Mean across the session is the right summary for the chip;
    rainfall is any-true because a single wet sample is enough context
    to flag the day as rain.
    """
    if not rows:
        return None

    def _mean(key: str) -> float | None:
        vals: list[float] = []
        for r in rows:
            v = r.get(key)
            if v is None:
                continue
            try:
                vals.append(float(v))
            except (TypeError, ValueError):
                continue
        if not vals:
            return None
        return round(sum(vals) / len(vals), 1)

    rainfall = False
    for r in rows:
        v = r.get("rainfall")
        if v is None:
            continue
        try:
            # OpenF1 reports rainfall as 0/1 (sometimes bool); both coerce.
            if int(v) > 0:
                rainfall = True
                break
        except (TypeError, ValueError):
            continue

    return WeatherSummary(
        air_temp_c=_mean("air_temperature"),
        track_temp_c=_mean("track_temperature"),
        humidity_pct=_mean("humidity"),
        rainfall=rainfall,
        wind_speed_kph=_mean("wind_speed"),
    )


def _extract_track_status_openf1(
    rows: list[dict[str, Any]], t0: datetime
) -> list[TrackStatusEvent]:
    """Reduce OpenF1 /race_control to a (t, status) timeline.

    Walks rows in chronological order and maintains five concurrent flags
    (red, sc, vsc, yellow-sectors, manually-cleared-after-red). Emits a
    new TrackStatusEvent whenever the priority-resolved status changes.
    Priority: red > sc > vsc > yellow > green — matches what an FIA
    race-director signal would show on a single status board.
    """
    if not rows:
        return []

    parsed: list[tuple[float, dict[str, Any]]] = []
    for r in rows:
        ds = r.get("date")
        if not ds:
            continue
        try:
            t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        parsed.append((t, r))
    if not parsed:
        return []
    parsed.sort(key=lambda x: x[0])

    red = False
    sc = False
    vsc = False
    yellow_sectors: set[int | str] = set()

    out: list[TrackStatusEvent] = []
    last_status: str | None = None

    def _resolve() -> str:
        if red:
            return "red"
        if sc:
            return "sc"
        if vsc:
            return "vsc"
        if yellow_sectors:
            return "yellow"
        return "green"

    def _emit(at: float) -> None:
        nonlocal last_status
        status = _resolve()
        if status == last_status:
            return
        out.append(TrackStatusEvent(t=at, status=status))  # type: ignore[arg-type]
        last_status = status

    for t, r in parsed:
        category = str(r.get("category") or "").strip()
        flag = str(r.get("flag") or "").upper().strip()
        scope = str(r.get("scope") or "").strip()
        message = str(r.get("message") or "").upper()
        sector = r.get("sector")

        if category == "Flag":
            if flag == "RED":
                red = True
            elif flag == "GREEN":
                # Green flag clears red and any yellows. Track-scope green
                # signals the restart of a stopped session.
                red = False
                if scope == "Track":
                    yellow_sectors.clear()
            elif flag in ("YELLOW", "DOUBLE YELLOW"):
                key = sector if sector is not None else scope or flag
                yellow_sectors.add(key)
            elif flag == "CLEAR":
                # Sector-scope clear removes that one sector's yellow.
                if sector is not None:
                    yellow_sectors.discard(sector)
                else:
                    # Generic clear without a sector clears all yellows.
                    yellow_sectors.clear()
            elif flag == "CHEQUERED":
                # End of session — emit a final green so the banner doesn't
                # stick on whatever flag was last active.
                red = False
                sc = False
                vsc = False
                yellow_sectors.clear()
        elif category == "SafetyCar":
            if "DEPLOYED" in message or "STANDING" in message:
                sc = True
                vsc = False  # SC supersedes VSC if both flagged simultaneously
            elif "IN THIS LAP" in message or "ENDING" in message:
                sc = False
        elif category == "Other":
            # VSC events come through with category="Other".
            if "VIRTUAL SAFETY CAR DEPLOYED" in message:
                vsc = True
            elif "VIRTUAL SAFETY CAR ENDING" in message:
                vsc = False
        _emit(t)

    return out


def _build_lap_records_openf1(
    laps_raw: list[dict[str, Any]],
    stints_raw: list[dict[str, Any]],
    session_type: str,
    t0: datetime,
    race_control_raw: list[dict[str, Any]] | None = None,
) -> list:
    """Override of the original — adds quali_segment classification."""
    from traceline.schemas.session import LapRecord

    stints_by_driver = _stints_by_driver(stints_raw)
    # Prefer race-control chequered flags as the authoritative Q1/Q2/Q3
    # boundaries; the lap-gap heuristic is only a fallback when race
    # control data is missing or sparse.
    boundaries = _quali_segment_boundaries_from_race_control(
        race_control_raw or [], session_type, t0
    )
    if len(boundaries) >= 2:
        quali_segments = _classify_quali_segments_by_boundaries(
            laps_raw, session_type, t0, boundaries
        )
    else:
        quali_segments = _classify_quali_segments_openf1(laps_raw, session_type, t0)

    out: list[LapRecord] = []
    for idx, lap in enumerate(laps_raw):
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
                quali_segment=quali_segments.get(idx),
            )
        )
    return out


# Minimum break length to be considered an inter-segment break. Used as
# a safety floor so we don't promote a tiny within-segment gap into a
# break just because it happens to be the third-largest. Real Q1→Q2
# breaks are 7+ min, Q2→Q3 8+ min — 3 min is far below either.
_MIN_QUALI_BREAK_S = 180.0


def _quali_segment_boundaries_from_race_control(
    race_control_raw: list[dict[str, Any]],
    session_type: str,
    t0: datetime,
) -> list[float]:
    """Pull Q1/Q2 end timestamps from race-control chequered flags.

    In a quali session race-control emits three CHEQUERED FLAG events —
    one ending Q1, one ending Q2, one ending Q3. The first two are the
    inter-segment boundaries; the third is the session end. We return
    boundaries sorted ascending in seconds-from-t0. Empty list if the
    feed is missing or the session isn't qualifying.
    """
    if session_type.upper() not in ("Q", "SQ"):
        return []
    chequered: list[float] = []
    for row in race_control_raw:
        flag = str(row.get("flag") or "").upper()
        category = str(row.get("category") or "").lower()
        if flag != "CHEQUERED" and "chequered" not in category:
            # Some feeds use category="Flag" + flag="CHEQUERED", others
            # leave flag blank and embed the word in the message.
            msg = str(row.get("message") or "").upper()
            if "CHEQUERED" not in msg:
                continue
        ds = row.get("date")
        if not ds:
            continue
        try:
            chequered.append((_parse_iso(ds) - t0).total_seconds())
        except ValueError:
            continue
    chequered.sort()
    # Q3's chequered is the session end — drop it. Two boundaries are
    # enough to bucket Q1/Q2/Q3.
    return chequered[:2]


def _classify_quali_segments_by_boundaries(
    laps_raw: list[dict[str, Any]],
    session_type: str,
    t0: datetime,
    boundaries: list[float],
) -> dict[int, QualiSegment]:
    """Bucket each lap by its date_start against the two boundaries.

    lap_start < boundaries[0]  → Q1
    lap_start < boundaries[1]  → Q2
    lap_start ≥ boundaries[1]  → Q3
    """
    if session_type.upper() not in ("Q", "SQ") or len(boundaries) < 2:
        return {}
    out: dict[int, QualiSegment] = {}
    b1, b2 = boundaries[0], boundaries[1]
    for idx, lap in enumerate(laps_raw):
        ds = lap.get("date_start")
        if not ds:
            continue
        try:
            t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        if t < b1:
            out[idx] = "Q1"
        elif t < b2:
            out[idx] = "Q2"
        else:
            out[idx] = "Q3"
    return out


def _classify_quali_segments_openf1(
    laps_raw: list[dict[str, Any]], session_type: str, t0: datetime
) -> dict[int, QualiSegment]:
    """Assign each lap to Q1 / Q2 / Q3 by finding the two largest gaps in
    the sorted lap-start timeline. Using "top-2 biggest gaps" instead of
    "any gap > N minutes" is robust to within-segment lulls that would
    otherwise split a single segment into two and push drivers into a
    higher segment than they actually ran in.
    """
    if session_type.upper() not in ("Q", "SQ"):
        return {}

    indexed: list[tuple[int, float]] = []
    for idx, lap in enumerate(laps_raw):
        ds = lap.get("date_start")
        if not ds:
            continue
        try:
            t = (_parse_iso(ds) - t0).total_seconds()
        except ValueError:
            continue
        indexed.append((idx, t))
    if not indexed:
        return {}

    indexed.sort(key=lambda x: x[1])
    starts = [t for _, t in indexed]
    if len(starts) < 2:
        return {orig_idx: "Q1" for orig_idx, _ in indexed}

    # Build (gap_size, position_after) tuples. position_after is the
    # index of the first lap in the next segment if this gap is treated
    # as a break.
    gaps = [(starts[i + 1] - starts[i], i + 1) for i in range(len(starts) - 1)]
    # Sort descending by size, then take the two largest that exceed the
    # safety floor. If only one exceeds the floor, treat the session as
    # having only two segments (some FP/SQ formats genuinely do).
    big_gaps = sorted(
        (g for g in gaps if g[0] >= _MIN_QUALI_BREAK_S),
        key=lambda g: g[0],
        reverse=True,
    )[:2]
    # Sort the selected breaks chronologically so cursor walks forward.
    big_gaps.sort(key=lambda g: g[1])

    seg_for_position: list[str] = ["Q1"] * len(indexed)
    for current, (_, cursor) in enumerate(big_gaps, start=1):
        label = ("Q1", "Q2", "Q3")[min(current, 2)]
        for i in range(cursor, len(seg_for_position)):
            seg_for_position[i] = label

    out: dict[int, QualiSegment] = {}
    for pos, (orig_idx, _) in enumerate(indexed):
        label = seg_for_position[pos]
        if label in ("Q1", "Q2", "Q3"):
            out[orig_idx] = label  # type: ignore[assignment]
    return out
