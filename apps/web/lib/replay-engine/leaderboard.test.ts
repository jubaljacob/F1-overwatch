import type { Frame, RaceData } from "@traceline/shared-types";
import { describe, expect, it } from "vitest";
import { computeLeaderboard } from "./leaderboard";

const drivers = [
  { number: 1, code: "VER", full_name: "M Verstappen", team: "RBR", team_colour: "1E5BC6" },
  { number: 44, code: "HAM", full_name: "L Hamilton", team: "MER", team_colour: "00D2BE" },
  { number: 16, code: "LEC", full_name: "C Leclerc", team: "FER", team_colour: "DC0000" },
];

function frame(
  positions: Record<number, { lap: number; d: number; st?: "on_track" | "pit" | "out" }>,
): Frame {
  return {
    t: 0,
    p: Object.fromEntries(
      Object.entries(positions).map(([k, v]) => [
        k,
        {
          x: 0,
          y: 0,
          d: v.d,
          lap: v.lap,
          spd: 0,
          st: v.st ?? "on_track",
        },
      ]),
    ),
  };
}

const data: RaceData = {
  meta: {
    year: 2024,
    round: 12,
    circuit: "Test",
    session_type: "R",
    total_laps: 70,
    frame_hz: 10,
    t_start: 0,
    t_end: 1,
  },
  drivers,
  circuit: { name: "Test", track_length_m: 1000, centreline: [], cumulative_distance: [] },
  frames: [],
  laps: [],
};

describe("computeLeaderboard", () => {
  const lookup = new Map(drivers.map((d) => [d.number, d]));

  it("sorts by lap * L + lapDistance", () => {
    const f = frame({
      1: { lap: 5, d: 500 },
      44: { lap: 5, d: 800 },
      16: { lap: 6, d: 100 },
    });
    const rows = computeLeaderboard(data, f, lookup);
    expect(rows.map((r) => r.driver.code)).toEqual(["LEC", "HAM", "VER"]);
    expect(rows[0]?.position).toBe(1);
  });

  it("converts race-progress gap to seconds using fallback pace", () => {
    // No lap records → fallback speed = L / 90 = 1000/90 m/s.
    // Gap of 400 m → 400 / (1000/90) = 36 s.
    const f = frame({ 1: { lap: 1, d: 0 }, 44: { lap: 0, d: 600 } });
    const rows = computeLeaderboard(data, f, lookup);
    expect(rows[0]?.driver.code).toBe("VER");
    expect(rows[1]?.gapToLeader).toBeCloseTo(36, 3);
  });

  it("computes gap-to-ahead per row", () => {
    const f = frame({
      1: { lap: 2, d: 0 }, // leader at race-progress 2000
      44: { lap: 1, d: 800 }, // 200 m behind leader
      16: { lap: 1, d: 200 }, // 600 m behind HAM
    });
    const rows = computeLeaderboard(data, f, lookup);
    expect(rows[0]?.gapToAhead).toBe(0);
    // fallback speed = 1000/90 m/s
    expect(rows[1]?.gapToAhead).toBeCloseTo(200 / (1000 / 90), 3);
    expect(rows[2]?.gapToAhead).toBeCloseTo(600 / (1000 / 90), 3);
  });

  it("keeps pit cars in the order but flags status", () => {
    const f = frame({
      1: { lap: 3, d: 0, st: "pit" },
      44: { lap: 2, d: 950 },
    });
    const rows = computeLeaderboard(data, f, lookup);
    expect(rows[0]?.driver.code).toBe("VER");
    expect(rows[0]?.status).toBe("pit");
  });

  it("returns empty for null frame", () => {
    expect(computeLeaderboard(data, null, lookup)).toEqual([]);
  });

  it("uses final_classification past race_end_t", () => {
    const overridden: RaceData = {
      ...data,
      meta: {
        ...data.meta,
        race_end_t: 100,
        final_classification: { "16": 1, "1": 2, "44": 3 },
      },
    };
    // Raw progress would put VER first; override should put LEC first.
    const fOverride: Frame = {
      t: 150,
      p: {
        1: { x: 0, y: 0, d: 900, lap: 5, spd: 0, st: "on_track" },
        44: { x: 0, y: 0, d: 500, lap: 5, spd: 0, st: "on_track" },
        16: { x: 0, y: 0, d: 100, lap: 5, spd: 0, st: "on_track" },
      },
    };
    const rows = computeLeaderboard(overridden, fOverride, lookup);
    expect(rows.map((r) => r.driver.code)).toEqual(["LEC", "VER", "HAM"]);
  });

  it("ignores final_classification before race_end_t", () => {
    const overridden: RaceData = {
      ...data,
      meta: {
        ...data.meta,
        race_end_t: 100,
        final_classification: { "16": 1, "1": 2, "44": 3 },
      },
    };
    const fBefore: Frame = {
      t: 50,
      p: {
        1: { x: 0, y: 0, d: 900, lap: 5, spd: 0, st: "on_track" },
        44: { x: 0, y: 0, d: 500, lap: 5, spd: 0, st: "on_track" },
        16: { x: 0, y: 0, d: 100, lap: 5, spd: 0, st: "on_track" },
      },
    };
    const rows = computeLeaderboard(overridden, fBefore, lookup);
    expect(rows.map((r) => r.driver.code)).toEqual(["VER", "HAM", "LEC"]);
  });
});
