"""API schemas for the P4 strategy endpoints."""

from __future__ import annotations

from pydantic import BaseModel, Field


# --- tyre model ------------------------------------------------------------


class CompoundFitOut(BaseModel):
    compound: str
    intercept: float = Field(..., description="Base lap time (s) at age=0, lap_norm=0, temp=0")
    coef_tyre_age: float = Field(..., description="Seconds per lap of tyre age")
    coef_lap_norm: float = Field(..., description="Seconds per unit (lap/total_laps); typically <0 (fuel burn)")
    coef_track_temp: float | None = Field(
        None, description="Seconds per °C of track temp; null if temp data was too sparse"
    )
    n_samples: int
    r_squared: float
    rmse: float = Field(..., description="Root-mean-square error on the training set (s)")


class TyreModelOut(BaseModel):
    year: int
    round: int
    n_sessions: int = Field(..., description="Number of historical race sessions in the training set")
    n_samples_total: int
    track_temp_c: float | None = Field(
        None, description="Session-median track temperature used for predictions"
    )
    total_laps: int
    compounds: list[CompoundFitOut]


# --- strategy simulation ---------------------------------------------------


class PitStopIn(BaseModel):
    lap: int = Field(..., ge=1, description="Pit-in lap (1-indexed)")
    new_compound: str = Field(..., description="SOFT | MEDIUM | HARD")


class StrategyIn(BaseModel):
    starting_compound: str
    pit_stops: list[PitStopIn] = Field(default_factory=list)


class LapPredictionOut(BaseModel):
    lap: int
    compound: str
    tyre_age: int
    predicted_lap_time_s: float
    pit_stop: bool


class SimulationOut(BaseModel):
    driver_num: int
    total_race_time_s: float
    finishing_position: int
    laps: list[LapPredictionOut]
    actual_total_race_time_s: float | None = None
    actual_finishing_position: int | None = None
    delta_to_actual_s: float | None = None


class StrategySimulateBody(BaseModel):
    driver: int = Field(..., description="Driver number (matches frames keys)")
    strategy: StrategyIn


# --- optimal strategies ----------------------------------------------------


class RankedStrategyOut(BaseModel):
    rank: int
    strategy: StrategyIn
    result: SimulationOut
