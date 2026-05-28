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
    QualiSegment,
    RaceData,
    RaceDataMeta,
    TrackStatusEvent,
    WeatherSummary,
)
from traceline.services import fastf1_loader

logger = logging.getLogger(__name__)

FRAME_HZ = 10.0
FRAME_DT = 1.0 / FRAME_HZ
# Downsample the centreline to keep RaceData payloads small; ~3m spacing on a
# 5km track gives ~1700 points, plenty for a P1 renderer.
CENTRELINE_TARGET_POINTS = 1500
# Pre-race lead-in clipped off the front of the replay. Leaves enough for the
# formation-lap roll-out and lights without dragging viewers through the long
# parc-fermé / grid-walk window where nothing is moving.
# Playback starts exactly 7 min 40 s before lap 1 so users land on the
# formation lap / grid build rather than several quiet minutes of cars
# in the pits. 460 s is the F1 broadcast convention for "race window".
PRE_RACE_LEAD_IN_S = 7 * 60.0 + 40.0


def compute_race_data(year: int, round_: int, session_type: str = "R") -> RaceData:
    session = fastf1_loader.load_session(year, round_, session_type, with_telemetry=True)
    drivers = fastf1_loader.get_session_meta(year, round_, session_type).drivers

    centreline_xy, cum_dist, centreline_z = _build_centreline(session)
    track_len_m = float(cum_dist[-1]) if len(cum_dist) else 0.0
    tree = cKDTree(centreline_xy) if len(centreline_xy) else None

    t_start, t_end = _session_time_bounds(session)
    race_start = _race_start_time(session)
    if race_start is not None:
        t_start = max(t_start, race_start - PRE_RACE_LEAD_IN_S)
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
        arrs["d"] = _project_to_centreline(
            arrs["x"], arrs["y"], tree, cum_dist, track_len_m, centreline=centreline_xy
        )
        arrs["d"], arrs["lap"] = _apply_pit_freeze(
            arrs["d"], arrs["lap"], arrs["status"], track_len_m
        )
        per_driver[int(arrs["number"])] = arrs

    frames = _assemble_frames(times, per_driver)
    laps = _build_lap_records(session, session_type)
    race_end_t, classification = _extract_race_end(session)
    weather = _extract_weather(session)
    track_status = _extract_track_status(session)

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
            race_end_t=race_end_t,
            final_classification=classification,
            race_start_t=race_start,
            weather=weather,
            track_status=track_status,
        ),
        drivers=drivers,
        circuit=CircuitGeometry(
            name=str(session.event.get("EventName", "")),
            track_length_m=track_len_m,
            centreline=[(float(p[0]), float(p[1])) for p in centreline_xy],
            cumulative_distance=[float(d) for d in cum_dist],
            elevation=[float(v) for v in centreline_z],
        ),
        frames=frames,
        laps=laps,
    )


# --- centreline ------------------------------------------------------------


def _build_centreline(session) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Use the session's overall fastest lap position trail as the centreline.

    Returns (xy [N,2], cum_dist [N], elevation [N]). Elevation is the Z
    column from the fastest lap's pos_data when available, else zeros —
    the P6 viewer reads this for the 3D ribbon. Good enough for P1
    leaderboarding; P2 swaps in a calibrated centreline.
    """
    try:
        fastest = session.laps.pick_fastest()
        pos = fastest.get_pos_data()
    except Exception as e:
        logger.warning("Centreline fallback (no fastest lap pos): %s", e)
        return np.empty((0, 2)), np.empty(0), np.empty(0)

    xy = pos[["X", "Y"]].to_numpy(dtype=float)
    z = pos["Z"].to_numpy(dtype=float) if "Z" in pos.columns else np.zeros(len(xy))
    valid = ~np.isnan(xy).any(axis=1)
    xy = xy[valid]
    z = z[valid]
    if len(xy) < 2:
        return np.empty((0, 2)), np.empty(0), np.empty(0)

    # Downsample by stride so very dense laps don't blow up the payload.
    stride = max(1, len(xy) // CENTRELINE_TARGET_POINTS)
    xy = xy[::stride]
    z = z[::stride]

    # Close the loop so the projection wraps cleanly across the start/finish.
    if not np.allclose(xy[0], xy[-1]):
        xy = np.vstack([xy, xy[0]])
        z = np.concatenate([z, z[:1]])

    segs = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    cum = np.concatenate(([0.0], np.cumsum(segs)))
    return xy, cum, z


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
    """Step function: lap number active at each target time.

    Driven by lap-END times (`laps["Time"]`) rather than `LapStartTime`. The
    end-of-lap timestamp IS the line crossing; LapStartTime is recorded a
    fraction of a second later, which left the leader's lap counter trailing
    their wrapped `d` at exactly the moments the P2 validation harness
    queries them (LEC predicted P16 at every lap-end at Monaco). Using Time
    means: at t == lap N's finish, the driver has just begun lap N+1, which
    matches both `d`'s wrap to ~0 and the official position field.

    DNF laps (no Time recorded) are skipped — the driver's last completed
    lap number is held until their data ends.
    """
    try:
        laps = session.laps.pick_drivers(drv)
    except Exception:
        return np.ones_like(times, dtype=int)

    if laps.empty:
        return np.ones_like(times, dtype=int)

    ends = laps["Time"].dt.total_seconds().to_numpy(dtype=float)
    nums = laps["LapNumber"].to_numpy(dtype=int)
    valid = ~np.isnan(ends)
    ends = ends[valid]
    nums = nums[valid]
    if len(ends) == 0:
        return np.ones_like(times, dtype=int)

    order = np.argsort(ends)
    ends = ends[order]
    nums = nums[order]

    # Number of laps completed by each `times` value (side="right" so the
    # exact lap-end timestamp counts the lap as done — that's the moment the
    # driver has just crossed the line).
    completed = np.searchsorted(ends, times, side="right")
    base = int(nums[0])  # usually 1 for race sessions
    return (base + completed).astype(int)


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
        laps = session.laps.pick_drivers(drv).sort_values("LapNumber").reset_index(drop=True)
    except Exception:
        return status

    if laps.empty:
        return status

    # In FastF1, PitInTime is on the in-lap row (the lap during which the car
    # entered) and PitOutTime is on the NEXT row (the out-lap). Pairing them
    # naively per-row gives PitOutTime=NaN and a hardcoded ~25s fallback for
    # every stop, which understates real pit windows (18-35s+ with bunching).
    pit_in_secs = laps["PitInTime"].dt.total_seconds().to_numpy()
    pit_out_secs = laps["PitOutTime"].dt.total_seconds().to_numpy()

    for i in range(len(pit_in_secs)):
        in_s = pit_in_secs[i]
        if np.isnan(in_s):
            continue
        out_s: float | None = None
        if i + 1 < len(pit_out_secs) and not np.isnan(pit_out_secs[i + 1]):
            out_s = float(pit_out_secs[i + 1])
        elif not np.isnan(pit_out_secs[i]):
            # Defensive: some sessions record the exit on the same row.
            out_s = float(pit_out_secs[i])
        else:
            # Last-ditch fallback so a retired-in-pit car still flips status.
            out_s = float(in_s) + 25.0
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
    centreline: np.ndarray | None = None,
) -> np.ndarray:
    """Project (x, y) samples onto the centreline polyline.

    P2: full segment projection. For each sample we query the 2 nearest
    centreline vertices via cKDTree as a coarse filter, then evaluate the
    foot-of-perpendicular against the (up to 4) segments adjacent to those
    vertices and pick whichever segment minimises perpendicular distance.
    The returned `along` is the cumulative distance to the projected foot,
    not the nearest vertex — eliminating the discrete jumps that wreck
    leaderboard order between sparse centreline vertices.
    """
    if tree is None or len(cum_dist) == 0:
        return np.zeros_like(x)
    pts = np.column_stack([x, y])
    valid = ~np.isnan(pts).any(axis=1)
    out = np.zeros(len(pts))
    if not valid.any():
        out[~valid] = np.nan
        return out

    if centreline is None:
        # Pre-P2 callers passed nothing; fall back to nearest-vertex so we
        # don't break older code paths. New pipeline always passes centreline.
        _, idx = tree.query(pts[valid], k=1)
        matched = cum_dist[idx]
    else:
        matched = _segment_project(pts[valid], centreline, cum_dist, tree)

    if track_len_m > 0:
        matched = matched % track_len_m
    out[valid] = matched
    out[~valid] = np.nan
    return out


def _segment_project(
    pts: np.ndarray,
    centreline: np.ndarray,
    cum_dist: np.ndarray,
    tree: cKDTree,
) -> np.ndarray:
    """Vectorised foot-of-perpendicular projection onto a closed polyline.

    pts        — (N, 2) query points
    centreline — (M, 2) polyline, last vertex == first (closing wrap-around)
    cum_dist   — (M,) cumulative arc length at each vertex
    tree       — cKDTree over `centreline` for coarse vertex lookup

    Returns an (N,) array of interpolated arc lengths along the polyline.
    """
    n = len(pts)
    m = len(centreline)
    n_seg = m - 1  # segments are [i, i+1] for i in 0..n_seg-1

    # k=2 candidate vertices per point; each yields up to 2 adjacent segments
    # (the one ending at it and the one starting at it). That gives ≤4 segment
    # candidates per point, well past what's needed in practice but cheap.
    k = min(2, m)
    _, vert_idx = tree.query(pts, k=k)
    if k == 1:
        vert_idx = vert_idx[:, None]

    best_d2 = np.full(n, np.inf)
    best_along = np.zeros(n)

    for col in range(k):
        v = vert_idx[:, col]
        for side in (-1, 0):
            # Segment starting index. Clamp to valid range; the closing
            # duplicated vertex means we don't need explicit modulo wrap.
            s = np.clip(v + side, 0, n_seg - 1)
            a = centreline[s]
            b = centreline[s + 1]
            ab = b - a
            ap = pts - a
            seg_len2 = np.einsum("ij,ij->i", ab, ab)
            denom = np.where(seg_len2 > 0, seg_len2, 1.0)
            t = np.clip(np.einsum("ij,ij->i", ap, ab) / denom, 0.0, 1.0)
            foot = a + t[:, None] * ab
            d2 = np.einsum("ij,ij->i", foot - pts, foot - pts)
            seg_len = np.sqrt(seg_len2)
            along = cum_dist[s] + t * seg_len
            better = d2 < best_d2
            best_d2 = np.where(better, d2, best_d2)
            best_along = np.where(better, along, best_along)
    return best_along


# --- pit-cycle freeze ------------------------------------------------------


def _apply_pit_freeze(
    d: np.ndarray,
    lap: np.ndarray,
    status: np.ndarray,
    track_len_m: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Replace lap-distance / lap counter inside each pit window with a linear
    interpolation between the bracketing on-track frames.

    Why: while a car is in the pit lane, its raw (x, y) projects onto an
    arbitrary point of the racing-line centreline (the pit lane is parallel
    to the start/finish straight, so projection lands near the lap boundary).
    The leaderboard then thinks the pitting car is racing past P1. Freezing
    race-progress to a straight-line interpolation between the last on-track
    frame before pit-in and the first on-track frame after pit-out gives an
    order that matches what the real car was doing — losing ~20s, not gaining
    a lap.

    Returns new (d, lap) arrays; inputs are not mutated.
    """
    n = len(d)
    if n == 0 or track_len_m <= 0:
        return d.copy(), lap.copy()
    d_new = d.copy()
    lap_new = lap.copy()

    pit_flag = (status == 1).astype(np.int8)
    if not pit_flag.any():
        return d_new, lap_new

    # Edge-padded diff so we catch runs that start at i=0 or end at i=n-1.
    edges = np.diff(np.concatenate(([0], pit_flag, [0])))
    starts = np.where(edges == 1)[0]
    ends = np.where(edges == -1)[0] - 1  # inclusive last pit-frame index

    for s, e in zip(starts, ends, strict=True):
        pre = s - 1
        post = e + 1
        has_pre = pre >= 0
        has_post = post < n
        if has_pre and has_post:
            p0 = lap[pre] * track_len_m + d[pre]
            p1 = lap[post] * track_len_m + d[post]
            # p1 should be >= p0; if FastF1 quirks invert it (rare), clamp so
            # we never write a negative race-progress delta.
            if p1 < p0:
                p1 = p0
            idx = np.arange(s, e + 1)
            alpha = (idx - pre) / (post - pre)
            p = p0 + alpha * (p1 - p0)
            new_lap = np.floor(p / track_len_m).astype(int)
            lap_new[s : e + 1] = new_lap
            d_new[s : e + 1] = p - new_lap * track_len_m
        elif has_pre:
            # Car retired in the pits — hold the last on-track race-progress.
            d_new[s : e + 1] = d[pre]
            lap_new[s : e + 1] = lap[pre]
        elif has_post:
            # Session started with the car already in pit (formation-lap edge
            # case, very rare). Mirror the first post-pit values back.
            d_new[s : e + 1] = d[post]
            lap_new[s : e + 1] = lap[post]
        # else: the entire driver array is pit — leave as-is.

    return d_new, lap_new


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


def _build_lap_records(session, session_type: str) -> list[LapRecord]:
    out: list[LapRecord] = []
    try:
        laps = session.laps
    except Exception:
        return out

    # For Q / SQ sessions, prefer the race-control chequered-flag
    # timestamps as the authoritative segment boundaries. Fall back to the
    # lap-gap heuristic if race control data is missing or unparseable.
    quali_by_index: dict[int, QualiSegment] = {}
    if session_type in ("Q", "SQ"):
        boundaries = _quali_boundaries_from_race_control_fastf1(session)
        if len(boundaries) >= 2:
            quali_by_index = _classify_quali_segments_by_boundaries_fastf1(
                laps, boundaries
            )
        else:
            quali_by_index = _classify_quali_segments(laps, session_type)

    for idx, (_, lap) in enumerate(laps.iterrows()):
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
                quali_segment=quali_by_index.get(idx),
            )
        )
    return out


# Safety floor for an inter-segment break — well below the real Q1→Q2
# (~7 min) and Q2→Q3 (~8 min) breaks, but well above any plausible
# within-segment lull. Combined with the "top-2 biggest gaps" selector
# below, this rejects spurious breaks at low-action moments and stops
# over-promoting drivers into a higher segment than they ran in.
_MIN_QUALI_BREAK_S = 180.0


def _quali_boundaries_from_race_control_fastf1(session) -> list[float]:
    """Find Q1/Q2 end timestamps from FastF1's race-control message stream.

    FastF1 exposes `session.race_control_messages` with a `Flag` column
    that contains "CHEQUERED" at the end of each quali segment. We return
    the first two chequered timestamps in seconds-from-session-start;
    callers fall back to the lap-gap heuristic if fewer than 2 are found.
    """
    try:
        rc = session.race_control_messages
    except Exception:
        return []
    if rc is None or rc.empty:
        return []
    try:
        # FastF1 stores Time as a Timedelta from session start.
        mask = rc["Flag"].astype(str).str.upper() == "CHEQUERED"
        if not mask.any():
            return []
        times = rc.loc[mask, "Time"].dt.total_seconds().to_numpy()
    except Exception:
        return []
    times = sorted(float(t) for t in times if t == t)  # drop NaN
    # First two are Q1- and Q2-end; the third is session end.
    return times[:2]


def _classify_quali_segments_by_boundaries_fastf1(
    laps, boundaries: list[float]
) -> dict[int, QualiSegment]:
    """Bucket each lap row by LapStartTime vs the two segment boundaries."""
    if len(boundaries) < 2 or laps is None or laps.empty:
        return {}
    try:
        starts = laps["LapStartTime"].dt.total_seconds().to_numpy()
    except Exception:
        return {}
    b1, b2 = boundaries[0], boundaries[1]
    out: dict[int, QualiSegment] = {}
    for i, t in enumerate(starts):
        if np.isnan(t):
            continue
        if t < b1:
            out[i] = "Q1"
        elif t < b2:
            out[i] = "Q2"
        else:
            out[i] = "Q3"
    return out


def _classify_quali_segments(laps, session_type: str) -> dict[int, QualiSegment]:
    """Bucket each lap row into Q1/Q2/Q3 by finding the **two largest**
    gaps in the sorted lap-start timeline. Robust to within-segment
    lulls that the old "any gap > threshold" heuristic would have
    misclassified as breaks (which led to Q3 reporting 15 drivers when
    only 10 actually participated).

    Returns an empty dict for non-qualifying sessions and for any
    session where lap-start times are missing or sparse.
    """
    if session_type not in ("Q", "SQ"):
        return {}
    if laps is None or laps.empty:
        return {}
    try:
        starts = laps["LapStartTime"].dt.total_seconds().to_numpy()
    except Exception:
        return {}
    valid_mask = ~np.isnan(starts)
    if not valid_mask.any():
        return {}

    sorted_order = np.argsort(np.where(valid_mask, starts, np.inf))
    valid_count = int(valid_mask.sum())
    sorted_order = sorted_order[:valid_count]
    sorted_starts = starts[sorted_order]

    if valid_count < 2:
        return {int(sorted_order[0]): "Q1"} if valid_count == 1 else {}

    gaps = np.diff(sorted_starts)
    # Candidate breaks must clear the safety floor.
    eligible_indices = np.where(gaps >= _MIN_QUALI_BREAK_S)[0]
    if len(eligible_indices) > 0:
        # Of the eligible candidates, keep the two biggest.
        eligible_sizes = gaps[eligible_indices]
        order = np.argsort(eligible_sizes)[::-1][:2]
        break_positions = np.sort(eligible_indices[order])
    else:
        break_positions = np.array([], dtype=int)

    seg_for_position = np.full(valid_count, "Q1", dtype=object)
    for current, br in enumerate(break_positions, start=1):
        cursor = int(br) + 1
        label = ("Q1", "Q2", "Q3")[min(current, 2)]
        seg_for_position[cursor:] = label

    out: dict[int, QualiSegment] = {}
    for pos, row_idx in enumerate(sorted_order):
        seg = str(seg_for_position[pos])
        if seg in ("Q1", "Q2", "Q3"):
            out[int(row_idx)] = seg  # type: ignore[assignment]
    return out


# FastF1 track-status codes. See fastf1.api.track_status_data — the raw
# `Status` column is a stringified int. We collapse 6 + 7 (VSC deployed +
# VSC ending) into a single "vsc" bucket because the UI only cares whether
# VSC is active, not the precise transition phase. Any code outside this
# table is dropped from the timeline rather than surfaced as an unknown
# enum, so the frontend never sees a status it can't render.
_TRACK_STATUS_MAP: dict[str, str] = {
    "1": "green",
    "2": "yellow",
    "4": "sc",
    "5": "red",
    "6": "vsc",
    "7": "vsc",
}


def _extract_track_status(session) -> list[TrackStatusEvent]:
    """Build the ordered (t, status) timeline from session.track_status.

    Adjacent duplicate statuses are collapsed so the frontend doesn't see
    redundant transitions (FastF1 sometimes emits 6→7→6 within seconds at
    the VSC end, which would otherwise spam the status banner).
    """
    try:
        ts = session.track_status
    except Exception:
        return []
    if ts is None or len(ts) == 0:
        return []

    try:
        times = ts["Time"].dt.total_seconds().to_numpy(dtype=float)
        codes = ts["Status"].astype(str).to_numpy()
    except Exception:
        return []

    out: list[TrackStatusEvent] = []
    last_status: str | None = None
    for raw_t, raw_code in zip(times, codes, strict=True):
        if pd.isna(raw_t):
            continue
        status = _TRACK_STATUS_MAP.get(str(raw_code).strip())
        if status is None:
            continue
        if status == last_status:
            continue
        out.append(TrackStatusEvent(t=float(raw_t), status=status))  # type: ignore[arg-type]
        last_status = status
    return out


def _extract_weather(session) -> WeatherSummary | None:
    """Aggregate session.weather_data into a single header-friendly summary.

    FastF1's weather is a DataFrame sampled at coarse intervals across the
    session. For a header widget we want one number per metric — the mean
    is fine for temps and humidity, any-true for rainfall (a single wet
    sample is enough to flag the session as having rain)."""
    try:
        wx = session.weather_data
    except Exception:
        return None
    if wx is None or len(wx) == 0:
        return None

    def _mean(col: str) -> float | None:
        if col not in wx.columns:
            return None
        s = pd.to_numeric(wx[col], errors="coerce").dropna()
        if s.empty:
            return None
        return round(float(s.mean()), 1)

    rainfall = False
    if "Rainfall" in wx.columns:
        try:
            rainfall = bool(wx["Rainfall"].astype(bool).any())
        except Exception:
            rainfall = False

    return WeatherSummary(
        air_temp_c=_mean("AirTemp"),
        track_temp_c=_mean("TrackTemp"),
        humidity_pct=_mean("Humidity"),
        rainfall=rainfall,
        wind_speed_kph=_mean("WindSpeed"),
    )


def _extract_race_end(session) -> tuple[float | None, dict[int, int] | None]:
    """Resolve the chequered-flag time and official classification.

    `race_end_t` is the session-time at which the winner crossed the line on
    their final lap — after this point, raw (x, y) trails get noisy (cars
    coasting, parking, doing celebration laps) and the official Result table
    is the only trustworthy order.

    Returns (None, None) if any required data is missing; callers fall back
    to pure race-progress sorting in that case.
    """
    try:
        results = session.results
    except Exception:
        return None, None
    if results is None or len(results) == 0:
        return None, None

    classification: dict[int, int] = {}
    for _, row in results.iterrows():
        pos = row.get("Position")
        num = row.get("DriverNumber")
        if pd.isna(pos) or pd.isna(num):
            continue
        try:
            classification[int(num)] = int(pos)
        except (ValueError, TypeError):
            continue
    if not classification:
        return None, None

    winner_num = next((n for n, p in classification.items() if p == 1), None)
    if winner_num is None:
        return None, classification

    try:
        winner_laps = session.laps.pick_drivers(str(winner_num))
        if winner_laps.empty:
            return None, classification
        max_time = winner_laps["Time"].max()
        if pd.isna(max_time):
            return None, classification
        return float(max_time.total_seconds()), classification
    except Exception:
        return None, classification


def _race_start_time(session) -> float | None:
    """Return the session-time at which lap 1 begins for the leader.

    Used to trim the replay's pre-race lead-in: we don't want viewers staring
    at a grid of stationary cars for 20 minutes before the lights go out.
    """
    try:
        laps = session.laps
        if laps is None or laps.empty:
            return None
        lap1 = laps[laps["LapNumber"] == 1]
        if lap1.empty:
            return None
        starts = lap1["LapStartTime"].dt.total_seconds()
        starts = starts.dropna()
        if starts.empty:
            return None
        return float(starts.min())
    except Exception:
        return None


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
