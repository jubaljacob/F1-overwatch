"""Lap-by-lap strategy simulator (P4-3).

Given a target driver's alternate pit schedule, replays the race for that
driver only — predicting each lap's time from the tyre model and tracking
tyre age across stints — while holding every other driver's actual lap
times fixed. Returns predicted total race time, per-lap predictions, and
the predicted finishing position derived by sorting against other drivers'
actual cumulative times.

Pit stops add a fixed penalty (default 22 s) on the pit-stop lap; that's
the typical real-world delta between an in-lap and a regular racing lap on
permanent circuits. Per-circuit refinements come with P6.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import pandas as pd

from traceline.services.tyre_model import TyreModel

logger = logging.getLogger(__name__)


DEFAULT_PIT_PENALTY_S = 22.0


@dataclass(frozen=True)
class Stint:
    """One stretch of laps on a single set of tyres."""

    compound: str
    start_lap: int  # inclusive, 1-indexed
    end_lap: int  # inclusive


@dataclass(frozen=True)
class PitStop:
    """One pit stop in the schedule. `lap` is the lap on which the driver
    enters the pit. `new_compound` is what they fit on the next stint."""

    lap: int
    new_compound: str


@dataclass(frozen=True)
class StrategyInput:
    """Full strategy specification for the target driver."""

    starting_compound: str
    pit_stops: tuple[PitStop, ...]

    def stints(self, total_laps: int) -> list[Stint]:
        """Expand the pit-stops into a list of stints covering all `total_laps`."""
        stints: list[Stint] = []
        current_compound = self.starting_compound.upper()
        current_start = 1
        for stop in sorted(self.pit_stops, key=lambda s: s.lap):
            stints.append(
                Stint(compound=current_compound, start_lap=current_start, end_lap=stop.lap)
            )
            current_compound = stop.new_compound.upper()
            current_start = stop.lap + 1
        if current_start <= total_laps:
            stints.append(
                Stint(compound=current_compound, start_lap=current_start, end_lap=total_laps)
            )
        return stints


@dataclass(frozen=True)
class LapPrediction:
    """One simulated lap's outcome for the target driver."""

    lap: int
    compound: str
    tyre_age: int
    predicted_lap_time_s: float
    pit_stop: bool  # True iff this lap incurred the pit penalty


@dataclass(frozen=True)
class SimulationResult:
    """Output of one strategy simulation."""

    driver_num: int
    total_race_time_s: float
    finishing_position: int
    laps: tuple[LapPrediction, ...]
    actual_total_race_time_s: float | None
    actual_finishing_position: int | None

    @property
    def delta_to_actual_s(self) -> float | None:
        if self.actual_total_race_time_s is None:
            return None
        return self.total_race_time_s - self.actual_total_race_time_s


# --- top-level API ---------------------------------------------------------


def simulate_strategy(
    *,
    driver_num: int,
    strategy: StrategyInput,
    tyre_model: TyreModel,
    other_driver_totals_s: dict[int, float],
    total_laps: int,
    track_temp_c: float | None,
    pit_penalty_s: float = DEFAULT_PIT_PENALTY_S,
    actual_total_race_time_s: float | None = None,
    actual_finishing_position: int | None = None,
) -> SimulationResult:
    """Run the simulator for one driver/strategy.

    `other_driver_totals_s` is the cumulative race-time-to-finish for every
    other driver at the end of the race (from FastF1's results / lap sums).
    The predicted finishing position is just the rank of the target's
    predicted total against those.
    """
    laps = _predict_laps(
        driver_num=driver_num,
        strategy=strategy,
        tyre_model=tyre_model,
        total_laps=total_laps,
        track_temp_c=track_temp_c,
        pit_penalty_s=pit_penalty_s,
    )
    total_s = sum(lap.predicted_lap_time_s for lap in laps)

    # Predicted finishing position = 1 + (number of other drivers whose total
    # race time is strictly less than the predicted total). Ties resolve by
    # keeping the target behind on the assumption real-world tie-breaks
    # rarely favour the simulated-only driver.
    faster = sum(1 for v in other_driver_totals_s.values() if v < total_s)
    position = faster + 1

    return SimulationResult(
        driver_num=driver_num,
        total_race_time_s=total_s,
        finishing_position=position,
        laps=tuple(laps),
        actual_total_race_time_s=actual_total_race_time_s,
        actual_finishing_position=actual_finishing_position,
    )


def _predict_laps(
    *,
    driver_num: int,
    strategy: StrategyInput,
    tyre_model: TyreModel,
    total_laps: int,
    track_temp_c: float | None,
    pit_penalty_s: float,
) -> list[LapPrediction]:
    pit_laps = {s.lap for s in strategy.pit_stops}
    out: list[LapPrediction] = []
    for stint in strategy.stints(total_laps):
        fit = tyre_model.get(stint.compound)
        if fit is None:
            raise StrategySimulatorError(
                f"No tyre-model fit for compound {stint.compound!r} — "
                f"can't simulate this strategy. Either pick a different compound or "
                f"widen the training set."
            )
        for lap_no in range(stint.start_lap, stint.end_lap + 1):
            tyre_age = lap_no - stint.start_lap  # 0 on the first lap of the stint
            temp_arg = track_temp_c if fit.coef_track_temp is not None else None
            predicted = fit.predict(
                tyre_age=tyre_age,
                lap_norm=lap_no / max(1, total_laps),
                track_temp=temp_arg,
                driver_num=driver_num,
            )
            penalty = pit_penalty_s if lap_no in pit_laps else 0.0
            out.append(
                LapPrediction(
                    lap=lap_no,
                    compound=stint.compound,
                    tyre_age=tyre_age,
                    predicted_lap_time_s=predicted + penalty,
                    pit_stop=lap_no in pit_laps,
                )
            )
    return out


# --- extracting actuals from a FastF1 session for validation ----------------


def extract_actual_strategy(laps: pd.DataFrame, driver_num: int) -> StrategyInput:
    """Reconstruct a driver's actual pit schedule from FastF1 lap data.

    Reads the Compound field per lap; a compound change between consecutive
    laps marks a pit stop. The pit_lap is the LAST lap on the prior compound
    (the in-lap), matching the convention used by `_predict_laps` (penalty
    applied on the in-lap).
    """
    driver_laps = (
        laps[laps["DriverNumber"].astype(str) == str(driver_num)]
        .dropna(subset=["LapNumber", "Compound"])
        .sort_values("LapNumber")
    )
    if driver_laps.empty:
        raise StrategySimulatorError(
            f"No laps found for driver {driver_num} when extracting actual strategy"
        )

    compounds = driver_laps["Compound"].astype(str).str.upper().tolist()
    lap_numbers = driver_laps["LapNumber"].astype(int).tolist()

    starting_compound = compounds[0]
    pit_stops: list[PitStop] = []
    for i in range(1, len(compounds)):
        if compounds[i] != compounds[i - 1]:
            pit_stops.append(PitStop(lap=lap_numbers[i - 1], new_compound=compounds[i]))

    return StrategyInput(
        starting_compound=starting_compound, pit_stops=tuple(pit_stops)
    )


def actual_total_race_times(laps: pd.DataFrame) -> dict[int, float]:
    """For each driver, sum their actual LapTime across the race.

    Drivers with missing LapTime on any lap (DNF mid-lap) are still summed
    over their completed laps; they'll lose to anyone who finished. Useful
    for ranking the simulated driver against the actual field.
    """
    out: dict[int, float] = {}
    for driver_num_raw, group in laps.groupby("DriverNumber"):
        try:
            driver_num = int(driver_num_raw)
        except (TypeError, ValueError):
            continue
        times = group["LapTime"].dropna()
        if times.empty:
            continue
        total = float(times.dt.total_seconds().sum())
        out[driver_num] = total
    return out


class StrategySimulatorError(RuntimeError):
    """Raised when the simulator can't proceed (e.g., missing compound fit)."""
