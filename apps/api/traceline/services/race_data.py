"""Build a `RaceData` blob from a FastF1 session.

This is the P1 pre-computation pipeline. Heavy and slow on a cold FastF1 cache
(1-3 min for a race); the route handler must offload to a worker thread.

The lap-distance computation here is the *P1 baseline*: project each (x, y)
sample onto the nearest centreline vertex. P2 will replace this with a
calibrated centreline + segment projection (see PROJECT_PLAN §5 P2).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from traceline.schemas.session import (
    CircuitGeometry,
    DriverSample,
    Frame,
    LapRecord,
    RaceData,
    RaceDataMeta,
)
from traceline.services import fastf1_loader

logger = logging.getLogger(__name__)

FRAME_HZ = 10.0
FRAME_DT = 1.0 / FRAME_HZ
# Downsample the centreline to keep RaceData payloads small; ~3m spacing on a
# 5km track gives ~1700 points, plenty for a P1 renderer.
CENTRELINE_TARGET_POINTS = 1500


def compute_race_data(year: int, round_: int, session_type: str = "R") -> RaceData:
    session = fastf1_loader.load_session(year, round_, session_type, with_telemetry=True)
    drivers = fastf1_loader.get_session_meta(year, round_, session_type).drivers

    centreline_xy, cum_dist = _build_centreline(session)
    track_len_m = float(cum_dist[-1]) if len(cum_dist) else 0.0
    tree = cKDTree(centreline_xy) if len(centreline_xy) else None

    t_start, t_end = _session_time_bounds(session)
    times = np.arange(t_start, t_end + FRAME_DT, FRAME_DT)

    per_driver = {}
    for drv in session.drivers:
        try:
            arrs = _resample_driver(session, drv, times)
        except Exception as e:  # pragma: no cover — defensive against FastF1 quirks
            logger.warning("Skipping driver %s: %s", drv, e)
            continue
        if arrs is None:
            continue
        arrs["d"] = _project_to_centreline(arrs["x"], arrs["y"], tree, cum_dist, track_len_m)
        per_driver[int(arrs["number"])] = arrs

    frames = _assemble_frames(times, per_driver)
    laps = _build_lap_records(session)

    return RaceData(
        meta=RaceDataMeta(
            year=year,
            round=round_,
            circuit=str(session.event.get("EventName", "")),
            session_type=session_type,
            total_laps=int(session.total_laps) if session.total_laps else 0,
            frame_hz=FRAME_HZ,
            t_start=float(t_start),
            t_end=float(t_end),
        ),
        drivers=drivers,
        circuit=CircuitGeometry(
            name=str(session.event.get("EventName", "")),
            track_length_m=track_len_m,
            centreline=[(float(p[0]), float(p[1])) for p in centreline_xy],
            cumulative_distance=[float(d) for d in cum_dist],
        ),
        frames=frames,
        laps=laps,
    )


# --- centreline ------------------------------------------------------------


def _build_centreline(session) -> tuple[np.ndarray, np.ndarray]:
    """Use the session's overall fastest lap position trail as the centreline.

    Good enough for P1 leaderboarding; P2 swaps in a calibrated centreline.
    """
    try:
        fastest = session.laps.pick_fastest()
        pos = fastest.get_pos_data()
    except Exception as e:
        logger.warning("Centreline fallback (no fastest lap pos): %s", e)
        return np.empty((0, 2)), np.empty(0)

    xy = pos[["X", "Y"]].to_numpy(dtype=float)
    xy = xy[~np.isnan(xy).any(axis=1)]
    if len(xy) < 2:
        return np.empty((0, 2)), np.empty(0)

    # Downsample by stride so very dense laps don't blow up the payload.
    stride = max(1, len(xy) // CENTRELINE_TARGET_POINTS)
    xy = xy[::stride]

    # Close the loop so the projection wraps cleanly across the start/finish.
    if not np.allclose(xy[0], xy[-1]):
        xy = np.vstack([xy, xy[0]])

    segs = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    cum = np.concatenate(([0.0], np.cumsum(segs)))
    return xy, cum


# --- resampling ------------------------------------------------------------


@dataclass
class _DriverArrays:
    number: int
    t: np.ndarray
    x: np.ndarray
    y: np.ndarray
    z: np.ndarray
    spd: np.ndarray
    gear: np.ndarray
    thr: np.ndarray
    brk: np.ndarray
    drs: np.ndarray
    lap: np.ndarray
    status: np.ndarray  # 0=on_track, 1=pit, 2=out
    d: np.ndarray  # filled in by projection step

    def __getitem__(self, k: str):
        return getattr(self, k)

    def __setitem__(self, k: str, v):
        setattr(self, k, v)


def _resample_driver(session, drv: str, times: np.ndarray) -> _DriverArrays | None:
    try:
        pos = session.pos_data[drv]
        car = session.car_data[drv]
    except KeyError:
        return None

    pos_t = pos["SessionTime"].dt.total_seconds().to_numpy(dtype=float)
    car_t = car["SessionTime"].dt.total_seconds().to_numpy(dtype=float)
    if len(pos_t) < 2 or len(car_t) < 2:
        return None

    def lin(src_t, src_v):
        return np.interp(times, src_t, src_v, left=np.nan, right=np.nan)

    def cat(src_t, src_v):
        # Last-known-value: for each target time, find the largest src_t <= t.
        idx = np.searchsorted(src_t, times, side="right") - 1
        idx = np.clip(idx, 0, len(src_v) - 1)
        out = np.asarray(src_v)[idx]
        out[times < src_t[0]] = src_v[0] if len(src_v) else 0
        return out

    x = lin(pos_t, pos["X"].to_numpy(dtype=float))
    y = lin(pos_t, pos["Y"].to_numpy(dtype=float))
    z = (
        lin(pos_t, pos["Z"].to_numpy(dtype=float))
        if "Z" in pos.columns
        else np.full_like(times, np.nan)
    )
    spd = lin(car_t, car["Speed"].to_numpy(dtype=float))
    gear = cat(car_t, car["nGear"].to_numpy(dtype=int))
    thr = lin(car_t, car["Throttle"].to_numpy(dtype=float))
    brk = lin(car_t, car["Brake"].to_numpy(dtype=float))
    # DRS in FastF1 is an int code; >=10 means active.
    drs_raw = car["DRS"].to_numpy(dtype=int)
    drs_active = (drs_raw >= 10).astype(int)
    drs = cat(car_t, drs_active).astype(bool)

    lap = _lap_index_for_times(session, drv, times)
    status = _status_for_times(session, drv, pos, times)

    driver_number = _driver_number(session, drv)

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
        d=np.zeros_like(times),
    )


def _driver_number(session, drv: str) -> int:
    try:
        return int(drv)
    except ValueError:
        info = session.get_driver(drv)
        return int(info.get("DriverNumber", 0))


def _lap_index_for_times(session, drv: str, times: np.ndarray) -> np.ndarray:
    """Step function: lap number active at each target time."""
    try:
        laps = session.laps.pick_drivers(drv)
    except Exception:
        return np.zeros_like(times, dtype=int)

    if laps.empty:
        return np.zeros_like(times, dtype=int)

    starts = laps["LapStartTime"].dt.total_seconds().to_numpy(dtype=float)
    nums = laps["LapNumber"].to_numpy(dtype=int)
    order = np.argsort(starts)
    starts = starts[order]
    nums = nums[order]

    idx = np.searchsorted(starts, times, side="right") - 1
    idx = np.clip(idx, 0, len(nums) - 1)
    out = nums[idx]
    out[times < starts[0]] = nums[0]
    return out


def _status_for_times(session, drv: str, pos: pd.DataFrame, times: np.ndarray) -> np.ndarray:
    """0=on_track, 1=pit, 2=out. Pit window inferred from lap pit-in/out times."""
    status = np.zeros_like(times, dtype=int)

    # Off-track / retired: FastF1's pos Status flips to 'OffTrack' when the car
    # is stationary or out of the session.
    if "Status" in pos.columns:
        pos_t = pos["SessionTime"].dt.total_seconds().to_numpy(dtype=float)
        s = pos["Status"].astype(str).to_numpy()
        idx = np.searchsorted(pos_t, times, side="right") - 1
        idx = np.clip(idx, 0, len(s) - 1)
        off = (s[idx] != "OnTrack") & (times >= pos_t[0])
        status[off] = 2

    try:
        laps = session.laps.pick_drivers(drv)
    except Exception:
        return status

    for _, lap in laps.iterrows():
        pit_in = lap.get("PitInTime")
        pit_out = lap.get("PitOutTime")
        if pd.isna(pit_in):
            continue
        in_s = pit_in.total_seconds()
        # The pit phase spans in-lap entry to the next lap's exit; fall back to
        # ~25s if pit-out is missing so we don't freeze the car permanently.
        out_s = pit_out.total_seconds() if pd.notna(pit_out) else in_s + 25.0
        mask = (times >= in_s) & (times <= out_s)
        status[mask] = 1

    return status


# --- projection ------------------------------------------------------------


def _project_to_centreline(
    x: np.ndarray,
    y: np.ndarray,
    tree: cKDTree | None,
    cum_dist: np.ndarray,
    track_len_m: float,
) -> np.ndarray:
    if tree is None or len(cum_dist) == 0:
        return np.zeros_like(x)
    pts = np.column_stack([x, y])
    valid = ~np.isnan(pts).any(axis=1)
    out = np.zeros(len(pts))
    if not valid.any():
        return out
    _, idx = tree.query(pts[valid], k=1)
    matched = cum_dist[idx]
    if track_len_m > 0:
        # Closing vertex is duplicated in the centreline; collapse it to 0 so
        # the start/finish line is single-valued for leaderboard sorting.
        matched = matched % track_len_m
    out[valid] = matched
    out[~valid] = np.nan
    return out


# --- frames ----------------------------------------------------------------


_STATUS_NAMES = ("on_track", "pit", "out")


def _assemble_frames(times: np.ndarray, per_driver: dict[int, _DriverArrays]) -> list[Frame]:
    frames: list[Frame] = []
    for i in range(len(times)):
        p: dict[int, DriverSample] = {}
        for num, a in per_driver.items():
            x = a.x[i]
            y = a.y[i]
            if np.isnan(x) or np.isnan(y):
                continue
            p[num] = DriverSample(
                x=round(float(x)),
                y=round(float(y)),
                z=None if np.isnan(a.z[i]) else round(float(a.z[i])),
                d=round(float(a.d[i]), 2) if not np.isnan(a.d[i]) else 0.0,
                lap=int(a.lap[i]),
                spd=round(float(a.spd[i]), 1) if not np.isnan(a.spd[i]) else 0.0,
                gear=int(a.gear[i]) if a.gear[i] else None,
                thr=round(float(a.thr[i]), 1) if not np.isnan(a.thr[i]) else None,
                brk=round(float(a.brk[i]), 1) if not np.isnan(a.brk[i]) else None,
                drs=bool(a.drs[i]) or None,  # None when False — excluded by response_model_exclude_none
                st=_STATUS_NAMES[int(a.status[i])],
            )
        if p:
            frames.append(Frame(t=float(times[i]), p=p))
    return frames


# --- laps ------------------------------------------------------------------


def _build_lap_records(session) -> list[LapRecord]:
    out: list[LapRecord] = []
    try:
        laps = session.laps
    except Exception:
        return out
    for _, lap in laps.iterrows():
        try:
            driver_num = int(lap["DriverNumber"])
        except (KeyError, ValueError, TypeError):
            continue
        out.append(
            LapRecord(
                driver=driver_num,
                lap=int(lap["LapNumber"]),
                lap_time_s=_secs(lap.get("LapTime")),
                sector_1_s=_secs(lap.get("Sector1Time")),
                sector_2_s=_secs(lap.get("Sector2Time")),
                sector_3_s=_secs(lap.get("Sector3Time")),
                compound=_str_or_none(lap.get("Compound")),
                tyre_age=_int_or_none(lap.get("TyreLife")),
                pit_in=pd.notna(lap.get("PitInTime")),
                pit_out=pd.notna(lap.get("PitOutTime")),
            )
        )
    return out


def _session_time_bounds(session) -> tuple[float, float]:
    starts: list[float] = []
    ends: list[float] = []
    for drv, df in session.pos_data.items():  # noqa: B007
        t = df["SessionTime"].dt.total_seconds()
        if len(t):
            starts.append(float(t.iloc[0]))
            ends.append(float(t.iloc[-1]))
    if not starts:
        return 0.0, 0.0
    return min(starts), max(ends)


def _secs(td) -> float | None:
    if td is None or pd.isna(td):
        return None
    return float(td.total_seconds())


def _str_or_none(v) -> str | None:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v)
    return s if s and s.lower() != "nan" else None


def _int_or_none(v) -> int | None:
    if v is None or pd.isna(v):
        return None
    return int(v)
