"""Optimal-strategy estimator (P4-5).

Brute-force enumerates plausible 1-stop and 2-stop strategies and scores
each via the strategy simulator. Returns the top-K by predicted total
race time.

Constraints reflect F1 race-strategy norms rather than the regulations
in detail:
    - Pit window: laps 8..total_laps-3. Earlier than lap 8 means racing
      under the safety of a fresh first stint; later than total_laps-3
      makes little sense unless you're chasing a fastest-lap point.
    - Compounds: only those the tyre model has fits for. Out-of-grid
      compounds (WET, INTERMEDIATE) are excluded — those are weather
      decisions, not strategy ones.
    - F1 regulation: in dry races you must use at least two different
      compounds. We enforce that by requiring each stint's compound to
      differ from the immediately-prior stint's compound. (A "use at
      least two unique compounds across the whole race" check is also
      applied at the strategy level.)
    - Search is exhaustive over the constrained domain. With ~50 laps
      and 3 compounds, 1-stop ~120 options, 2-stop ~7000 options;
      completes in well under a second per driver.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from itertools import combinations, product

from traceline.services.strategy_sim import (
    DEFAULT_PIT_PENALTY_S,
    PitStop,
    SimulationResult,
    StrategyInput,
    simulate_strategy,
)
from traceline.services.tyre_model import TyreModel

logger = logging.getLogger(__name__)


# Search-space defaults.
DEFAULT_PIT_WINDOW_START_LAP = 8
DEFAULT_PIT_WINDOW_END_OFFSET = 3  # last pit lap = total_laps - this
DRY_COMPOUNDS = ("SOFT", "MEDIUM", "HARD")


@dataclass(frozen=True)
class RankedStrategy:
    rank: int
    strategy: StrategyInput
    result: SimulationResult


def find_optimal_strategies(
    *,
    driver_num: int,
    tyre_model: TyreModel,
    other_driver_totals_s: dict[int, float],
    total_laps: int,
    track_temp_c: float | None,
    pit_penalty_s: float = DEFAULT_PIT_PENALTY_S,
    top_k: int = 3,
    include_two_stops: bool = True,
    actual_total_race_time_s: float | None = None,
    actual_finishing_position: int | None = None,
) -> list[RankedStrategy]:
    """Enumerate 1-stop (and optionally 2-stop) strategies, return the top K
    ranked by predicted total race time (lower = better)."""
    available = tuple(c for c in DRY_COMPOUNDS if tyre_model.get(c) is not None)
    if len(available) < 2:
        raise ValueError(
            f"Need at least 2 fitted dry compounds for optimal-strategy search; "
            f"got {available}"
        )

    pit_laps = range(
        DEFAULT_PIT_WINDOW_START_LAP, total_laps - DEFAULT_PIT_WINDOW_END_OFFSET + 1
    )

    strategies: list[StrategyInput] = []
    strategies.extend(_enumerate_one_stops(available, pit_laps))
    if include_two_stops:
        strategies.extend(_enumerate_two_stops(available, pit_laps))

    logger.info("Optimal-strategy search: %d candidates", len(strategies))

    scored: list[tuple[StrategyInput, SimulationResult]] = []
    for strat in strategies:
        try:
            result = simulate_strategy(
                driver_num=driver_num,
                strategy=strat,
                tyre_model=tyre_model,
                other_driver_totals_s=other_driver_totals_s,
                total_laps=total_laps,
                track_temp_c=track_temp_c,
                pit_penalty_s=pit_penalty_s,
                actual_total_race_time_s=actual_total_race_time_s,
                actual_finishing_position=actual_finishing_position,
            )
        except Exception as e:  # defensive: a missing compound fit, etc.
            logger.debug("Strategy %s skipped: %s", strat, e)
            continue
        scored.append((strat, result))

    scored.sort(key=lambda pair: pair[1].total_race_time_s)
    return [
        RankedStrategy(rank=i + 1, strategy=strat, result=result)
        for i, (strat, result) in enumerate(scored[:top_k])
    ]


def _enumerate_one_stops(
    compounds: tuple[str, ...], pit_laps: range
) -> list[StrategyInput]:
    out: list[StrategyInput] = []
    # Pick two *different* compounds for the two stints (dry-race regulation).
    for start_c, second_c in product(compounds, repeat=2):
        if start_c == second_c:
            continue
        for pit_lap in pit_laps:
            out.append(
                StrategyInput(
                    starting_compound=start_c,
                    pit_stops=(PitStop(lap=pit_lap, new_compound=second_c),),
                )
            )
    return out


def _enumerate_two_stops(
    compounds: tuple[str, ...], pit_laps: range
) -> list[StrategyInput]:
    out: list[StrategyInput] = []
    laps_list = list(pit_laps)
    # Choose two distinct pit laps (lap1 < lap2). We also require a minimum
    # stint length of 5 laps between stops — anything shorter is unrealistic.
    min_stint = 5
    for lap1, lap2 in combinations(laps_list, 2):
        if lap2 - lap1 < min_stint:
            continue
        # Compound sequence c1 -> c2 -> c3 with c2 != c1 and c3 != c2.
        # We allow c1 == c3 (legitimate strategies like H-M-H exist).
        for c1, c2, c3 in product(compounds, repeat=3):
            if c1 == c2 or c2 == c3:
                continue
            # Regulation: at least two unique compounds used overall.
            # Already guaranteed by c1 != c2 and c2 != c3, but include it
            # explicitly for the "all three same" guard.
            if len({c1, c2, c3}) < 2:
                continue
            out.append(
                StrategyInput(
                    starting_compound=c1,
                    pit_stops=(
                        PitStop(lap=lap1, new_compound=c2),
                        PitStop(lap=lap2, new_compound=c3),
                    ),
                )
            )
    return out
