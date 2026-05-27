"""P4 strategy endpoints — tyre model, simulate, optimal strategies.

All three are bound under `/sessions/{year}/{round_}/...` to keep the URL
shape consistent with the rest of the API. The fitted tyre model is
cached per (year, round) — fitting itself is fast, but the FastF1 fetch
of 2-3 prior years' sessions is slow on a cold cache and we don't want
to repeat it on every simulate call.
"""

from __future__ import annotations

import logging
from functools import lru_cache, partial

import numpy as np
from anyio import to_thread
from fastapi import APIRouter, HTTPException

from traceline.schemas.strategy import (
    CompoundFitOut,
    LapPredictionOut,
    PitStopIn,
    RankedStrategyOut,
    SimulationOut,
    StrategyIn,
    StrategySimulateBody,
    TyreModelOut,
)
from traceline.services.fastf1_loader import load_session
from traceline.services.optimal_strategy import find_optimal_strategies
from traceline.services.strategy_sim import (
    DEFAULT_PIT_PENALTY_S,
    PitStop,
    StrategyInput,
    StrategySimulatorError,
    actual_total_race_times,
    extract_actual_strategy,
    simulate_strategy,
)
from traceline.services.tyre_dataset import build_training_set
from traceline.services.tyre_model import TyreModel, fit_linear_model

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["strategy"])


# --- cached per-race assets -----------------------------------------------


@lru_cache(maxsize=8)
def _model_for_race(year: int, round_: int) -> tuple[TyreModel, float | None, int, int, int]:
    """Fit and cache the tyre model + ancillary race context.

    Returns (model, track_temp_c, total_laps, n_sessions, n_samples).
    The lru_cache makes repeat hits in the same process effectively free;
    callers behind FastAPI's `to_thread` pay the FastF1 fetch on cold.
    """
    training = build_training_set(year, round_, n_prior_years=0)
    if training.empty:
        raise RuntimeError(
            f"No training data for {year} R{round_} — likely a brand-new circuit "
            "or FastF1 returning empty laps."
        )
    model = fit_linear_model(training)
    if not model.compounds():
        raise RuntimeError(
            f"Tyre model fit empty for {year} R{round_} — training laps insufficient."
        )
    session = load_session(year, round_, "R")
    total_laps = int(session.total_laps) if session.total_laps else int(session.laps["LapNumber"].max())
    weather = getattr(session, "weather_data", None)
    track_temp = _median_track_temp(weather)
    n_sessions = int(training["source"].nunique())
    return model, track_temp, total_laps, n_sessions, len(training)


def _median_track_temp(weather) -> float | None:
    if weather is None or weather.empty or "TrackTemp" not in weather.columns:
        return None
    arr = weather["TrackTemp"].dropna().to_numpy(dtype=float)
    return float(np.median(arr)) if arr.size else None


# --- handlers --------------------------------------------------------------


@router.get(
    "/{year}/{round_}/tyre-model",
    response_model=TyreModelOut,
    response_model_exclude_none=True,
)
async def get_tyre_model(year: int, round_: int) -> TyreModelOut:
    """Return the fitted linear tyre model for this race's circuit.

    Slow on a cold cache (multi-year FastF1 fetch). Subsequent calls within
    the process are cached.
    """
    try:
        model, track_temp, total_laps, n_sessions, n_samples = await to_thread.run_sync(
            partial(_model_for_race, year, round_)
        )
    except Exception as e:
        logger.exception("Tyre-model fetch failed for %d R%d", year, round_)
        raise HTTPException(status_code=502, detail=f"Tyre model build failed: {e}") from e
    return TyreModelOut(
        year=year,
        round=round_,
        n_sessions=n_sessions,
        n_samples_total=n_samples,
        track_temp_c=track_temp,
        total_laps=total_laps,
        compounds=[_compound_to_out(model, c) for c in model.compounds()],
    )


@router.post(
    "/{year}/{round_}/simulate-strategy",
    response_model=SimulationOut,
    response_model_exclude_none=True,
)
async def post_simulate_strategy(
    year: int, round_: int, body: StrategySimulateBody
) -> SimulationOut:
    try:
        model, track_temp, total_laps, _n_sessions, _n_samples = await to_thread.run_sync(
            partial(_model_for_race, year, round_)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Tyre model unavailable: {e}") from e

    try:
        session = await to_thread.run_sync(partial(load_session, year, round_, "R"))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Session load failed: {e}") from e

    laps_df = session.laps
    other_totals = actual_total_race_times(laps_df)
    target_actual = other_totals.get(body.driver)
    other_minus_target = {k: v for k, v in other_totals.items() if k != body.driver}

    try:
        result = simulate_strategy(
            driver_num=body.driver,
            strategy=_strategy_from_body(body.strategy),
            tyre_model=model,
            other_driver_totals_s=other_minus_target,
            total_laps=total_laps,
            track_temp_c=track_temp,
            pit_penalty_s=DEFAULT_PIT_PENALTY_S,
            actual_total_race_time_s=target_actual,
        )
    except StrategySimulatorError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    return _result_to_out(result)


@router.get(
    "/{year}/{round_}/optimal-strategies/{driver}",
    response_model=list[RankedStrategyOut],
    response_model_exclude_none=True,
)
async def get_optimal_strategies(
    year: int, round_: int, driver: int, top_k: int = 3
) -> list[RankedStrategyOut]:
    try:
        model, track_temp, total_laps, _n_sessions, _n_samples = await to_thread.run_sync(
            partial(_model_for_race, year, round_)
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Tyre model unavailable: {e}") from e

    try:
        session = await to_thread.run_sync(partial(load_session, year, round_, "R"))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Session load failed: {e}") from e

    other_totals = actual_total_race_times(session.laps)
    target_actual = other_totals.get(driver)
    other_minus_target = {k: v for k, v in other_totals.items() if k != driver}

    try:
        ranked = await to_thread.run_sync(
            partial(
                find_optimal_strategies,
                driver_num=driver,
                tyre_model=model,
                other_driver_totals_s=other_minus_target,
                total_laps=total_laps,
                track_temp_c=track_temp,
                pit_penalty_s=DEFAULT_PIT_PENALTY_S,
                top_k=top_k,
                actual_total_race_time_s=target_actual,
            )
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    return [
        RankedStrategyOut(
            rank=r.rank,
            strategy=StrategyIn(
                starting_compound=r.strategy.starting_compound,
                pit_stops=[
                    PitStopIn(lap=s.lap, new_compound=s.new_compound)
                    for s in r.strategy.pit_stops
                ],
            ),
            result=_result_to_out(r.result),
        )
        for r in ranked
    ]


@router.get("/{year}/{round_}/actual-strategy/{driver}", response_model=StrategyIn)
async def get_actual_strategy(year: int, round_: int, driver: int) -> StrategyIn:
    """Reconstruct the driver's actual pit schedule from FastF1 lap data.

    Used by the frontend to seed the strategy editor with the real strategy
    before the user starts editing.
    """
    try:
        session = await to_thread.run_sync(partial(load_session, year, round_, "R"))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Session load failed: {e}") from e
    try:
        strat = extract_actual_strategy(session.laps, driver)
    except StrategySimulatorError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    return StrategyIn(
        starting_compound=strat.starting_compound,
        pit_stops=[PitStopIn(lap=s.lap, new_compound=s.new_compound) for s in strat.pit_stops],
    )


# --- converters ------------------------------------------------------------


def _strategy_from_body(s: StrategyIn) -> StrategyInput:
    return StrategyInput(
        starting_compound=s.starting_compound,
        pit_stops=tuple(PitStop(lap=p.lap, new_compound=p.new_compound) for p in s.pit_stops),
    )


def _result_to_out(result) -> SimulationOut:
    return SimulationOut(
        driver_num=result.driver_num,
        total_race_time_s=result.total_race_time_s,
        finishing_position=result.finishing_position,
        laps=[
            LapPredictionOut(
                lap=lap.lap,
                compound=lap.compound,
                tyre_age=lap.tyre_age,
                predicted_lap_time_s=lap.predicted_lap_time_s,
                pit_stop=lap.pit_stop,
            )
            for lap in result.laps
        ],
        actual_total_race_time_s=result.actual_total_race_time_s,
        actual_finishing_position=result.actual_finishing_position,
        delta_to_actual_s=result.delta_to_actual_s,
    )


def _compound_to_out(model: TyreModel, compound: str) -> CompoundFitOut:
    fit = model.get(compound)
    assert fit is not None  # only iterated over fitted compounds
    return CompoundFitOut(
        compound=fit.compound,
        intercept=fit.intercept,
        coef_tyre_age=fit.coef_tyre_age,
        coef_lap_norm=fit.coef_lap_norm,
        coef_track_temp=fit.coef_track_temp,
        n_samples=fit.n_samples,
        r_squared=fit.r_squared,
        rmse=fit.rmse,
    )
