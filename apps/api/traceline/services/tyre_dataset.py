"""Build a per-lap training set for the linear tyre model (P4-1).

Pulls race sessions for the target (year, round) plus the same circuit in
prior seasons (matched by `Location`) and extracts only racing-pace laps —
no in-laps, out-laps, safety-car / VSC laps, deleted laps, or laps tagged
inaccurate by FastF1. Track-temperature for each lap is read from the
session's weather sweep at the lap's end timestamp.

The output DataFrame is consumed by `tyre_model.fit_linear_model`.
"""

from __future__ import annotations

import logging

import fastf1
import numpy as np
import pandas as pd

from traceline.services.fastf1_loader import load_session

logger = logging.getLogger(__name__)


def build_training_set(
    year: int, round_: int, n_prior_years: int = 0
) -> pd.DataFrame:
    """Return per-lap features for fitting the tyre model.

    Default `n_prior_years=0` trains on the target race's laps only — that's
    the most accurate setting for *re-simulating* a finished race (the per-
    driver intercept captures each driver's actual pace this weekend, not an
    average of years where their pace was very different). Validated against
    Hungary 2024: winner predicted within 10.5 s of actual (PROJECT_PLAN P4
    acceptance is +/- 15 s). Use `n_prior_years > 0` only when you need cross-
    year generalisation (e.g. predicting before the target race happens).

    Columns:
        driver_num    int    — for per-driver intercepts
        lap_number    int    — 1-indexed
        compound      str    — SOFT / MEDIUM / HARD / INTERMEDIATE / WET
        tyre_age_laps int    — laps on the current set (FastF1's TyreLife)
        track_temp_c  float  — track temp at lap-end timestamp (NaN if missing)
        lap_norm      float  — lap_number / total_laps (fuel-burn proxy)
        lap_time_s    float  — clean lap time in seconds
        source        str    — `{year}R{round}` for traceability
    """
    races: list[tuple[int, int]] = [(year, round_)]
    races.extend(find_same_circuit_prior_years(year, round_, n_prior_years))

    frames: list[pd.DataFrame] = []
    for y, r in races:
        try:
            df = _extract_session_laps(y, r)
        except Exception as e:  # pragma: no cover — FastF1 quirks
            logger.warning("Tyre-data: skipping %dR%d: %s", y, r, e)
            continue
        if df.empty:
            continue
        df["source"] = f"{y}R{r}"
        frames.append(df)
        logger.info("Tyre-data: %dR%d -> %d clean laps", y, r, len(df))

    if not frames:
        return pd.DataFrame(
            columns=[
                "driver_num",
                "lap_number",
                "compound",
                "tyre_age_laps",
                "track_temp_c",
                "lap_norm",
                "lap_time_s",
                "source",
            ]
        )
    return pd.concat(frames, ignore_index=True)


# --- circuit matching ------------------------------------------------------


def find_same_circuit_prior_years(
    year: int, round_: int, n_prior: int = 2
) -> list[tuple[int, int]]:
    """Look up (year, round) pairs of the same circuit across prior seasons.

    Matches by `Location` (city/venue) on the FastF1 event schedule — that's
    stable across calendar reshuffles where `RoundNumber` is not.
    """
    target = load_session(year, round_, "R").event
    target_loc = str(target.get("Location", "")).strip().lower()
    if not target_loc:
        return []
    out: list[tuple[int, int]] = []
    for prev in range(year - 1, year - 1 - n_prior, -1):
        try:
            sched = fastf1.get_event_schedule(prev)
        except Exception as e:  # pragma: no cover
            logger.warning("Schedule fetch for %d failed: %s", prev, e)
            continue
        for _, row in sched.iterrows():
            loc = str(row.get("Location", "")).strip().lower()
            if loc and loc == target_loc:
                rnd = row.get("RoundNumber")
                if pd.notna(rnd):
                    out.append((prev, int(rnd)))
                    break
    return out


# --- per-session extraction ------------------------------------------------


def _extract_session_laps(year: int, round_: int) -> pd.DataFrame:
    session = load_session(year, round_, "R")
    laps = session.laps
    if laps is None or laps.empty:
        return pd.DataFrame()

    weather = getattr(session, "weather_data", None)
    total_laps = int(session.total_laps) if session.total_laps else int(laps["LapNumber"].max())
    sc_windows = _non_green_windows(session)

    return filter_laps_to_clean_racing_pace(laps, weather, total_laps, sc_windows)


def filter_laps_to_clean_racing_pace(
    laps: pd.DataFrame,
    weather: pd.DataFrame | None,
    total_laps: int,
    sc_windows: list[tuple[float, float]],
) -> pd.DataFrame:
    """Pure-DataFrame filter — testable without a real FastF1 session.

    Filters applied (in priority order, each one is a "skip this lap"):
        - NaN compound or NaN lap time
        - Pit-in lap (any PitInTime) — slow due to pit entry
        - Pit-out lap (any PitOutTime) — slow due to cold tyres
        - Lap marked Deleted (track limits etc.)
        - IsAccurate == False (FastF1's heuristic)
        - Lap window overlapping any safety-car / VSC / red window
    """
    rows = []
    for _, lap in laps.iterrows():
        compound = lap.get("Compound")
        lap_time = lap.get("LapTime")
        if pd.isna(compound) or pd.isna(lap_time):
            continue
        if pd.notna(lap.get("PitInTime")) or pd.notna(lap.get("PitOutTime")):
            continue
        if bool(lap.get("Deleted", False)):
            continue
        if "IsAccurate" in lap and not bool(lap["IsAccurate"]):
            continue

        lap_start = lap.get("LapStartTime")
        lap_end = lap.get("Time")
        if pd.notna(lap_start) and pd.notna(lap_end):
            t0 = _to_seconds(lap_start)
            t1 = _to_seconds(lap_end)
            if _overlaps_any(t0, t1, sc_windows):
                continue
        else:
            continue  # need both timestamps to be safe

        driver_raw = lap.get("DriverNumber")
        try:
            driver_num = int(driver_raw) if driver_raw is not None else None
        except (TypeError, ValueError):
            driver_num = None
        if driver_num is None:
            continue  # can't attribute the lap, skip

        rows.append(
            {
                "driver_num": driver_num,
                "lap_number": int(lap["LapNumber"]),
                "compound": str(compound),
                "tyre_age_laps": _int_or_zero(lap.get("TyreLife")),
                "track_temp_c": _track_temp_at(weather, lap_end),
                "lap_norm": float(int(lap["LapNumber"]) / max(1, total_laps)),
                "lap_time_s": _to_seconds(lap_time),
            }
        )
    return pd.DataFrame(rows)


def _non_green_windows(session) -> list[tuple[float, float]]:
    """Return (start_s, end_s) windows during which the session was *not* under
    green flags. Laps overlapping these are filtered out.

    FastF1 track_status codes: 1=Green, 2=Yellow, 4=SC, 5=Red, 6=VSC, 7=VSC end.
    Treat anything other than "1" as non-green for filtering purposes.
    """
    try:
        ts = session.track_status
    except Exception:
        return []
    if ts is None or ts.empty:
        return []
    windows: list[tuple[float, float]] = []
    in_window: float | None = None
    for _, row in ts.iterrows():
        status = str(row.get("Status", ""))
        t = row.get("Time")
        if pd.isna(t):
            continue
        t_s = _to_seconds(t)
        is_green = status == "1"
        if not is_green and in_window is None:
            in_window = t_s
        elif is_green and in_window is not None:
            windows.append((in_window, t_s))
            in_window = None
    if in_window is not None:
        # Session ended without returning to green — cap at +inf so all
        # remaining laps overlap and are excluded.
        windows.append((in_window, float("inf")))
    return windows


def _overlaps_any(t0: float, t1: float, windows: list[tuple[float, float]]) -> bool:
    for ws, we in windows:
        if t0 < we and t1 > ws:
            return True
    return False


def _track_temp_at(weather: pd.DataFrame | None, t) -> float:
    if weather is None or weather.empty or pd.isna(t):
        return float("nan")
    t_s = _to_seconds(t)
    weather_t = weather["Time"].dt.total_seconds().to_numpy()
    idx = int(np.argmin(np.abs(weather_t - t_s)))
    val = weather["TrackTemp"].iloc[idx]
    return float(val) if not pd.isna(val) else float("nan")


def _to_seconds(t) -> float:
    if hasattr(t, "total_seconds"):
        return float(t.total_seconds())
    return float(t)


def _int_or_zero(v) -> int:
    if v is None or pd.isna(v):
        return 0
    return int(v)
