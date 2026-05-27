from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

DriverStatus = Literal["on_track", "pit", "out"]


class DriverInfo(BaseModel):
    number: int = Field(..., description="Permanent car number")
    code: str = Field(..., description="Three-letter driver code, e.g. VER")
    full_name: str
    team: str
    team_colour: str | None = Field(None, description="Hex colour without leading #")


class SessionMeta(BaseModel):
    year: int
    round: int
    circuit: str
    session_type: str = Field(..., description="R, Q, S, FP1, FP2, FP3, etc.")
    total_laps: int | None = None
    drivers: list[DriverInfo]


class SampleLap(BaseModel):
    driver_code: str
    lap_number: int
    lap_time_seconds: float
    compound: str | None = None


# --- RaceData (P1) ---------------------------------------------------------
#
# RaceData is the full pre-computed payload that drives the replay. Per
# CLAUDE.md §4, frames are sampled at a uniform 10Hz and leaderboard order is
# `lap * trackLength + lapDistance`. Keep field names short — this blob is
# serialised once per session and shipped to every client.


class CircuitGeometry(BaseModel):
    name: str
    track_length_m: float = Field(..., description="Approx length of one lap in metres")
    centreline: list[tuple[float, float]] = Field(
        ..., description="Ordered (x, y) polyline approximating the racing line"
    )
    cumulative_distance: list[float] = Field(
        ..., description="Cumulative distance along centreline, same length as centreline"
    )


class DriverSample(BaseModel):
    # Tight field names — repeated 20 times per frame across ~6500 frames.
    x: float
    y: float
    z: float | None = None
    d: float = Field(..., description="lapDistance: 0..trackLength_m")
    lap: int
    spd: float = Field(..., description="km/h")
    gear: int | None = None
    thr: float | None = Field(None, description="0..100")
    brk: float | None = Field(None, description="0..100")
    drs: bool | None = None
    st: DriverStatus = "on_track"


class Frame(BaseModel):
    t: float = Field(..., description="Session time in seconds from race start")
    p: dict[int, DriverSample] = Field(
        ..., description="Per-driver position sample, keyed by driver number"
    )


class LapRecord(BaseModel):
    driver: int = Field(..., description="Driver number")
    lap: int
    lap_time_s: float | None = None
    sector_1_s: float | None = None
    sector_2_s: float | None = None
    sector_3_s: float | None = None
    compound: str | None = None
    tyre_age: int | None = None
    pit_in: bool = False
    pit_out: bool = False


class RaceDataMeta(BaseModel):
    year: int
    round: int
    circuit: str
    session_type: str
    total_laps: int
    frame_hz: float = 10.0
    t_start: float = 0.0
    t_end: float
    # P2 race-end override: leaderboards switch to `final_classification` for
    # `frame.t >= race_end_t`. Both nullable so non-race sessions (Q, FP) and
    # data shortfalls degrade gracefully back to pure race-progress order.
    race_end_t: float | None = None
    final_classification: dict[int, int] | None = Field(
        default=None,
        description="Official position keyed by driver number; 1 = winner",
    )
    # Session-time at which lap 1 begins for the leader — i.e. lights-out.
    # Used by the leaderboard's position-change arrow to baseline at race
    # start rather than at the start of the recorded data (which includes
    # the pre-race grid-walk / formation lap, where order is meaningless).
    race_start_t: float | None = None


class RaceData(BaseModel):
    meta: RaceDataMeta
    drivers: list[DriverInfo]
    circuit: CircuitGeometry
    frames: list[Frame]
    laps: list[LapRecord]
