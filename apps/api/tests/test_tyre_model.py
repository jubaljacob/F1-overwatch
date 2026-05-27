"""Tests for the linear tyre model (P4-2).

Synthetic data with known coefficients lets us verify the OLS fit recovers
the underlying truth, and that fallbacks fire when expected.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from traceline.services.tyre_model import MIN_SAMPLES, fit_linear_model


def make_synthetic_laps(
    n: int,
    compound: str,
    intercept: float,
    age_coef: float,
    lap_coef: float,
    temp_coef: float | None,
    *,
    seed: int = 0,
    temp_nan_frac: float = 0.0,
    driver_num: int = 1,
) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ages = rng.uniform(0, 30, n)
    laps = rng.uniform(0, 1, n)
    temps = rng.uniform(25, 45, n)
    base = intercept + age_coef * ages + lap_coef * laps
    if temp_coef is not None:
        base = base + temp_coef * temps
    noise = rng.normal(0, 0.05, n)  # 50 ms-RMS noise, tighter than real data
    lap_times = base + noise

    rows = {
        "driver_num": [driver_num] * n,
        "compound": [compound] * n,
        "tyre_age_laps": ages,
        "lap_norm": laps,
        "track_temp_c": temps,
        "lap_time_s": lap_times,
    }
    df = pd.DataFrame(rows)
    if temp_nan_frac > 0:
        mask = rng.random(n) < temp_nan_frac
        df.loc[mask, "track_temp_c"] = float("nan")
    return df


def test_fit_recovers_known_coefficients_with_temp() -> None:
    """4-feature fit on noise-light synthetic data should recover ground truth
    within tight tolerances."""
    df = make_synthetic_laps(
        200, "SOFT", intercept=80.0, age_coef=0.08, lap_coef=-1.5, temp_coef=0.04, seed=1
    )
    model = fit_linear_model(df)
    fit = model.get("SOFT")
    assert fit is not None
    assert fit.intercept == pytest.approx(80.0, abs=0.1)
    assert fit.coef_tyre_age == pytest.approx(0.08, abs=0.005)
    assert fit.coef_lap_norm == pytest.approx(-1.5, abs=0.05)
    assert fit.coef_track_temp == pytest.approx(0.04, abs=0.01)
    assert fit.n_samples == 200
    assert fit.r_squared > 0.95
    assert fit.rmse < 0.1


def test_fit_falls_back_to_no_temp_when_temp_sparse() -> None:
    """If too few rows have non-NaN track_temp, the 3-feature fit kicks in
    and coef_track_temp is None on the returned fit."""
    df = make_synthetic_laps(
        50, "MEDIUM", intercept=82.0, age_coef=0.06, lap_coef=-1.2, temp_coef=0.0, seed=2,
        temp_nan_frac=0.95,
    )
    model = fit_linear_model(df)
    fit = model.get("MEDIUM")
    assert fit is not None
    assert fit.coef_track_temp is None
    assert fit.n_samples >= MIN_SAMPLES
    assert fit.intercept == pytest.approx(82.0, abs=0.5)


def test_fit_skips_compounds_with_too_few_rows() -> None:
    df = make_synthetic_laps(
        MIN_SAMPLES - 2,  # below threshold
        "HARD", intercept=84.0, age_coef=0.04, lap_coef=-1.0, temp_coef=0.03, seed=3,
    )
    model = fit_linear_model(df)
    assert model.get("HARD") is None
    assert "HARD" not in model.compounds()


def test_fit_handles_multiple_compounds_independently() -> None:
    soft = make_synthetic_laps(
        100, "SOFT", intercept=80.0, age_coef=0.10, lap_coef=-1.5, temp_coef=0.04, seed=4,
    )
    hard = make_synthetic_laps(
        100, "HARD", intercept=82.0, age_coef=0.03, lap_coef=-1.5, temp_coef=0.04, seed=5,
    )
    model = fit_linear_model(pd.concat([soft, hard], ignore_index=True))
    s_fit = model.get("SOFT")
    h_fit = model.get("HARD")
    assert s_fit is not None and h_fit is not None
    # Soft tyres degrade faster: should recover a noticeably larger age coef.
    assert s_fit.coef_tyre_age > h_fit.coef_tyre_age + 0.03


def test_predict_with_temp_model_requires_temp_arg() -> None:
    df = make_synthetic_laps(
        100, "SOFT", intercept=80.0, age_coef=0.08, lap_coef=-1.5, temp_coef=0.04, seed=6,
    )
    fit = fit_linear_model(df).get("SOFT")
    assert fit is not None
    with pytest.raises(ValueError):
        fit.predict(tyre_age=10, lap_norm=0.5, track_temp=None)


def test_predict_no_temp_model_ignores_temp_arg() -> None:
    df = make_synthetic_laps(
        80, "MEDIUM", intercept=82.0, age_coef=0.06, lap_coef=-1.2, temp_coef=0.0, seed=7,
        temp_nan_frac=0.95,
    )
    fit = fit_linear_model(df).get("MEDIUM")
    assert fit is not None
    assert fit.coef_track_temp is None
    # No crash, no temp contribution.
    v = fit.predict(tyre_age=5, lap_norm=0.5, track_temp=None)
    expected = fit.intercept + fit.coef_tyre_age * 5 + fit.coef_lap_norm * 0.5
    assert v == pytest.approx(expected)


def test_empty_training_set_yields_empty_model() -> None:
    model = fit_linear_model(pd.DataFrame())
    assert model.compounds() == []


def test_per_driver_intercepts_capture_pace_differences() -> None:
    """Two drivers with identical degradation but different base pace should
    end up with distinct intercepts and shared age/lap coefficients."""
    fast = make_synthetic_laps(
        80, "MEDIUM",
        intercept=80.0, age_coef=0.06, lap_coef=-1.5, temp_coef=None,
        seed=10, driver_num=1,
    )
    slow = make_synthetic_laps(
        80, "MEDIUM",
        intercept=81.0, age_coef=0.06, lap_coef=-1.5, temp_coef=None,
        seed=11, driver_num=44,
    )
    df = pd.concat([fast, slow], ignore_index=True)
    df = df.drop(columns=["track_temp_c"])  # force 3-feature fit
    fit = fit_linear_model(df).get("MEDIUM")
    assert fit is not None
    # Both drivers should have their own intercepts.
    assert 1 in fit.driver_intercepts
    assert 44 in fit.driver_intercepts
    # Fast driver's intercept ~1.0s below the slow driver's.
    assert fit.driver_intercepts[44] - fit.driver_intercepts[1] == pytest.approx(1.0, abs=0.1)
    # Shared degradation coefficient close to truth.
    assert fit.coef_tyre_age == pytest.approx(0.06, abs=0.01)


def test_predict_uses_driver_specific_intercept_when_available() -> None:
    fast = make_synthetic_laps(
        80, "MEDIUM",
        intercept=80.0, age_coef=0.06, lap_coef=-1.5, temp_coef=None,
        seed=12, driver_num=1,
    )
    slow = make_synthetic_laps(
        80, "MEDIUM",
        intercept=82.0, age_coef=0.06, lap_coef=-1.5, temp_coef=None,
        seed=13, driver_num=44,
    )
    df = pd.concat([fast, slow], ignore_index=True).drop(columns=["track_temp_c"])
    fit = fit_linear_model(df).get("MEDIUM")
    assert fit is not None
    p_fast = fit.predict(tyre_age=5, lap_norm=0.5, track_temp=None, driver_num=1)
    p_slow = fit.predict(tyre_age=5, lap_norm=0.5, track_temp=None, driver_num=44)
    # Slow driver should be ~2s slower for the same conditions.
    assert p_slow - p_fast == pytest.approx(2.0, abs=0.15)


def test_predict_falls_back_to_pool_intercept_for_unknown_driver() -> None:
    """A driver not in the training set uses the pool intercept (i.e.
    `fit.intercept`)."""
    df = make_synthetic_laps(
        50, "MEDIUM",
        intercept=80.0, age_coef=0.06, lap_coef=-1.5, temp_coef=None,
        seed=14, driver_num=1,
    ).drop(columns=["track_temp_c"])
    # Add a few rows for driver 44 below MIN_DRIVER_SAMPLES so they hit the pool.
    a_few = make_synthetic_laps(
        3, "MEDIUM",
        intercept=85.0, age_coef=0.06, lap_coef=-1.5, temp_coef=None,
        seed=15, driver_num=44,
    ).drop(columns=["track_temp_c"])
    df = pd.concat([df, a_few], ignore_index=True)
    fit = fit_linear_model(df).get("MEDIUM")
    assert fit is not None
    # Driver 44 didn't meet MIN_DRIVER_SAMPLES; predicting for them should use
    # the pool intercept (and 99 was never seen at all).
    p_known_pool = fit.predict(tyre_age=5, lap_norm=0.5, track_temp=None, driver_num=44)
    p_unknown = fit.predict(tyre_age=5, lap_norm=0.5, track_temp=None, driver_num=99)
    assert p_known_pool == pytest.approx(p_unknown)
