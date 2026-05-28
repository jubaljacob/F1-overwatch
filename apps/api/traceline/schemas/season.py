"""Pydantic models for the live-season endpoint.

Mirrors the shape consumed by the frontend dashboard. Field naming uses
camelCase via Field aliases so the JSON wire format matches the TS types
without an extra mapping step.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ScheduleRace(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    round: int
    name: str
    location: str
    """Internal circuit slug — matches keys in apps/web/lib/track-paths.ts."""
    circuit_key: str = Field(..., alias="circuitKey")
    """Race-day ISO date (YYYY-MM-DD)."""
    date: str


class DriverStandingRow(BaseModel):
    position: int
    name: str
    team: str
    points: float
    wins: int


class ConstructorStandingRow(BaseModel):
    position: int
    team: str
    """Optional chassis code (Jolpi doesn't expose this — left None and
    surfaced from the frontend's local static map when available)."""
    chassis: str | None = None
    points: float


class RaceResultRow(BaseModel):
    position: int
    name: str
    team: str
    """Total time for the winner; gap (e.g. `+2.141`) for everyone else;
    `DNF`/`DSQ`/etc. when there's no time."""
    time: str
    points: float


class RaceResultsPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    year: int
    round: int
    name: str
    date: str
    results: list[RaceResultRow]


class SeasonPayload(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    year: int
    schedule: list[ScheduleRace]
    drivers: list[DriverStandingRow]
    constructors: list[ConstructorStandingRow]
    """Round number of the most recently completed race (0 if none yet)."""
    completed_rounds: int = Field(..., alias="completedRounds")
    """`true` when standings could not be fetched and a stub was returned."""
    is_stub: bool = Field(False, alias="isStub")
