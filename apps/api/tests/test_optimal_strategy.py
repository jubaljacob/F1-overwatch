"""Tests for the optimal-strategy estimator (P4-5)."""

from __future__ import annotations

import pytest

from traceline.services.optimal_strategy import (
    DEFAULT_PIT_WINDOW_END_OFFSET,
    DEFAULT_PIT_WINDOW_START_LAP,
    find_optimal_strategies,
)
from traceline.services.tyre_model import CompoundFit, TyreModel


def make_model() -> TyreModel:
    return TyreModel(
        by_compound={
            "SOFT": CompoundFit(
                compound="SOFT",
                intercept=80.0,
                coef_tyre_age=0.18,  # degrades fast
                coef_lap_norm=-2.0,
                coef_track_temp=None,
                n_samples=100,
                r_squared=0.95,
                rmse=0.1,
            ),
            "MEDIUM": CompoundFit(
                compound="MEDIUM",
                intercept=80.5,
                coef_tyre_age=0.07,
                coef_lap_norm=-2.0,
                coef_track_temp=None,
                n_samples=100,
                r_squared=0.95,
                rmse=0.1,
            ),
            "HARD": CompoundFit(
                compound="HARD",
                intercept=81.5,
                coef_tyre_age=0.03,  # very durable
                coef_lap_norm=-2.0,
                coef_track_temp=None,
                n_samples=100,
                r_squared=0.95,
                rmse=0.1,
            ),
        }
    )


def test_finds_three_results_for_default_top_k() -> None:
    out = find_optimal_strategies(
        driver_num=1,
        tyre_model=make_model(),
        other_driver_totals_s={},
        total_laps=50,
        track_temp_c=None,
    )
    assert len(out) == 3
    assert [r.rank for r in out] == [1, 2, 3]


def test_results_are_sorted_by_predicted_time() -> None:
    out = find_optimal_strategies(
        driver_num=1,
        tyre_model=make_model(),
        other_driver_totals_s={},
        total_laps=50,
        track_temp_c=None,
        top_k=5,
    )
    times = [r.result.total_race_time_s for r in out]
    assert times == sorted(times)


def test_returned_strategies_use_at_least_two_compounds() -> None:
    """Dry-race regulation: every returned strategy must include >=2 compounds."""
    out = find_optimal_strategies(
        driver_num=1,
        tyre_model=make_model(),
        other_driver_totals_s={},
        total_laps=50,
        track_temp_c=None,
        top_k=10,
    )
    for r in out:
        compounds = {r.strategy.starting_compound} | {
            s.new_compound for s in r.strategy.pit_stops
        }
        assert len(compounds) >= 2


def test_pit_stops_fall_within_search_window() -> None:
    total_laps = 50
    out = find_optimal_strategies(
        driver_num=1,
        tyre_model=make_model(),
        other_driver_totals_s={},
        total_laps=total_laps,
        track_temp_c=None,
        top_k=10,
    )
    lo = DEFAULT_PIT_WINDOW_START_LAP
    hi = total_laps - DEFAULT_PIT_WINDOW_END_OFFSET
    for r in out:
        for s in r.strategy.pit_stops:
            assert lo <= s.lap <= hi


def test_includes_two_stop_options_by_default() -> None:
    """The two-stop search should produce candidates, not just one-stops."""
    out = find_optimal_strategies(
        driver_num=1,
        tyre_model=make_model(),
        other_driver_totals_s={},
        total_laps=70,
        track_temp_c=None,
        top_k=50,
    )
    has_two_stop = any(len(r.strategy.pit_stops) == 2 for r in out)
    assert has_two_stop


def test_disabling_two_stops_yields_only_one_stops() -> None:
    out = find_optimal_strategies(
        driver_num=1,
        tyre_model=make_model(),
        other_driver_totals_s={},
        total_laps=70,
        track_temp_c=None,
        top_k=50,
        include_two_stops=False,
    )
    for r in out:
        assert len(r.strategy.pit_stops) == 1


def test_raises_when_fewer_than_two_compounds_available() -> None:
    """If the model only has one dry compound fit, no valid dry strategy
    exists — bail with a clear error."""
    model = TyreModel(
        by_compound={
            "MEDIUM": CompoundFit(
                compound="MEDIUM",
                intercept=80.0,
                coef_tyre_age=0.05,
                coef_lap_norm=-2.0,
                coef_track_temp=None,
                n_samples=100,
                r_squared=0.95,
                rmse=0.1,
            ),
        }
    )
    with pytest.raises(ValueError):
        find_optimal_strategies(
            driver_num=1,
            tyre_model=model,
            other_driver_totals_s={},
            total_laps=50,
            track_temp_c=None,
        )


def test_two_stop_strategy_enforces_min_stint_length() -> None:
    """No two pit stops should land within 5 laps of each other in the
    returned strategies (impractical to fit a stint that short)."""
    out = find_optimal_strategies(
        driver_num=1,
        tyre_model=make_model(),
        other_driver_totals_s={},
        total_laps=70,
        track_temp_c=None,
        top_k=50,
    )
    for r in out:
        if len(r.strategy.pit_stops) == 2:
            stops = sorted(r.strategy.pit_stops, key=lambda s: s.lap)
            assert stops[1].lap - stops[0].lap >= 5
