"""Assemble the SeasonPayload for the landing dashboard.

Pulls schedule + driver/constructor standings from Jolpi, normalises team
names so they match the frontend's team-colour map, and maps Jolpi's
`circuitId` to our internal `circuitKey` so the track-sketch component
works without changes.
"""

from __future__ import annotations

import logging
from typing import Any

from traceline.schemas.season import (
    ConstructorStandingRow,
    DriverStandingRow,
    RaceResultRow,
    RaceResultsPayload,
    ScheduleRace,
    SeasonPayload,
)
from traceline.services.jolpi_client import JolpiClient, JolpiError

logger = logging.getLogger(__name__)

# Jolpi `circuitId` → our internal slug (matches apps/web/lib/track-paths.ts).
# Anything not in this map falls through to the circuitId itself, which is
# fine for the calendar (the TrackSketch falls back to a generic loop).
CIRCUIT_ID_MAP: dict[str, str] = {
    "bahrain": "bahrain",
    "jeddah": "jeddah",
    "albert_park": "melbourne",
    "suzuka": "suzuka",
    "miami": "miami",
    "monaco": "monaco",
    "catalunya": "barcelona",
    "red_bull_ring": "redbullring",
    "silverstone": "silverstone",
    "hungaroring": "hungaroring",
    "spa": "spa",
    "zandvoort": "zandvoort",
    "monza": "monza",
    "baku": "baku",
    "marina_bay": "singapore",
    "americas": "austin",
    "rodriguez": "mexico",
    "interlagos": "interlagos",
    "las_vegas": "lasvegas",
    "losail": "lusail",
    "yas_marina": "yasmarina",
    "imola": "imola",
    "shanghai": "shanghai",
    "ricard": "paulricard",
    "portimao": "portimao",
}

# Jolpi constructor names → our display name. Jolpi uses long-form names
# ("Red Bull" but also historically "Red Bull Racing"); we normalise to
# the short form the team-colour map keys on.
TEAM_NAME_MAP: dict[str, str] = {
    "Red Bull": "Red Bull",
    "Red Bull Racing": "Red Bull",
    "Ferrari": "Ferrari",
    "McLaren": "McLaren",
    "Mercedes": "Mercedes",
    "Aston Martin": "Aston Martin",
    "Alpine F1 Team": "Alpine",
    "Alpine": "Alpine",
    "Haas F1 Team": "Haas",
    "Haas": "Haas",
    "Williams": "Williams",
    "RB F1 Team": "Racing Bulls",
    "Racing Bulls": "Racing Bulls",
    "AlphaTauri": "Racing Bulls",
    "Kick Sauber": "Audi",
    "Sauber": "Audi",
    "Audi": "Audi",
    "Cadillac": "Cadillac",
    "Cadillac F1 Team": "Cadillac",
}


def _normalise_team(name: str) -> str:
    return TEAM_NAME_MAP.get(name, name)


def _circuit_key_for(circuit_id: str) -> str:
    return CIRCUIT_ID_MAP.get(circuit_id, circuit_id)


def _short_name(jolpi_name: str) -> str:
    """`Australian Grand Prix` → `Australian GP`. Keeps the dashboard tidy."""
    if jolpi_name.endswith(" Grand Prix"):
        return jolpi_name[: -len(" Grand Prix")] + " GP"
    return jolpi_name


def _parse_schedule(races: list[dict[str, Any]]) -> list[ScheduleRace]:
    out: list[ScheduleRace] = []
    for r in races:
        try:
            circuit = r["Circuit"]
            out.append(
                ScheduleRace(
                    round=int(r["round"]),
                    name=_short_name(r.get("raceName", "")),
                    location=str(circuit.get("Location", {}).get("locality", "")),
                    circuit_key=_circuit_key_for(str(circuit.get("circuitId", ""))),
                    date=str(r.get("date", "")),
                )
            )
        except (KeyError, ValueError, TypeError) as e:
            logger.warning("skipping malformed Jolpi race row: %s", e)
    return out


def _parse_drivers(standings: list[dict[str, Any]]) -> list[DriverStandingRow]:
    out: list[DriverStandingRow] = []
    for s in standings:
        try:
            drv = s["Driver"]
            cons = s.get("Constructors", [{}])[0] if s.get("Constructors") else {}
            out.append(
                DriverStandingRow(
                    position=int(s["position"]),
                    name=f"{drv.get('givenName', '').strip()} {drv.get('familyName', '').strip()}".strip(),
                    team=_normalise_team(str(cons.get("name", ""))),
                    points=float(s.get("points", 0)),
                    wins=int(s.get("wins", 0)),
                )
            )
        except (KeyError, ValueError, TypeError) as e:
            logger.warning("skipping malformed Jolpi driver row: %s", e)
    return out


def _parse_constructors(standings: list[dict[str, Any]]) -> list[ConstructorStandingRow]:
    out: list[ConstructorStandingRow] = []
    for s in standings:
        try:
            cons = s["Constructor"]
            out.append(
                ConstructorStandingRow(
                    position=int(s["position"]),
                    team=_normalise_team(str(cons.get("name", ""))),
                    chassis=None,
                    points=float(s.get("points", 0)),
                )
            )
        except (KeyError, ValueError, TypeError) as e:
            logger.warning("skipping malformed Jolpi constructor row: %s", e)
    return out


def fetch_race_results(year: int, round_: int) -> RaceResultsPayload:
    """Top finishers for a single completed race. Empty results list if the
    race hasn't happened yet or upstream returned nothing."""
    with JolpiClient() as client:
        try:
            races = client.schedule(year)
        except JolpiError:
            races = []
        try:
            results_raw = client.race_results(year, round_)
        except JolpiError as e:
            logger.warning("Jolpi results fetch failed for %d/%d: %s", year, round_, e)
            results_raw = []

    name = ""
    date = ""
    for r in races:
        try:
            if int(r.get("round", 0)) == round_:
                name = _short_name(str(r.get("raceName", "")))
                date = str(r.get("date", ""))
                break
        except (ValueError, TypeError):
            continue

    rows: list[RaceResultRow] = []
    for s in results_raw:
        try:
            drv = s["Driver"]
            cons = s.get("Constructor", {})
            # Time vs status: winner has Time.time, non-winners have a gap
            # under the same field, retirees have status="Retired" etc.
            time_field = s.get("Time", {}).get("time") if isinstance(s.get("Time"), dict) else None
            status = str(s.get("status", ""))
            display_time = time_field or status or "—"
            rows.append(
                RaceResultRow(
                    position=int(s["position"]),
                    name=f"{drv.get('givenName', '').strip()} {drv.get('familyName', '').strip()}".strip(),
                    team=_normalise_team(str(cons.get("name", ""))),
                    time=display_time,
                    points=float(s.get("points", 0)),
                )
            )
        except (KeyError, ValueError, TypeError) as e:
            logger.warning("skipping malformed result row: %s", e)

    return RaceResultsPayload(year=year, round=round_, name=name, date=date, results=rows)


def fetch_season(year: int) -> SeasonPayload:
    """Build the SeasonPayload for `year`. Best-effort — if standings can't
    be fetched we still return the schedule (or an empty payload) with
    `is_stub=True` so the caller can fall back gracefully."""
    with JolpiClient() as client:
        try:
            races = client.schedule(year)
        except JolpiError as e:
            logger.warning("Jolpi schedule fetch failed for %d: %s", year, e)
            races = []

        try:
            dr_round, dr_rows = client.driver_standings(year)
        except JolpiError as e:
            logger.warning("Jolpi driverStandings fetch failed for %d: %s", year, e)
            dr_round, dr_rows = 0, []

        try:
            cr_round, cr_rows = client.constructor_standings(year)
        except JolpiError as e:
            logger.warning("Jolpi constructorStandings fetch failed for %d: %s", year, e)
            cr_round, cr_rows = 0, []

    schedule = _parse_schedule(races)
    drivers = _parse_drivers(dr_rows)
    constructors = _parse_constructors(cr_rows)
    is_stub = not (schedule or drivers or constructors)

    return SeasonPayload(
        year=year,
        schedule=schedule,
        drivers=drivers,
        constructors=constructors,
        completed_rounds=max(dr_round, cr_round),
        is_stub=is_stub,
    )
