"""Tests for the strategy simulator (P4-3).

A toy `TyreModel` with known compound fits lets us verify lap-time
prediction, pit-penalty application, stint expansion, and the
extract_actual_strategy / total-race-time helpers.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from traceline.services.strategy_sim import (
    DEFAULT_PIT_PENALTY_S,
    PitStop,
    StrategyInput,
    StrategySimulatorError,
    actual_total_race_times,
    extract_actual_strategy,
    simulate_strategy,
)
from traceline.services.tyre_model import CompoundFit, TyreModel


def make_model() -> TyreModel:
    """Three compounds with simple, distinct degradation profiles."""
    return TyreModel(
        by_compound={
            "SOFT": CompoundFit(
                compound="SOFT",
                intercept=80.0,
                coef_tyre_age=0.10,
                coef_lap_norm=-2.0,  # fuel burn-off
                coef_track_temp=None,
                n_samples=100,
                r_squared=0.95,
                rmse=0.1,
            ),
            "MEDIUM": CompoundFit(
                compound="MEDIUM",
                intercept=80.5,
                coef_tyre_age=0.06,
                coef_lap_norm=-2.0,
                coef_track_temp=None,
                n_samples=100,
                r_squared=0.95,
                rmse=0.1,
            ),
            "HARD": CompoundFit(
                compound="HARD",
                intercept=81.0,
                coef_tyre_age=0.03,
                coef_lap_norm=-2.0,
                coef_track_temp=None,
                n_samples=100,
                r_squared=0.95,
                rmse=0.1,
            ),
        }
    )


# --- stint expansion -------------------------------------------------------


def test_stints_one_stint_no_pit_stops() -> None:
    strat = StrategyInput(starting_compound="MEDIUM", pit_stops=())
    stints = strat.stints(total_laps=50)
    assert len(stints) == 1
    assert stints[0].compound == "MEDIUM"
    assert stints[0].start_lap == 1
    assert stints[0].end_lap == 50


def test_stints_two_stints_one_pit() -> None:
    strat = StrategyInput(
        starting_compound="MEDIUM", pit_stops=(PitStop(lap=25, new_compound="HARD"),)
    )
    stints = strat.stints(total_laps=50)
    assert len(stints) == 2
    assert (stints[0].compound, stints[0].start_lap, stints[0].end_lap) == ("MEDIUM", 1, 25)
    assert (stints[1].compound, stints[1].start_lap, stints[1].end_lap) == ("HARD", 26, 50)


def test_stints_handles_two_pits() -> None:
    strat = StrategyInput(
        starting_compound="SOFT",
        pit_stops=(
            PitStop(lap=15, new_compound="MEDIUM"),
            PitStop(lap=40, new_compound="HARD"),
        ),
    )
    stints = strat.stints(total_laps=70)
    assert [s.compound for s in stints] == ["SOFT", "MEDIUM", "HARD"]
    assert [(s.start_lap, s.end_lap) for s in stints] == [(1, 15), (16, 40), (41, 70)]


def test_stints_sorts_unsorted_pit_stops() -> None:
    """User-supplied pit stops may be in any order; the simulator must sort."""
    strat = StrategyInput(
        starting_compound="MEDIUM",
        pit_stops=(
            PitStop(lap=40, new_compound="HARD"),
            PitStop(lap=15, new_compound="SOFT"),
        ),
    )
    stints = strat.stints(total_laps=70)
    assert [s.compound for s in stints] == ["MEDIUM", "SOFT", "HARD"]


# --- simulator ------------------------------------------------------------


def test_simulate_applies_pit_penalty_on_pit_lap_only() -> None:
    model = make_model()
    strat = StrategyInput(
        starting_compound="MEDIUM", pit_stops=(PitStop(lap=10, new_compound="HARD"),)
    )
    result = simulate_strategy(
        driver_num=1,
        strategy=strat,
        tyre_model=model,
        other_driver_totals_s={},
        total_laps=20,
        track_temp_c=None,
        pit_penalty_s=22.0,
    )
    # Exactly one lap should be flagged as a pit stop, on lap 10.
    pit_laps = [lap for lap in result.laps if lap.pit_stop]
    assert len(pit_laps) == 1
    assert pit_laps[0].lap == 10
    # The penalty should appear in the predicted time for lap 10 vs lap 11.
    lap_10 = next(lap for lap in result.laps if lap.lap == 10)
    lap_11 = next(lap for lap in result.laps if lap.lap == 11)
    # Lap 11 is a fresh-tyre lap on HARD; lap 10 carries the MEDIUM end-of-stint
    # time + penalty. The 22s penalty is much larger than typical inter-lap
    # variation, so the gap must be at least ~20s.
    assert lap_10.predicted_lap_time_s - lap_11.predicted_lap_time_s > 18.0


def test_simulate_resets_tyre_age_on_each_stint() -> None:
    model = make_model()
    strat = StrategyInput(
        starting_compound="MEDIUM", pit_stops=(PitStop(lap=10, new_compound="HARD"),)
    )
    result = simulate_strategy(
        driver_num=1,
        strategy=strat,
        tyre_model=model,
        other_driver_totals_s={},
        total_laps=20,
        track_temp_c=None,
        pit_penalty_s=0.0,  # focus on tyre_age semantics
    )
    # Lap 1: MEDIUM, age 0. Lap 10: MEDIUM, age 9. Lap 11: HARD, age 0.
    lap_1 = next(lap for lap in result.laps if lap.lap == 1)
    lap_10 = next(lap for lap in result.laps if lap.lap == 10)
    lap_11 = next(lap for lap in result.laps if lap.lap == 11)
    assert lap_1.tyre_age == 0 and lap_1.compound == "MEDIUM"
    assert lap_10.tyre_age == 9 and lap_10.compound == "MEDIUM"
    assert lap_11.tyre_age == 0 and lap_11.compound == "HARD"


def test_simulate_position_is_rank_against_others() -> None:
    model = make_model()
    strat = StrategyInput(starting_compound="MEDIUM", pit_stops=())
    # Make others span the predicted total to pin the rank deterministically.
    # MEDIUM 1-stop-free 20 laps ≈ 80*20 + 0.06 * sum(0..19) - 2.0 * (avg lap_norm * 20)
    # ≈ 1600 + 11.4 - 21 ≈ 1590s. So put two faster and two slower.
    result = simulate_strategy(
        driver_num=1,
        strategy=strat,
        tyre_model=model,
        other_driver_totals_s={2: 100.0, 3: 200.0, 4: 9000.0, 5: 9001.0},
        total_laps=20,
        track_temp_c=None,
    )
    # Two faster than our ~1590s -> we're P3.
    assert result.finishing_position == 3


def test_simulate_records_actuals_when_provided() -> None:
    model = make_model()
    strat = StrategyInput(starting_compound="MEDIUM", pit_stops=())
    result = simulate_strategy(
        driver_num=1,
        strategy=strat,
        tyre_model=model,
        other_driver_totals_s={},
        total_laps=20,
        track_temp_c=None,
        actual_total_race_time_s=1610.0,
        actual_finishing_position=4,
    )
    assert result.actual_total_race_time_s == 1610.0
    assert result.actual_finishing_position == 4
    assert result.delta_to_actual_s == pytest.approx(result.total_race_time_s - 1610.0)


def test_simulate_raises_on_unknown_compound() -> None:
    model = make_model()
    strat = StrategyInput(starting_compound="WET", pit_stops=())
    with pytest.raises(StrategySimulatorError):
        simulate_strategy(
            driver_num=1,
            strategy=strat,
            tyre_model=model,
            other_driver_totals_s={},
            total_laps=20,
            track_temp_c=None,
        )


# --- actual-strategy extraction -------------------------------------------


def _td(s: float) -> pd.Timedelta:
    return pd.Timedelta(seconds=s)


def test_extract_actual_strategy_detects_compound_change() -> None:
    laps = pd.DataFrame(
        {
            "DriverNumber": ["1"] * 5,
            "LapNumber": [1, 2, 3, 4, 5],
            "Compound": ["MEDIUM", "MEDIUM", "MEDIUM", "HARD", "HARD"],
            "LapTime": [_td(90), _td(91), _td(110), _td(92), _td(93)],
        }
    )
    strat = extract_actual_strategy(laps, driver_num=1)
    assert strat.starting_compound == "MEDIUM"
    assert len(strat.pit_stops) == 1
    assert strat.pit_stops[0].lap == 3  # in-lap is the LAST lap on old compound
    assert strat.pit_stops[0].new_compound == "HARD"


def test_extract_actual_strategy_handles_no_pit() -> None:
    laps = pd.DataFrame(
        {
            "DriverNumber": ["1"] * 3,
            "LapNumber": [1, 2, 3],
            "Compound": ["HARD", "HARD", "HARD"],
            "LapTime": [_td(90)] * 3,
        }
    )
    strat = extract_actual_strategy(laps, driver_num=1)
    assert strat.starting_compound == "HARD"
    assert strat.pit_stops == ()


def test_extract_actual_strategy_raises_when_driver_missing() -> None:
    laps = pd.DataFrame(
        {"DriverNumber": ["1"], "LapNumber": [1], "Compound": ["HARD"], "LapTime": [_td(90)]}
    )
    with pytest.raises(StrategySimulatorError):
        extract_actual_strategy(laps, driver_num=99)


def test_actual_total_race_times_sums_per_driver() -> None:
    laps = pd.DataFrame(
        {
            "DriverNumber": ["1", "1", "1", "2", "2"],
            "LapNumber": [1, 2, 3, 1, 2],
            "LapTime": [_td(90), _td(91), _td(92), _td(80), _td(81)],
        }
    )
    totals = actual_total_race_times(laps)
    assert totals[1] == pytest.approx(273.0)
    assert totals[2] == pytest.approx(161.0)


def test_actual_total_race_times_skips_drivers_with_no_lap_times() -> None:
    laps = pd.DataFrame(
        {
            "DriverNumber": ["1", "2"],
            "LapNumber": [1, 1],
            "LapTime": [_td(90), pd.NaT],
        }
    )
    totals = actual_total_race_times(laps)
    assert 1 in totals
    assert 2 not in totals


def test_default_pit_penalty_is_realistic() -> None:
    """Sanity check on the published default — real F1 pit losses sit in the
    18-30s range depending on track and traffic. 22s is a common midpoint."""
    assert 18.0 < DEFAULT_PIT_PENALTY_S < 30.0


def test_simulate_with_no_temp_model_ignores_temp_argument() -> None:
    """A real circuit's model may have a temperature term or not (depends on
    weather data availability). The simulator handles both — passing
    track_temp_c=None to a model that needs temp should fail loudly via the
    fit's own predict(), but a model with coef_track_temp=None ignores any
    value passed in."""
    model = make_model()  # all compounds have coef_track_temp=None
    strat = StrategyInput(starting_compound="MEDIUM", pit_stops=())
    result_with_temp = simulate_strategy(
        driver_num=1,
        strategy=strat,
        tyre_model=model,
        other_driver_totals_s={},
        total_laps=20,
        track_temp_c=42.0,  # ignored
    )
    result_without_temp = simulate_strategy(
        driver_num=1,
        strategy=strat,
        tyre_model=model,
        other_driver_totals_s={},
        total_laps=20,
        track_temp_c=None,
    )
    assert result_with_temp.total_race_time_s == pytest.approx(result_without_temp.total_race_time_s)


def test_synthetic_validation_within_noise_floor() -> None:
    """End-to-end sanity check: synthesise per-lap times from a known model,
    then ask the simulator to predict those same laps. The predicted total
    should match the synthetic ground truth to within numerical precision —
    no model uncertainty, no pit-penalty mismatch (we pass 0)."""
    model = make_model()
    fit = model.get("MEDIUM")
    assert fit is not None
    total_laps = 30
    # Generate ground truth: lap_time for each lap assuming the strategy.
    strat = StrategyInput(starting_compound="MEDIUM", pit_stops=())
    expected = sum(
        fit.predict(tyre_age=lap - 1, lap_norm=lap / total_laps, track_temp=None)
        for lap in range(1, total_laps + 1)
    )
    result = simulate_strategy(
        driver_num=1,
        strategy=strat,
        tyre_model=model,
        other_driver_totals_s={},
        total_laps=total_laps,
        track_temp_c=None,
        pit_penalty_s=0.0,
    )
    assert result.total_race_time_s == pytest.approx(expected, abs=1e-6)
    # Belt-and-braces: each predicted lap matches the closed-form lap-time.
    for lap_pred in result.laps:
        truth = fit.predict(
            tyre_age=lap_pred.tyre_age,
            lap_norm=lap_pred.lap / total_laps,
            track_temp=None,
        )
        assert lap_pred.predicted_lap_time_s == pytest.approx(truth, abs=1e-9)
    # Used to silence pyflakes — numpy import is for symmetry with sibling tests.
    _ = np.float64
