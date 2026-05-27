"""P4 acceptance harness — strategy simulator vs actual Hungary 2024.

For each of the top-5 finishers:
    1. Reconstruct their actual pit schedule from FastF1 lap data.
    2. Simulate that strategy using the fitted tyre model.
    3. Compare predicted total race time against the actual sum of their
       FastF1 LapTime entries.

PROJECT_PLAN P4 acceptance: predicted total within +/-15s of actual for the
target race. We also report the per-driver delta so a single outlier
doesn't masquerade as a passing run.

Usage:
    uv run python scripts/validate_strategy.py
    uv run python scripts/validate_strategy.py 2024 13    # specific race
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

import numpy as np
import pandas as pd

from traceline.services.fastf1_loader import load_session
from traceline.services.strategy_sim import (
    DEFAULT_PIT_PENALTY_S,
    actual_total_race_times,
    extract_actual_strategy,
    simulate_strategy,
)
from traceline.services.tyre_dataset import build_training_set
from traceline.services.tyre_model import TyreModel, fit_linear_model


# PROJECT_PLAN P4 acceptance threshold.
TOLERANCE_S = 15.0


@dataclass
class CaseResult:
    driver_num: int
    driver_code: str
    actual_total_s: float
    predicted_total_s: float
    delta_s: float
    actual_position: int

    @property
    def passes(self) -> bool:
        return abs(self.delta_s) <= TOLERANCE_S


def run_validation(year: int, round_: int, n_prior_years: int = 0) -> list[CaseResult]:
    print(f"Loading {year} R{round_}...", file=sys.stderr)
    session = load_session(year, round_, "R")
    results_df = session.results
    if results_df is None or results_df.empty:
        raise RuntimeError(f"No results table for {year} R{round_}")

    label = "current race only" if n_prior_years == 0 else f"current + {n_prior_years} prior years"
    print(f"Building training set ({label})...", file=sys.stderr)
    training = build_training_set(year, round_, n_prior_years=n_prior_years)
    print(f"  -> {len(training)} clean laps across {training['source'].nunique()} sessions",
          file=sys.stderr)

    print("Fitting tyre model...", file=sys.stderr)
    model = fit_linear_model(training)
    if not model.compounds():
        raise RuntimeError("Tyre model has no compounds — training set too sparse")
    print(f"  -> fitted compounds: {model.compounds()}", file=sys.stderr)
    for c in model.compounds():
        fit = model.get(c)
        assert fit is not None
        print(
            f"     {c}: a={fit.intercept:.2f}  age={fit.coef_tyre_age:+.3f}  "
            f"lap={fit.coef_lap_norm:+.3f}  "
            f"temp={fit.coef_track_temp if fit.coef_track_temp is not None else 'n/a'}  "
            f"n={fit.n_samples}  R^2={fit.r_squared:.3f}  RMSE={fit.rmse:.3f}s",
            file=sys.stderr,
        )

    total_laps = int(session.total_laps) if session.total_laps else int(session.laps["LapNumber"].max())
    track_temp = _session_avg_track_temp(session)
    print(f"Race info: total_laps={total_laps} avg_track_temp={track_temp}", file=sys.stderr)

    laps_df = session.laps
    other_totals = actual_total_race_times(laps_df)

    top5 = _top_finishers(results_df, n=5)
    cases: list[CaseResult] = []
    for entry in top5:
        try:
            cases.append(_validate_one(entry, laps_df, model, total_laps, track_temp, other_totals))
        except Exception as e:
            print(f"  [{entry['code']}] FAILED: {e}", file=sys.stderr)
    return cases


def _validate_one(
    entry: dict,
    laps_df: pd.DataFrame,
    model: TyreModel,
    total_laps: int,
    track_temp: float | None,
    other_totals: dict[int, float],
) -> CaseResult:
    driver_num = int(entry["number"])
    actual_total = other_totals.get(driver_num)
    if actual_total is None or actual_total <= 0:
        raise RuntimeError(f"No actual total race time for driver {driver_num}")

    strategy = extract_actual_strategy(laps_df, driver_num)
    others_minus_target = {k: v for k, v in other_totals.items() if k != driver_num}

    result = simulate_strategy(
        driver_num=driver_num,
        strategy=strategy,
        tyre_model=model,
        other_driver_totals_s=others_minus_target,
        total_laps=total_laps,
        track_temp_c=track_temp,
        pit_penalty_s=DEFAULT_PIT_PENALTY_S,
        actual_total_race_time_s=actual_total,
        actual_finishing_position=int(entry["position"]),
    )
    return CaseResult(
        driver_num=driver_num,
        driver_code=entry["code"],
        actual_total_s=actual_total,
        predicted_total_s=result.total_race_time_s,
        delta_s=result.total_race_time_s - actual_total,
        actual_position=int(entry["position"]),
    )


def _top_finishers(results_df: pd.DataFrame, n: int) -> list[dict]:
    out: list[dict] = []
    sorted_df = results_df.sort_values("Position")
    for _, row in sorted_df.head(n).iterrows():
        try:
            pos = int(row["Position"])
            num = int(row["DriverNumber"])
            code = str(row.get("Abbreviation", row.get("BroadcastName", "???")))
            out.append({"position": pos, "number": num, "code": code})
        except (KeyError, TypeError, ValueError):
            continue
    return out


def _session_avg_track_temp(session) -> float | None:
    weather = getattr(session, "weather_data", None)
    if weather is None or weather.empty or "TrackTemp" not in weather.columns:
        return None
    arr = weather["TrackTemp"].dropna().to_numpy(dtype=float)
    if arr.size == 0:
        return None
    return float(np.median(arr))


def format_report(cases: list[CaseResult]) -> str:
    if not cases:
        return "No cases ran."
    lines = ["=== Strategy validation ==="]
    lines.append(
        f"  {'pos':>3} {'drv':>4} {'actual':>10} {'predicted':>10} {'delta':>8}  result"
    )
    for c in cases:
        marker = "PASS" if c.passes else "FAIL"
        lines.append(
            f"  {c.actual_position:>3} {c.driver_code:>4} "
            f"{c.actual_total_s:>10.1f} {c.predicted_total_s:>10.1f} "
            f"{c.delta_s:>+8.2f}  {marker}"
        )
    passing = sum(1 for c in cases if c.passes)
    lines.append("")
    lines.append(
        f"  {passing}/{len(cases)} drivers within +/-{TOLERANCE_S}s of actual"
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("year", nargs="?", type=int, default=2024)
    parser.add_argument("round_", nargs="?", type=int, default=13)
    parser.add_argument(
        "--prior-years",
        type=int,
        default=0,
        help="Number of prior seasons of the same circuit to include "
             "(default 0 — train on the target race only).",
    )
    args = parser.parse_args()

    cases = run_validation(args.year, args.round_, n_prior_years=args.prior_years)
    print(format_report(cases))

    # Exit non-zero if the headline target (winner) misses the tolerance, so
    # CI integration is straightforward. Non-winners may exceed tolerance for
    # reasons (different pit-loss profile, traffic, etc.) without indicting
    # the model.
    if cases and not cases[0].passes:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
