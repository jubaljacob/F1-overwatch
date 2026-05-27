"""Tests for the tyre-data filter logic.

These cover the pure-DataFrame filtering pipeline without touching FastF1 —
synthetic Lap rows let us exercise every skip path deterministically. The
multi-race fetch (find_same_circuit_prior_years + build_training_set) is
exercised by the P4 validation script, not pytest.
"""

from __future__ import annotations

import pandas as pd
import pytest

from traceline.services.tyre_dataset import (
    _overlaps_any,
    filter_laps_to_clean_racing_pace,
)


def td(seconds: float) -> pd.Timedelta:
    return pd.Timedelta(seconds=seconds)


def make_lap(
    *,
    lap_number: int,
    lap_start_s: float,
    lap_end_s: float,
    compound: str | float = "MEDIUM",
    lap_time_s: float | None = 90.0,
    tyre_life: int = 5,
    pit_in: bool = False,
    pit_out: bool = False,
    deleted: bool = False,
    accurate: bool = True,
    driver_number: int = 1,
) -> dict:
    return {
        "DriverNumber": driver_number,
        "LapNumber": lap_number,
        "LapStartTime": td(lap_start_s),
        "Time": td(lap_end_s),
        "LapTime": td(lap_time_s) if lap_time_s is not None else pd.NaT,
        "Compound": compound,
        "TyreLife": tyre_life,
        "PitInTime": td(lap_end_s - 1) if pit_in else pd.NaT,
        "PitOutTime": td(lap_start_s + 1) if pit_out else pd.NaT,
        "Deleted": deleted,
        "IsAccurate": accurate,
    }


def weather_df() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "Time": [td(0), td(3600)],
            "TrackTemp": [40.0, 38.0],
        }
    )


def test_overlaps_any_basic() -> None:
    # Half-open interval check: [t0, t1) vs [ws, we).
    windows = [(100.0, 200.0), (500.0, 600.0)]
    assert _overlaps_any(150.0, 180.0, windows) is True   # fully inside
    assert _overlaps_any(50.0, 250.0, windows) is True    # spans
    assert _overlaps_any(0.0, 50.0, windows) is False     # before all
    assert _overlaps_any(250.0, 400.0, windows) is False  # between
    assert _overlaps_any(550.0, 700.0, windows) is True   # spans 2nd
    assert _overlaps_any(0.0, 0.0, []) is False           # no windows


def test_filter_keeps_clean_racing_lap() -> None:
    laps = pd.DataFrame(
        [make_lap(lap_number=10, lap_start_s=600, lap_end_s=690, lap_time_s=89.5)]
    )
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert len(out) == 1
    row = out.iloc[0]
    assert row["lap_number"] == 10
    assert row["compound"] == "MEDIUM"
    assert row["tyre_age_laps"] == 5
    assert row["lap_time_s"] == pytest.approx(89.5)
    assert row["lap_norm"] == pytest.approx(10 / 70)


def test_filter_drops_pit_in_lap() -> None:
    laps = pd.DataFrame(
        [make_lap(lap_number=20, lap_start_s=1200, lap_end_s=1300, pit_in=True)]
    )
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert out.empty


def test_filter_drops_pit_out_lap() -> None:
    laps = pd.DataFrame(
        [make_lap(lap_number=21, lap_start_s=1300, lap_end_s=1400, pit_out=True)]
    )
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert out.empty


def test_filter_drops_deleted_lap() -> None:
    laps = pd.DataFrame(
        [make_lap(lap_number=30, lap_start_s=1800, lap_end_s=1890, deleted=True)]
    )
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert out.empty


def test_filter_drops_inaccurate_lap() -> None:
    laps = pd.DataFrame(
        [make_lap(lap_number=31, lap_start_s=1890, lap_end_s=1980, accurate=False)]
    )
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert out.empty


def test_filter_drops_nan_compound_or_laptime() -> None:
    laps = pd.DataFrame(
        [
            make_lap(lap_number=40, lap_start_s=2400, lap_end_s=2490, compound=float("nan")),
            make_lap(lap_number=41, lap_start_s=2490, lap_end_s=2580, lap_time_s=None),
        ]
    )
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert out.empty


def test_filter_drops_lap_overlapping_safety_car_window() -> None:
    laps = pd.DataFrame(
        [
            make_lap(lap_number=50, lap_start_s=3000, lap_end_s=3090),  # before SC
            make_lap(lap_number=51, lap_start_s=3090, lap_end_s=3210),  # crosses into SC
            make_lap(lap_number=52, lap_start_s=3210, lap_end_s=3330),  # entirely under SC
            make_lap(lap_number=53, lap_start_s=3330, lap_end_s=3420),  # after SC ends
        ]
    )
    # SC window 3100..3300
    out = filter_laps_to_clean_racing_pace(
        laps, weather_df(), total_laps=70, sc_windows=[(3100.0, 3300.0)]
    )
    assert sorted(out["lap_number"].tolist()) == [50, 53]


def test_filter_attaches_track_temp_from_weather() -> None:
    # Weather: temp drops linearly from 40 at t=0 to 38 at t=3600. Closest
    # sample wins (np.argmin), so a lap ending near t=200 picks the 40C row.
    laps = pd.DataFrame([make_lap(lap_number=5, lap_start_s=150, lap_end_s=200)])
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert out.iloc[0]["track_temp_c"] == pytest.approx(40.0)


def test_filter_skips_lap_with_missing_timestamps() -> None:
    """A lap without LapStartTime or Time can't be SC-checked, so we skip it
    defensively rather than risk including a SC lap."""
    laps = pd.DataFrame(
        [
            {
                "DriverNumber": 1,
                "LapNumber": 60,
                "LapStartTime": pd.NaT,
                "Time": td(3700),
                "LapTime": td(90),
                "Compound": "HARD",
                "TyreLife": 12,
                "PitInTime": pd.NaT,
                "PitOutTime": pd.NaT,
                "Deleted": False,
                "IsAccurate": True,
            }
        ]
    )
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert out.empty


def test_filter_skips_lap_with_no_driver_number() -> None:
    laps = pd.DataFrame(
        [make_lap(lap_number=70, lap_start_s=4200, lap_end_s=4290, driver_number=0)]
    )
    laps.loc[0, "DriverNumber"] = pd.NA
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert out.empty


def test_filter_includes_driver_number_in_output() -> None:
    laps = pd.DataFrame(
        [
            make_lap(lap_number=5, lap_start_s=300, lap_end_s=390, driver_number=44),
            make_lap(lap_number=6, lap_start_s=390, lap_end_s=480, driver_number=44),
        ]
    )
    out = filter_laps_to_clean_racing_pace(laps, weather_df(), total_laps=70, sc_windows=[])
    assert list(out["driver_num"]) == [44, 44]
