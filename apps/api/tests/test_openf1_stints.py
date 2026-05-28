"""Tests for the OpenF1 lap → compound/tyre-age join via /stints.

OpenF1's /laps endpoint deliberately omits compound info; the truth lives
on /stints with lap_start/lap_end ranges. These tests pin the join logic
so the leaderboard's tyre badge actually gets data.
"""

from __future__ import annotations

from traceline.services.openf1_loader import (
    _build_lap_records_openf1,
    _compound_and_age_for_lap,
    _stints_by_driver,
)


def stint(driver: int, n: int, ls: int, le: int, compound: str, age_at_start: int) -> dict:
    return {
        "driver_number": driver,
        "stint_number": n,
        "lap_start": ls,
        "lap_end": le,
        "compound": compound,
        "tyre_age_at_start": age_at_start,
    }


def lap(driver: int, n: int) -> dict:
    return {
        "driver_number": driver,
        "lap_number": n,
        "lap_duration": 90.0,
        "duration_sector_1": 30.0,
        "duration_sector_2": 30.0,
        "duration_sector_3": 30.0,
    }


def test_stints_by_driver_sorts_by_lap_start() -> None:
    stints = [
        stint(1, 2, 25, 50, "HARD", 0),
        stint(1, 1, 1, 24, "MEDIUM", 0),
    ]
    grouped = _stints_by_driver(stints)
    assert [s["stint_number"] for s in grouped[1]] == [1, 2]


def test_compound_and_age_within_stint_range() -> None:
    # Stint 1: laps 1-15 on MEDIUM, started fresh (age 0 at fit).
    # Stint 2: laps 16-40 on HARD, started fresh.
    # Age is 1-indexed at end of lap, matching FastF1 TyreLife.
    stints = [
        stint(1, 1, 1, 15, "MEDIUM", 0),
        stint(1, 2, 16, 40, "HARD", 0),
    ]
    grouped = _stints_by_driver(stints)
    assert _compound_and_age_for_lap(grouped[1], 1) == ("MEDIUM", 1)
    assert _compound_and_age_for_lap(grouped[1], 10) == ("MEDIUM", 10)
    assert _compound_and_age_for_lap(grouped[1], 16) == ("HARD", 1)
    assert _compound_and_age_for_lap(grouped[1], 30) == ("HARD", 15)


def test_compound_carries_age_at_start_through_stint() -> None:
    """A driver who started on used tyres (e.g., qualifying-trim set with
    3 prior laps) has tyre_age_at_start = 3. Age on the first race lap of
    that stint = 3 + 1 = 4. On the fifth lap of the stint = 3 + 5 = 8."""
    stints = [stint(1, 1, 1, 20, "SOFT", 3)]
    grouped = _stints_by_driver(stints)
    assert _compound_and_age_for_lap(grouped[1], 1) == ("SOFT", 4)
    assert _compound_and_age_for_lap(grouped[1], 5) == ("SOFT", 8)


def test_compound_none_for_lap_outside_any_stint() -> None:
    stints = [stint(1, 1, 1, 10, "MEDIUM", 0)]
    grouped = _stints_by_driver(stints)
    assert _compound_and_age_for_lap(grouped[1], 50) == (None, None)


def test_build_lap_records_populates_compound_and_age() -> None:
    """End-to-end: a few laps + a couple of stints produce LapRecords with
    the right compound/age pair, not the (None, None) we used to ship."""
    laps_raw = [lap(1, 1), lap(1, 2), lap(1, 8), lap(1, 9)]
    stints_raw = [
        stint(1, 1, 1, 8, "MEDIUM", 0),
        stint(1, 2, 9, 30, "HARD", 0),
    ]
    # session_type="R" → quali classification skipped; t0 is unused when
    # there are no quali laps, so any datetime works.
    from datetime import datetime, timezone

    records = _build_lap_records_openf1(
        laps_raw, stints_raw, "R", datetime(2024, 1, 1, tzinfo=timezone.utc)
    )
    by_lap = {r.lap: r for r in records}
    assert by_lap[1].compound == "MEDIUM" and by_lap[1].tyre_age == 1
    assert by_lap[2].compound == "MEDIUM" and by_lap[2].tyre_age == 2
    assert by_lap[8].compound == "MEDIUM" and by_lap[8].tyre_age == 8
    assert by_lap[9].compound == "HARD" and by_lap[9].tyre_age == 1
