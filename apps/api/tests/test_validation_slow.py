"""End-to-end leaderboard accuracy check against one real race.

Slow — depends on FastF1 cache being warm (1-3 min cold). Skipped by default;
run with `uv run pytest -m slow` to include. CI can opt in once we have a
predictable cache strategy.
"""

from __future__ import annotations

import pytest

from traceline.services.fastf1_loader import load_session
from traceline.services.race_data import compute_race_data
from traceline.services.validation import extract_official_positions, score_race

# Reference race for the smoke check: clean dry weekend, no safety car.
# This is the "everything should already work" baseline for P2 — if this one
# scores poorly, fix it before tackling the harder cases (Monaco, wet, SC).
REFERENCE = (2024, 12)


@pytest.mark.slow
def test_leaderboard_accuracy_hungary_2024() -> None:
    year, round_ = REFERENCE
    session = load_session(year, round_, "R", with_telemetry=True)
    race_data = compute_race_data(year, round_, "R")
    official = extract_official_positions(session)
    score = score_race(race_data, official, year, round_)

    assert score.n > 100, "expected at least 100 (driver, lap) samples"
    # Baseline (nearest-vertex P1 sort) typically scores 75-90% here; the bar
    # for P2 is >99%. We assert the *current* floor so regressions trip the
    # test even before the full P2 work lands. Bump to 0.99 once P2 ships.
    within_1 = score.fraction_within(1)
    assert within_1 >= 0.70, (
        f"leaderboard accuracy regressed: within-±1 = {within_1:.3f} < 0.70\n"
        f"worst samples:\n  " + "\n  ".join(repr(s) for s in score.worst(10))
    )
