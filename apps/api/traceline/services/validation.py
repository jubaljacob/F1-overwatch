"""Leaderboard accuracy harness for P2 acceptance.

We compare F1Overwatch's per-frame leaderboard order against FastF1's official
end-of-lap `Position` field — that's the authoritative ground truth.

Sampling strategy: for each driver D and each completed lap L, we pick the
frame closest to the lap-end timestamp (`Time` column on the FastF1 lap row).
At that instant, the official sheet says D finished lap L in position P_off,
and our renderer would show D at position P_pred. We score per-sample as
|P_pred - P_off| and aggregate.

Why end-of-lap rather than every frame: FastF1 doesn't publish a continuous
ground-truth position track. The lap-end position is the only point at which
the official classification is unambiguous, so that's where we measure.

The acceptance metric per PROJECT_PLAN P2 is "within ±1 position for >99% of
samples across 5 diverse races". `score_race` returns that fraction.
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd

from traceline.schemas.session import RaceData
from traceline.services.leaderboard import leaderboard_at_time


@dataclass(frozen=True)
class PositionSample:
    driver: int
    lap: int
    t: float
    predicted: int
    official: int

    @property
    def error(self) -> int:
        return abs(self.predicted - self.official)


@dataclass(frozen=True)
class RaceScore:
    year: int
    round_: int
    samples: list[PositionSample]

    @property
    def n(self) -> int:
        return len(self.samples)

    def fraction_within(self, tolerance: int = 1) -> float:
        if not self.samples:
            return 0.0
        ok = sum(1 for s in self.samples if s.error <= tolerance)
        return ok / self.n

    def mean_abs_error(self) -> float:
        if not self.samples:
            return 0.0
        return sum(s.error for s in self.samples) / self.n

    def worst(self, k: int = 5) -> list[PositionSample]:
        return sorted(self.samples, key=lambda s: -s.error)[:k]


def extract_official_positions(session) -> pd.DataFrame:
    """Return a DataFrame with columns: driver_number, lap, time_s, position.

    `time_s` is the FastF1 `Time` column converted to session-time seconds —
    the moment that lap ended for that driver. Skips laps with missing data.
    """
    laps = session.laps
    if laps is None or laps.empty:
        return pd.DataFrame(columns=["driver_number", "lap", "time_s", "position"])
    out = pd.DataFrame(
        {
            "driver_number": pd.to_numeric(laps["DriverNumber"], errors="coerce"),
            "lap": pd.to_numeric(laps["LapNumber"], errors="coerce"),
            "time_s": laps["Time"].dt.total_seconds(),
            "position": pd.to_numeric(laps.get("Position"), errors="coerce"),
        }
    )
    out = out.dropna(subset=["driver_number", "lap", "time_s", "position"])
    out = out.astype({"driver_number": int, "lap": int, "position": int})
    return out


def score_race(race_data: RaceData, official: pd.DataFrame, year: int, round_: int) -> RaceScore:
    """Compute per-(driver, lap) position error and aggregate."""
    samples: list[PositionSample] = []
    # Build a lookup: driver number → set of (lap, t, position).
    # Iterating once over the DataFrame is cheap relative to building frames.
    for row in official.itertuples(index=False):
        t = float(row.time_s)
        ordered = leaderboard_at_time(race_data, t)
        if not ordered:
            continue
        try:
            predicted_pos = ordered.index(int(row.driver_number)) + 1
        except ValueError:
            # Driver isn't in the frame (e.g., already retired in our payload
            # but FastF1 still has a lap row). Skip rather than penalise.
            continue
        samples.append(
            PositionSample(
                driver=int(row.driver_number),
                lap=int(row.lap),
                t=t,
                predicted=predicted_pos,
                official=int(row.position),
            )
        )
    return RaceScore(year=year, round_=round_, samples=samples)


def format_report(score: RaceScore) -> str:
    """Single-race human-readable summary."""
    lines = [
        f"=== {score.year} R{score.round_} — {score.n} samples ===",
        f"  within ±1 : {score.fraction_within(1) * 100:6.2f}%   "
        f"(acceptance: >99%)",
        f"  within ±2 : {score.fraction_within(2) * 100:6.2f}%",
        f"  exact     : {score.fraction_within(0) * 100:6.2f}%",
        f"  MAE       : {score.mean_abs_error():.3f} positions",
    ]
    worst = score.worst(5)
    if worst:
        lines.append("  worst samples:")
        for s in worst:
            lines.append(
                f"    driver={s.driver:>3} lap={s.lap:>2} "
                f"pred={s.predicted:>2} off={s.official:>2} |d|={s.error}"
            )
    return "\n".join(lines)
