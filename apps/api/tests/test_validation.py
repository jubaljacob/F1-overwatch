"""Unit tests for the leaderboard accuracy harness.

These use a synthetic RaceData + a synthetic official-position table so the
harness logic is validated without paying for a FastF1 fetch. End-to-end runs
against real races live in scripts/validate_leaderboard.py.
"""

from __future__ import annotations

import pandas as pd

from traceline.schemas.session import (
    CircuitGeometry,
    DriverInfo,
    DriverSample,
    Frame,
    RaceData,
    RaceDataMeta,
)
from traceline.services.leaderboard import leaderboard_at_time
from traceline.services.validation import score_race


def _race(n_frames: int = 5) -> RaceData:
    """Three-driver race on a 1000 m circuit. Order at each frame designed so
    leaderboards are deterministic and easy to reason about in assertions."""
    drivers = [
        DriverInfo(number=1, code="VER", full_name="V", team="RBR", team_colour=None),
        DriverInfo(number=44, code="HAM", full_name="H", team="MER", team_colour=None),
        DriverInfo(number=16, code="LEC", full_name="L", team="FER", team_colour=None),
    ]
    frames: list[Frame] = []
    for i in range(n_frames):
        t = float(i)
        # VER is always leading by a clean margin; HAM ahead of LEC.
        frames.append(
            Frame(
                t=t,
                p={
                    1: DriverSample(x=0, y=0, d=500.0 + 10 * i, lap=i + 1, spd=200),
                    44: DriverSample(x=0, y=0, d=400.0 + 10 * i, lap=i + 1, spd=200),
                    16: DriverSample(x=0, y=0, d=300.0 + 10 * i, lap=i + 1, spd=200),
                },
            )
        )
    return RaceData(
        meta=RaceDataMeta(
            year=2099,
            round=1,
            circuit="Test",
            session_type="R",
            total_laps=n_frames,
            frame_hz=1.0,
            t_start=0.0,
            t_end=float(n_frames - 1),
        ),
        drivers=drivers,
        circuit=CircuitGeometry(
            name="Test", track_length_m=1000.0, centreline=[(0.0, 0.0)], cumulative_distance=[0.0]
        ),
        frames=frames,
        laps=[],
    )


def test_leaderboard_at_time_matches_progress_order() -> None:
    race = _race()
    order = leaderboard_at_time(race, 2.5)  # snaps to frame index 2
    assert order == [1, 44, 16]


def test_leaderboard_uses_official_classification_past_race_end() -> None:
    """After race_end_t, raw race-progress order is ignored in favour of
    final_classification — covers the P2 chequered-flag override."""
    race = _race()
    race.meta.race_end_t = 2.0
    race.meta.final_classification = {16: 1, 1: 2, 44: 3}  # LEC, VER, HAM
    # At t=1.0 (before race_end_t), raw progress order wins (VER leads).
    assert leaderboard_at_time(race, 1.0) == [1, 44, 16]
    # At t=2.0+ (chequered), official classification order wins.
    assert leaderboard_at_time(race, 2.5) == [16, 1, 44]


def test_leaderboard_skips_out_status() -> None:
    race = _race(1)
    race.frames[0].p[44] = race.frames[0].p[44].model_copy(update={"st": "out"})
    assert leaderboard_at_time(race, 0.0) == [1, 16]


def test_score_race_perfect_when_official_matches_predicted() -> None:
    race = _race()
    # Official agrees with what we computed at every (driver, lap) sample.
    rows = []
    for i in range(len(race.frames)):
        t = float(i)
        rows.extend(
            [
                {"driver_number": 1, "lap": i + 1, "time_s": t, "position": 1},
                {"driver_number": 44, "lap": i + 1, "time_s": t, "position": 2},
                {"driver_number": 16, "lap": i + 1, "time_s": t, "position": 3},
            ]
        )
    official = pd.DataFrame(rows)
    score = score_race(race, official, year=2099, round_=1)
    assert score.n == len(rows)
    assert score.fraction_within(0) == 1.0
    assert score.mean_abs_error() == 0.0


def test_score_race_counts_off_by_one_under_tolerance() -> None:
    race = _race(1)
    # Predicted is [1, 44, 16]. Pretend official says HAM was 3rd and LEC 2nd
    # at lap 1 — that's two off-by-1 samples (HAM 2↔3, LEC 3↔2) plus VER exact.
    official = pd.DataFrame(
        [
            {"driver_number": 1, "lap": 1, "time_s": 0.0, "position": 1},
            {"driver_number": 44, "lap": 1, "time_s": 0.0, "position": 3},
            {"driver_number": 16, "lap": 1, "time_s": 0.0, "position": 2},
        ]
    )
    score = score_race(race, official, year=2099, round_=1)
    assert score.n == 3
    assert score.fraction_within(0) == 1 / 3  # only VER exact
    assert score.fraction_within(1) == 1.0  # all within ±1
    assert score.mean_abs_error() == (0 + 1 + 1) / 3


def test_score_race_skips_drivers_missing_from_frame() -> None:
    race = _race(1)
    # Official references a driver number that never appears in our payload.
    official = pd.DataFrame(
        [{"driver_number": 99, "lap": 1, "time_s": 0.0, "position": 1}]
    )
    score = score_race(race, official, year=2099, round_=1)
    assert score.n == 0
    assert score.fraction_within(1) == 0.0


def test_worst_samples_sorted_by_descending_error() -> None:
    race = _race(1)
    official = pd.DataFrame(
        [
            {"driver_number": 1, "lap": 1, "time_s": 0.0, "position": 1},  # err 0
            {"driver_number": 44, "lap": 1, "time_s": 0.0, "position": 5},  # err 3
            {"driver_number": 16, "lap": 1, "time_s": 0.0, "position": 4},  # err 1
        ]
    )
    score = score_race(race, official, year=2099, round_=1)
    worst = score.worst(2)
    assert [s.driver for s in worst] == [44, 16]
    assert [s.error for s in worst] == [3, 1]
