import type { Frame, RaceData } from "@traceline/shared-types";
import { beforeEach, describe, expect, it } from "vitest";
import { findFrameIndex, MAX_SELECTED_DRIVERS, usePlaybackStore } from "./playback-store";

function makeFrames(times: number[]): Frame[] {
  return times.map((t) => ({ t, p: {} }));
}

function makeRaceData(times: number[]): RaceData {
  return {
    meta: {
      year: 2024,
      round: 12,
      circuit: "Test",
      session_type: "R",
      total_laps: 1,
      frame_hz: 10,
      t_start: times[0] ?? 0,
      t_end: times[times.length - 1] ?? 0,
    },
    drivers: [],
    circuit: { name: "Test", track_length_m: 4000, centreline: [], cumulative_distance: [] },
    frames: makeFrames(times),
    laps: [],
  };
}

describe("findFrameIndex", () => {
  const frames = makeFrames([0, 0.1, 0.2, 0.3, 0.4]);

  it("returns 0 before the first frame", () => {
    expect(findFrameIndex(frames, -1)).toBe(0);
  });

  it("returns last index past the end", () => {
    expect(findFrameIndex(frames, 99)).toBe(4);
  });

  it("returns largest index with t <= target", () => {
    expect(findFrameIndex(frames, 0.25)).toBe(2);
    expect(findFrameIndex(frames, 0.3)).toBe(3);
  });

  it("handles exact matches", () => {
    expect(findFrameIndex(frames, 0.1)).toBe(1);
  });
});

describe("usePlaybackStore", () => {
  beforeEach(() => {
    usePlaybackStore.setState({
      raceData: null,
      currentTime: 0,
      isPlaying: false,
      speed: 1,
      selectedDrivers: [],
      referenceDriver: null,
      followedDriver: null,
    });
  });

  it("setRaceData snaps currentTime to t_start", () => {
    usePlaybackStore.getState().setRaceData(makeRaceData([10, 10.1, 10.2]));
    expect(usePlaybackStore.getState().currentTime).toBe(10);
    expect(usePlaybackStore.getState().isPlaying).toBe(false);
  });

  it("tick advances time scaled by speed", () => {
    const s = usePlaybackStore.getState();
    s.setRaceData(makeRaceData([0, 1, 2]));
    s.play();
    usePlaybackStore.setState({ speed: 2 });
    usePlaybackStore.getState().tick(0.5);
    expect(usePlaybackStore.getState().currentTime).toBeCloseTo(1.0);
  });

  it("tick pauses at t_end", () => {
    const s = usePlaybackStore.getState();
    s.setRaceData(makeRaceData([0, 1, 2]));
    s.play();
    usePlaybackStore.getState().tick(99);
    const after = usePlaybackStore.getState();
    expect(after.currentTime).toBe(2);
    expect(after.isPlaying).toBe(false);
  });

  it("play restarts from t_start when parked at the end", () => {
    const s = usePlaybackStore.getState();
    s.setRaceData(makeRaceData([5, 6, 7]));
    s.seek(7);
    s.play();
    expect(usePlaybackStore.getState().currentTime).toBe(5);
    expect(usePlaybackStore.getState().isPlaying).toBe(true);
  });

  it("seek clamps to bounds", () => {
    const s = usePlaybackStore.getState();
    s.setRaceData(makeRaceData([0, 1, 2]));
    s.seek(-10);
    expect(usePlaybackStore.getState().currentTime).toBe(0);
    s.seek(99);
    expect(usePlaybackStore.getState().currentTime).toBe(2);
  });

  it("toggleSelectedDriver adds, removes, and auto-sets reference", () => {
    const s = usePlaybackStore.getState();
    s.toggleSelectedDriver(1);
    expect(usePlaybackStore.getState().selectedDrivers).toEqual([1]);
    expect(usePlaybackStore.getState().referenceDriver).toBe(1);

    s.toggleSelectedDriver(44);
    expect(usePlaybackStore.getState().selectedDrivers).toEqual([1, 44]);
    expect(usePlaybackStore.getState().referenceDriver).toBe(1);

    // Re-toggling 1 removes it; reference promotes to the next remaining.
    s.toggleSelectedDriver(1);
    expect(usePlaybackStore.getState().selectedDrivers).toEqual([44]);
    expect(usePlaybackStore.getState().referenceDriver).toBe(44);
  });

  it("toggleSelectedDriver drops the oldest at the cap", () => {
    const s = usePlaybackStore.getState();
    for (let i = 1; i <= MAX_SELECTED_DRIVERS; i++) s.toggleSelectedDriver(i);
    expect(usePlaybackStore.getState().selectedDrivers.length).toBe(MAX_SELECTED_DRIVERS);

    s.toggleSelectedDriver(99);
    const out = usePlaybackStore.getState().selectedDrivers;
    expect(out.length).toBe(MAX_SELECTED_DRIVERS);
    expect(out[0]).toBe(2); // 1 dropped (oldest)
    expect(out[out.length - 1]).toBe(99);
    // The reference (1) was dropped by the cap; it should fall back to the
    // new first member to preserve the "reference ∈ selected" invariant.
    expect(usePlaybackStore.getState().referenceDriver).toBe(2);
  });

  it("setReferenceDriver only accepts members of the selection", () => {
    const s = usePlaybackStore.getState();
    s.toggleSelectedDriver(1);
    s.toggleSelectedDriver(44);
    s.setReferenceDriver(44);
    expect(usePlaybackStore.getState().referenceDriver).toBe(44);

    // Non-member is rejected, reference unchanged.
    s.setReferenceDriver(99);
    expect(usePlaybackStore.getState().referenceDriver).toBe(44);
  });

  it("clearSelection wipes both arrays", () => {
    const s = usePlaybackStore.getState();
    s.toggleSelectedDriver(1);
    s.toggleSelectedDriver(44);
    s.clearSelection();
    expect(usePlaybackStore.getState().selectedDrivers).toEqual([]);
    expect(usePlaybackStore.getState().referenceDriver).toBeNull();
  });

  it("setRaceData resets selection", () => {
    const s = usePlaybackStore.getState();
    s.toggleSelectedDriver(1);
    s.setRaceData(makeRaceData([0, 1, 2]));
    expect(usePlaybackStore.getState().selectedDrivers).toEqual([]);
    expect(usePlaybackStore.getState().referenceDriver).toBeNull();
  });

  it("toggleFollowedDriver toggles between a driver and null", () => {
    const s = usePlaybackStore.getState();
    s.toggleFollowedDriver(44);
    expect(usePlaybackStore.getState().followedDriver).toBe(44);
    s.toggleFollowedDriver(44);
    expect(usePlaybackStore.getState().followedDriver).toBeNull();
  });

  it("toggleFollowedDriver switches target rather than clearing", () => {
    const s = usePlaybackStore.getState();
    s.toggleFollowedDriver(44);
    s.toggleFollowedDriver(1);
    // 1 differs from current (44) so this is a re-target, not a clear.
    expect(usePlaybackStore.getState().followedDriver).toBe(1);
  });

  it("setRaceData clears followed driver", () => {
    const s = usePlaybackStore.getState();
    s.toggleFollowedDriver(44);
    s.setRaceData(makeRaceData([0, 1, 2]));
    expect(usePlaybackStore.getState().followedDriver).toBeNull();
  });
});
