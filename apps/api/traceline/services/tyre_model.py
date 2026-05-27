"""Linear tyre-degradation model (P4-2).

For each compound on a target circuit, fit:

    lap_time_s = α_driver + b·tyre_age + c·lap_norm + d·track_temp

via ordinary least squares — a per-driver intercept (`α_driver`) with
shared degradation coefficients. The first cut without per-driver
intercepts (pooled `α`) was biased ~50 s slow against the top-5 Hungary
finishers because the pool's average pace is well behind the leaders;
giving each driver their own intercept fixes that without leaving the
"linear baseline" envelope.

Features:
    - tyre_age  — primary degradation driver
    - lap_norm  — lap_number / total_laps as a fuel-burn proxy (cars get
                  faster as fuel decreases ~0.03 s/kg)
    - track_temp — softer compounds suffer more in heat; included so the
                  simulator can react to the actual race's conditions

NaN track_temp rows are dropped per-compound; if that leaves the compound
below MIN_SAMPLES we fall back to a 3-feature fit without temperature.
Drivers without enough samples for their own intercept fall back to the
pool-average intercept (preserved on `CompoundFit.intercept`).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


MIN_SAMPLES = 8
FEATURES = ("tyre_age_laps", "lap_norm", "track_temp_c")
FEATURES_NO_TEMP = ("tyre_age_laps", "lap_norm")


# Per-driver intercepts need at least this many of the driver's own laps on
# this compound; below the threshold we fall back to the pooled intercept.
MIN_DRIVER_SAMPLES = 4


@dataclass(frozen=True)
class CompoundFit:
    """Fitted coefficients + diagnostics for a single compound."""

    compound: str
    intercept: float  # pool-average intercept, used as fallback
    coef_tyre_age: float
    coef_lap_norm: float
    coef_track_temp: float | None  # None when the 3-feature fallback was used
    n_samples: int
    r_squared: float
    rmse: float
    driver_intercepts: dict[int, float] = field(default_factory=dict)

    def predict(
        self,
        tyre_age: float,
        lap_norm: float,
        track_temp: float | None,
        driver_num: int | None = None,
    ) -> float:
        """Predict lap time in seconds.

        `driver_num` selects the per-driver intercept; if the driver isn't
        in the training set, the pool-average intercept is used instead.
        `track_temp` is required iff the model was fit with the temperature
        feature (callers can check `coef_track_temp is not None`).
        """
        base = (
            self.driver_intercepts.get(driver_num, self.intercept)
            if driver_num is not None
            else self.intercept
        )
        v = base + self.coef_tyre_age * tyre_age + self.coef_lap_norm * lap_norm
        if self.coef_track_temp is not None:
            if track_temp is None:
                raise ValueError(
                    f"{self.compound} model needs track_temp; coef_track_temp is set"
                )
            v += self.coef_track_temp * track_temp
        return float(v)


@dataclass(frozen=True)
class TyreModel:
    """Bundle of per-compound fits for one circuit."""

    by_compound: dict[str, CompoundFit]

    def get(self, compound: str) -> CompoundFit | None:
        return self.by_compound.get(compound.upper())

    def compounds(self) -> list[str]:
        return list(self.by_compound.keys())


# --- fitting ---------------------------------------------------------------


def fit_linear_model(training_set: pd.DataFrame) -> TyreModel:
    """Fit a per-compound linear model from the training DataFrame.

    Skips compounds with fewer than MIN_SAMPLES rows after NaN-filtering.
    Caller should inspect the returned model's compounds() to know which
    ones were fitted.
    """
    if training_set.empty:
        return TyreModel(by_compound={})

    fits: dict[str, CompoundFit] = {}
    for compound, df in training_set.groupby("compound"):
        compound_u = str(compound).upper()
        fit = _fit_one_compound(compound_u, df)
        if fit is not None:
            fits[compound_u] = fit
    return TyreModel(by_compound=fits)


def _fit_one_compound(compound: str, df: pd.DataFrame) -> CompoundFit | None:
    # Prefer the 4-feature fit. Fall back to 3 features if temperature
    # data is sparse (or the column is missing entirely) — the temp
    # coefficient is the weakest of the three so dropping it costs the
    # least accuracy.
    has_temp = "track_temp_c" in df.columns
    if has_temp:
        full = df.dropna(subset=list(FEATURES) + ["lap_time_s"])
        if len(full) >= MIN_SAMPLES:
            return _ols(compound, full, list(FEATURES), with_temp=True)

    no_temp = df.dropna(subset=list(FEATURES_NO_TEMP) + ["lap_time_s"])
    if len(no_temp) >= MIN_SAMPLES:
        if has_temp:
            logger.info(
                "Compound %s: track_temp too sparse; falling back to 3-feature fit (n=%d)",
                compound,
                len(no_temp),
            )
        return _ols(compound, no_temp, list(FEATURES_NO_TEMP), with_temp=False)

    logger.warning(
        "Compound %s: %d rows after filtering — below MIN_SAMPLES (%d); skipping",
        compound,
        len(no_temp),
        MIN_SAMPLES,
    )
    return None


def _ols(
    compound: str, df: pd.DataFrame, feature_cols: list[str], *, with_temp: bool
) -> CompoundFit:
    """Fit `lap_time = α_driver + shared·features` via OLS.

    Drivers with `MIN_DRIVER_SAMPLES` or more rows in `df` get their own
    intercept column in the design matrix; everyone else is bucketed into
    a `_pool` column whose coefficient becomes the fallback intercept.
    Shared feature coefs (age, lap_norm, temp) come from the trailing
    columns of the LS solution.
    """
    y = df["lap_time_s"].to_numpy(dtype=float)
    feat = df[feature_cols].to_numpy(dtype=float)
    n = len(df)

    # Partition drivers into "own intercept" vs "pooled" by sample count.
    if "driver_num" in df.columns:
        counts = df["driver_num"].value_counts()
        own_intercept_drivers = sorted(int(d) for d, c in counts.items() if c >= MIN_DRIVER_SAMPLES)
    else:
        own_intercept_drivers = []

    pool_mask: np.ndarray | None = None
    indicator_cols: list[np.ndarray] = []
    for d in own_intercept_drivers:
        indicator_cols.append((df["driver_num"].to_numpy() == d).astype(float))
    if "driver_num" in df.columns and own_intercept_drivers:
        own_set = set(own_intercept_drivers)
        pool_mask = (~df["driver_num"].isin(own_set)).to_numpy()
    elif "driver_num" not in df.columns:
        # No driver column at all (legacy) — single pooled intercept.
        pool_mask = np.ones(n, dtype=bool)
    else:
        # All drivers got their own column; no pool category.
        pool_mask = None

    if pool_mask is not None and pool_mask.any():
        indicator_cols.append(pool_mask.astype(float))
        pool_col_idx = len(indicator_cols) - 1
    else:
        pool_col_idx = None

    if not indicator_cols:
        # Degenerate: no intercepts at all. Fall back to single intercept.
        indicator_cols = [np.ones(n)]
        pool_col_idx = 0

    indicator_block = np.column_stack(indicator_cols)
    X = np.column_stack([indicator_block, feat])

    coefs, _residuals, _rank, _sv = np.linalg.lstsq(X, y, rcond=None)
    y_pred = X @ coefs
    resid = y - y_pred
    ss_res = float(np.sum(resid * resid))
    ss_tot = float(np.sum((y - y.mean()) ** 2)) or 1.0
    r_squared = 1.0 - ss_res / ss_tot
    rmse = float(np.sqrt(ss_res / n))

    n_dummies = indicator_block.shape[1]
    driver_intercepts: dict[int, float] = {
        d: float(coefs[i]) for i, d in enumerate(own_intercept_drivers)
    }
    # Pool intercept (if it had its own column) — otherwise the mean of
    # per-driver intercepts is the best stand-in.
    if pool_col_idx is not None:
        pool_intercept = float(coefs[pool_col_idx])
    elif driver_intercepts:
        pool_intercept = float(np.mean(list(driver_intercepts.values())))
    else:
        pool_intercept = 0.0

    coef_age = float(coefs[n_dummies + 0])
    coef_lap = float(coefs[n_dummies + 1])
    coef_temp = float(coefs[n_dummies + 2]) if with_temp else None

    return CompoundFit(
        compound=compound,
        intercept=pool_intercept,
        driver_intercepts=driver_intercepts,
        coef_tyre_age=coef_age,
        coef_lap_norm=coef_lap,
        coef_track_temp=coef_temp,
        n_samples=n,
        r_squared=r_squared,
        rmse=rmse,
    )
