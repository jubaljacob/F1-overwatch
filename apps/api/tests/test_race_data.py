"""Unit tests for the RaceData pure helpers.

These cover the numpy-level building blocks without touching FastF1 — that
keeps CI fast and deterministic. End-to-end validation against a real session
lives in the P1 acceptance harness, not here.
"""

from __future__ import annotations

import numpy as np
import pytest
from scipy.spatial import cKDTree

from traceline.services.race_data import (
    _apply_pit_freeze,
    _assemble_frames,
    _DriverArrays,
    _project_to_centreline,
)


def _square_centreline(side: float = 100.0, n: int = 400) -> tuple[np.ndarray, np.ndarray]:
    """A closed unit-square centreline at constant spacing — easy to reason about."""
    per_side = n // 4
    s = np.linspace(0.0, side, per_side, endpoint=False)
    edges = [
        np.column_stack([s, np.zeros_like(s)]),
        np.column_stack([np.full_like(s, side), s]),
        np.column_stack([side - s, np.full_like(s, side)]),
        np.column_stack([np.zeros_like(s), side - s]),
    ]
    xy = np.vstack(edges)
    xy = np.vstack([xy, xy[0]])
    segs = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    cum = np.concatenate(([0.0], np.cumsum(segs)))
    return xy, cum


def test_project_to_centreline_corner_and_midpoint() -> None:
    xy, cum = _square_centreline(side=100.0)
    tree = cKDTree(xy)
    pts_x = np.array([0.0, 50.0, 100.0, 50.0])
    pts_y = np.array([0.0, 0.0, 50.0, 100.0])
    d = _project_to_centreline(pts_x, pts_y, tree, cum, 400.0, centreline=xy)
    # Segment projection is exact on a dense polyline; tolerance well under 1m.
    assert d[0] == pytest.approx(0.0, abs=0.01)
    assert d[1] == pytest.approx(50.0, abs=0.01)
    assert d[2] == pytest.approx(150.0, abs=0.01)
    assert d[3] == pytest.approx(250.0, abs=0.01)


def test_project_to_centreline_handles_nan() -> None:
    xy, cum = _square_centreline()
    tree = cKDTree(xy)
    x = np.array([10.0, np.nan, 20.0])
    y = np.array([0.0, 0.0, 0.0])
    d = _project_to_centreline(x, y, tree, cum, 400.0, centreline=xy)
    assert not np.isnan(d[0])
    assert np.isnan(d[1])
    assert not np.isnan(d[2])


def test_project_to_centreline_empty_centreline() -> None:
    out = _project_to_centreline(np.array([1.0]), np.array([1.0]), None, np.array([]), 0.0)
    assert out.shape == (1,)
    assert out[0] == 0.0


def _sparse_square_centreline() -> tuple[np.ndarray, np.ndarray]:
    """Closed 1000x1000 square with only the 4 corners as vertices. Each side
    is 1000m long, total perimeter 4000m. This is intentionally sparse so the
    nearest-vertex baseline gives obviously-wrong distances on side midpoints,
    while segment projection should be exact."""
    xy = np.array(
        [[0.0, 0.0], [1000.0, 0.0], [1000.0, 1000.0], [0.0, 1000.0], [0.0, 0.0]]
    )
    segs = np.linalg.norm(np.diff(xy, axis=0), axis=1)
    cum = np.concatenate(([0.0], np.cumsum(segs)))
    return xy, cum


def test_segment_projection_interpolates_between_sparse_vertices() -> None:
    """Vertex snapping would give 0 or 1000 for a point at the midpoint of the
    bottom side; segment projection gives the exact midpoint distance."""
    xy, cum = _sparse_square_centreline()
    tree = cKDTree(xy)
    x = np.array([500.0, 1000.0, 500.0])  # bottom mid, right bottom corner, top mid
    y = np.array([0.0, 500.0, 1000.0])
    d = _project_to_centreline(x, y, tree, cum, float(cum[-1]), centreline=xy)
    assert d[0] == pytest.approx(500.0, abs=0.01)
    assert d[1] == pytest.approx(1500.0, abs=0.01)
    assert d[2] == pytest.approx(2500.0, abs=0.01)


def test_segment_projection_handles_perpendicular_offset() -> None:
    """A point off the polyline projects to the foot-of-perpendicular. With
    sparse vertices on a square, the nearest-vertex answer would be far off."""
    xy, cum = _sparse_square_centreline()
    tree = cKDTree(xy)
    # Point inside the square, 50m above the bottom side at x=300. Foot is at
    # (300, 0), distance 300. Nearest vertex would be (0, 0) at distance ~304.
    d = _project_to_centreline(
        np.array([300.0]), np.array([50.0]), tree, cum, float(cum[-1]), centreline=xy
    )
    assert d[0] == pytest.approx(300.0, abs=0.01)


def test_segment_projection_clamps_at_corners() -> None:
    """A point whose perpendicular foot falls outside both adjacent segments
    should clamp to the shared corner vertex, not extrapolate past it."""
    xy, cum = _sparse_square_centreline()
    tree = cKDTree(xy)
    # Point well outside the bottom-right corner. Should clamp at (1000, 0).
    d = _project_to_centreline(
        np.array([1100.0]), np.array([-100.0]), tree, cum, float(cum[-1]), centreline=xy
    )
    assert d[0] == pytest.approx(1000.0, abs=0.01)


def _make_driver(number: int, n: int, lap: int = 1, status: int = 0) -> _DriverArrays:
    t = np.linspace(0.0, 1.0, n)
    return _DriverArrays(
        number=number,
        t=t,
        x=np.linspace(0.0, 100.0, n),
        y=np.zeros(n),
        z=np.full(n, np.nan),
        spd=np.full(n, 250.0),
        gear=np.full(n, 6, dtype=int),
        thr=np.full(n, 100.0),
        brk=np.zeros(n),
        drs=np.zeros(n, dtype=bool),
        lap=np.full(n, lap, dtype=int),
        status=np.full(n, status, dtype=int),
        d=np.linspace(0.0, 1000.0, n),
    )


def test_assemble_frames_basic_shape() -> None:
    times = np.linspace(0.0, 1.0, 5)
    per_driver = {1: _make_driver(1, 5), 44: _make_driver(44, 5)}
    frames = _assemble_frames(times, per_driver)
    assert len(frames) == 5
    assert set(frames[0].p.keys()) == {1, 44}
    assert frames[0].p[1].spd == pytest.approx(250.0)
    assert frames[2].p[44].lap == 1


def test_assemble_frames_skips_nan_driver_samples() -> None:
    times = np.linspace(0.0, 1.0, 3)
    a = _make_driver(1, 3)
    a.x[1] = np.nan
    frames = _assemble_frames(times, {1: a})
    # Frame at index 1 has the only driver NaN'd out — it should be dropped.
    assert len(frames) == 2
    assert all(1 in f.p for f in frames)


def test_pit_freeze_interpolates_across_window() -> None:
    """Pit window of 3 frames between (lap=2, d=900) and (lap=3, d=100) on a
    1000m track. Race-progress at the brackets is 2900 and 3100, so the freeze
    should fill the window with linear values: 2950, 3000, 3050."""
    track = 1000.0
    d = np.array([900.0, 0.0, 0.0, 0.0, 100.0])
    lap = np.array([2, 2, 2, 2, 3])
    status = np.array([0, 1, 1, 1, 0])
    d_out, lap_out = _apply_pit_freeze(d, lap, status, track)
    # Pre and post frames untouched.
    assert d_out[0] == 900.0 and lap_out[0] == 2
    assert d_out[4] == 100.0 and lap_out[4] == 3
    # Interior race-progress 2950, 3000, 3050 → (lap, d) = (2, 950), (3, 0), (3, 50).
    assert (lap_out[1], d_out[1]) == (2, pytest.approx(950.0))
    assert (lap_out[2], d_out[2]) == (3, pytest.approx(0.0))
    assert (lap_out[3], d_out[3]) == (3, pytest.approx(50.0))


def test_pit_freeze_holds_last_value_when_retired_in_pit() -> None:
    """No post-pit frame: car retired in the pit lane. Race-progress should
    hold at the last on-track value rather than extrapolate."""
    d = np.array([800.0, 0.0, 0.0])
    lap = np.array([5, 5, 5])
    status = np.array([0, 1, 1])
    d_out, lap_out = _apply_pit_freeze(d, lap, status, 1000.0)
    assert (lap_out[1], d_out[1]) == (5, 800.0)
    assert (lap_out[2], d_out[2]) == (5, 800.0)


def test_pit_freeze_mirrors_post_when_no_pre_frame() -> None:
    """Session starts with the car already in pit (rare). Window should adopt
    the first post-pit values rather than be left at zero."""
    d = np.array([0.0, 0.0, 50.0])
    lap = np.array([0, 0, 1])
    status = np.array([1, 1, 0])
    d_out, lap_out = _apply_pit_freeze(d, lap, status, 1000.0)
    assert (lap_out[0], d_out[0]) == (1, 50.0)
    assert (lap_out[1], d_out[1]) == (1, 50.0)


def test_pit_freeze_no_op_without_any_pit_frames() -> None:
    d = np.array([100.0, 200.0, 300.0])
    lap = np.array([1, 1, 1])
    status = np.array([0, 0, 0])
    d_out, lap_out = _apply_pit_freeze(d, lap, status, 1000.0)
    np.testing.assert_array_equal(d_out, d)
    np.testing.assert_array_equal(lap_out, lap)


def test_pit_freeze_handles_multiple_windows() -> None:
    """Two independent pit windows in the same driver array."""
    track = 1000.0
    d = np.array([100.0, 0.0, 200.0, 0.0, 300.0])
    lap = np.array([1, 1, 2, 2, 3])
    status = np.array([0, 1, 0, 1, 0])
    d_out, lap_out = _apply_pit_freeze(d, lap, status, track)
    # First window: bracket (lap=1,d=100)→(lap=2,d=200) progress 1100→2200
    # midpoint = 1650 → (lap=1, d=650)
    assert (lap_out[1], d_out[1]) == (1, pytest.approx(650.0))
    # Second window: bracket (lap=2,d=200)→(lap=3,d=300) progress 2200→3300
    # midpoint = 2750 → (lap=2, d=750)
    assert (lap_out[3], d_out[3]) == (2, pytest.approx(750.0))


def test_assemble_frames_propagates_status_names() -> None:
    times = np.linspace(0.0, 1.0, 2)
    pit = _make_driver(1, 2, status=1)
    out = _make_driver(2, 2, status=2)
    frames = _assemble_frames(times, {1: pit, 2: out})
    assert frames[0].p[1].st == "pit"
    assert frames[0].p[2].st == "out"
