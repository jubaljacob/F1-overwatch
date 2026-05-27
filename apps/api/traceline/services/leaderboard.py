"""Python port of the TS leaderboard sort.

Order key: `lap * track_length_m + lap_distance` — must stay in lockstep with
`apps/web/lib/replay-engine/leaderboard.ts`. The validation harness depends on
this returning the *same* order the browser would render.

Only position order is computed here; gap-to-leader/ahead are renderer concerns
and don't affect the P2 accuracy metric.
"""

from __future__ import annotations

from bisect import bisect_right

from traceline.schemas.session import Frame, RaceData


def find_frame_index(frames: list[Frame], t: float) -> int:
    """Largest index with frames[i].t <= t. Mirrors the TS binary search."""
    if not frames:
        return -1
    if t <= frames[0].t:
        return 0
    # frames are emitted in increasing t order by compute_race_data.
    times = [f.t for f in frames]
    idx = bisect_right(times, t) - 1
    return max(0, min(idx, len(frames) - 1))


def leaderboard_at_time(race_data: RaceData, t: float) -> list[int]:
    """Return driver numbers in race-order at time `t`. Out cars are dropped."""
    idx = find_frame_index(race_data.frames, t)
    if idx < 0:
        return []
    return leaderboard_at_frame(race_data, race_data.frames[idx])


def leaderboard_at_frame(race_data: RaceData, frame: Frame) -> list[int]:
    """Same as leaderboard_at_time but for an already-resolved frame."""
    meta = race_data.meta
    # P2 race-end override: past the chequered flag, race-progress trails are
    # noisy and uninformative. Lock to the official classification.
    if (
        meta.race_end_t is not None
        and meta.final_classification
        and frame.t >= meta.race_end_t
    ):
        return [num for num, _ in sorted(meta.final_classification.items(), key=lambda kv: kv[1])]

    track_len = race_data.circuit.track_length_m or 1.0
    scored: list[tuple[float, int]] = []
    for num, sample in frame.p.items():
        if sample.st == "out":
            continue
        progress = sample.lap * track_len + sample.d
        scored.append((progress, num))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [num for _, num in scored]
