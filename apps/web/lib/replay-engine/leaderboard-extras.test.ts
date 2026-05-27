import type { Frame, LapRecord, RaceData } from "@traceline/shared-types";
import { describe, expect, it } from "vitest";

import {
  computeDriverExtras,
  computeStartingPositions,
  type SectorStatus,
} from "./leaderboard-extras";

function lap(
  driver: number,
  lapNum: number,
  s1: number | null,
  s2: number | null,
  s3: number | null,
  compound: string | null = "MEDIUM",
  tyreAge: number | null = 0,
): LapRecord {
  return {
    driver,
    lap: lapNum,
    lap_time_s: s1 != null && s2 != null && s3 != null ? s1 + s2 + s3 : null,
    sector_1_s: s1,
    sector_2_s: s2,
    sector_3_s: s3,
    compound,
    tyre_age: tyreAge,
    pit_in: false,
    pit_out: false,
  };
}

function makeRaceData(
  laps: LapRecord[],
  frames: Frame[] = [],
  options: { race_start_t?: number | null } = {},
): RaceData {
  return {
    meta: {
      year: 2024,
      round: 1,
      circuit: "Test",
      session_type: "R",
      total_laps: 50,
      frame_hz: 10,
      t_start: 0,
      t_end: 100,
      race_start_t: options.race_start_t,
    },
    drivers: [],
    circuit: { name: "Test", track_length_m: 3000, centreline: [], cumulative_distance: [] },
    frames,
    laps,
  };
}

function frame(t: number, positions: Record<number, { lap: number; d: number }>): Frame {
  const p: Frame["p"] = {};
  for (const [num, v] of Object.entries(positions)) {
    p[num] = {
      x: 0,
      y: 0,
      d: v.d,
      lap: v.lap,
      spd: 200,
      st: "on_track",
    };
  }
  return { t, p };
}

describe("computeStartingPositions", () => {
  it("ranks drivers by first frame's race-progress", () => {
    const data = makeRaceData(
      [],
      [
        frame(0, {
          1: { lap: 0, d: 50 },
          44: { lap: 0, d: 20 },
          16: { lap: 0, d: 10 },
        }),
      ],
    );
    const startPos = computeStartingPositions(data);
    expect(startPos.get(1)).toBe(1);
    expect(startPos.get(44)).toBe(2);
    expect(startPos.get(16)).toBe(3);
  });

  it("skips empty leading frames", () => {
    const data = makeRaceData(
      [],
      [
        { t: 0, p: {} },
        frame(1, {
          1: { lap: 0, d: 5 },
          44: { lap: 0, d: 10 },
        }),
      ],
    );
    const startPos = computeStartingPositions(data);
    expect(startPos.get(44)).toBe(1);
    expect(startPos.get(1)).toBe(2);
  });

  it("skips pre-race frames when race_start_t is set", () => {
    // Pre-race frame at t=0: driver 1 ahead by formation-lap quirk.
    // Race-start frame at t=100: driver 44 is actually leading.
    const data = makeRaceData(
      [],
      [
        frame(0, {
          1: { lap: 0, d: 100 },
          44: { lap: 0, d: 50 },
        }),
        frame(100, {
          1: { lap: 1, d: 50 },
          44: { lap: 1, d: 200 },
        }),
      ],
      { race_start_t: 100 },
    );
    const startPos = computeStartingPositions(data);
    expect(startPos.get(44)).toBe(1);
    expect(startPos.get(1)).toBe(2);
  });

  it("falls back to first available frame when race_start_t is missing", () => {
    const data = makeRaceData(
      [],
      [
        frame(0, {
          1: { lap: 0, d: 100 },
          44: { lap: 0, d: 50 },
        }),
      ],
      { race_start_t: null },
    );
    const startPos = computeStartingPositions(data);
    expect(startPos.get(1)).toBe(1);
    expect(startPos.get(44)).toBe(2);
  });
});

describe("computeDriverExtras — sector status colours", () => {
  it("purple goes to the session-fastest sector across all drivers", () => {
    // Driver 1 set the only sector times so far. Their S1 is by definition
    // the session-best -> purple.
    const data = makeRaceData([lap(1, 1, 28.0, 30.0, 26.0, "MEDIUM", 1)]);
    const f = frame(100, { 1: { lap: 2, d: 1500 } }); // lap 2, in S2
    const extras = computeDriverExtras(data, f, new Map([[1, 1]]));
    const e = extras.get(1)!;
    // We're in S2 of lap 2 — no current-lap row exists, so S1 comes from
    // last completed lap (lap 1).
    expect(e.sectorStatus[0]).toBe<SectorStatus>("purple");
    expect(e.sectorStatus[1]).toBe<SectorStatus>("purple");
    expect(e.sectorStatus[2]).toBe<SectorStatus>("purple");
  });

  it("green goes to drivers tied with the session-best on their personal-best", () => {
    // Driver 1 sets S1=28.0 (session best). Driver 44's most-recent S1=28.5
    // matches their own personal best but is slower than 28.0 → green.
    const data = makeRaceData([
      lap(1, 1, 28.0, 30.0, 26.0),
      lap(44, 1, 28.5, 30.5, 26.5),
    ]);
    const f = frame(100, {
      1: { lap: 2, d: 1500 },
      44: { lap: 2, d: 1500 },
    });
    const start = new Map([
      [1, 1],
      [44, 2],
    ]);
    const extras = computeDriverExtras(data, f, start);
    expect(extras.get(44)!.sectorStatus[0]).toBe<SectorStatus>("green");
    expect(extras.get(1)!.sectorStatus[0]).toBe<SectorStatus>("purple");
  });

  it("yellow when slower than driver's personal best", () => {
    // Driver 44: lap-1 S1=28.5 (PB). Lap-2 S1=29.0 (slower than PB → yellow).
    const data = makeRaceData([
      lap(44, 1, 28.5, 30.0, 26.0),
      lap(44, 2, 29.0, 30.2, 26.1),
    ]);
    // Past lap 2, currently in lap 3 sector 2.
    const f = frame(200, { 44: { lap: 3, d: 1500 } });
    const extras = computeDriverExtras(data, f, new Map([[44, 1]]));
    expect(extras.get(44)!.sectorStatus[0]).toBe<SectorStatus>("yellow");
  });
});

describe("computeDriverExtras — recent sector times update mid-lap", () => {
  it("uses last lap's S1 while driver is still in S1 of the new lap", () => {
    const data = makeRaceData([lap(1, 1, 28.0, 30.0, 26.0)]);
    // Lap 2, distance 500 (track 3000 → in S1).
    const f = frame(100, { 1: { lap: 2, d: 500 } });
    const e = computeDriverExtras(data, f, new Map([[1, 1]])).get(1)!;
    expect(e.recentSectorTimes[0]).toBe(28.0);
    expect(e.currentSector).toBe(1);
  });

  it("pulls current-lap S1 once driver has crossed into S2", () => {
    // Lap-1 S1 = 28.0; Lap-2 S1 = 27.5 (partial row).
    const data = makeRaceData([
      lap(1, 1, 28.0, 30.0, 26.0),
      lap(1, 2, 27.5, null, null, "MEDIUM", 1),
    ]);
    const f = frame(100, { 1: { lap: 2, d: 1500 } }); // in S2
    const e = computeDriverExtras(data, f, new Map([[1, 1]])).get(1)!;
    expect(e.recentSectorTimes[0]).toBe(27.5);
    expect(e.currentSector).toBe(2);
  });
});

describe("computeDriverExtras — pace delta", () => {
  it("returns null while in S1 of a lap", () => {
    const data = makeRaceData([lap(1, 1, 28.0, 30.0, 26.0)]);
    const f = frame(100, { 1: { lap: 2, d: 500 } }); // S1
    const e = computeDriverExtras(data, f, new Map([[1, 1]])).get(1)!;
    expect(e.paceDeltaVsLastLap).toBeNull();
  });

  it("delta after S1 = current_S1 - last_lap_S1", () => {
    const data = makeRaceData([
      lap(1, 1, 28.0, 30.0, 26.0),
      lap(1, 2, 27.5, null, null, "MEDIUM", 1),
    ]);
    const f = frame(100, { 1: { lap: 2, d: 1500 } });
    const e = computeDriverExtras(data, f, new Map([[1, 1]])).get(1)!;
    expect(e.paceDeltaVsLastLap).toBeCloseTo(-0.5);
  });

  it("delta after S2 = current(S1+S2) − last(S1+S2)", () => {
    const data = makeRaceData([
      lap(1, 1, 28.0, 30.0, 26.0),
      lap(1, 2, 27.5, 29.5, null, "MEDIUM", 1),
    ]);
    const f = frame(100, { 1: { lap: 2, d: 2500 } }); // S3
    const e = computeDriverExtras(data, f, new Map([[1, 1]])).get(1)!;
    expect(e.paceDeltaVsLastLap).toBeCloseTo(27.5 + 29.5 - 28.0 - 30.0);
  });
});

describe("computeDriverExtras — tyre + pit", () => {
  it("reads tyre compound/age from the current in-progress lap row when present", () => {
    const data = makeRaceData([
      lap(1, 1, 28.0, 30.0, 26.0, "MEDIUM", 1),
      lap(1, 2, null, null, null, "HARD", 0),
    ]);
    const f = frame(100, { 1: { lap: 2, d: 500 } });
    const e = computeDriverExtras(data, f, new Map([[1, 1]])).get(1)!;
    expect(e.tyreCompound).toBe("HARD");
    expect(e.tyreAge).toBe(0);
  });

  it("falls back to the last completed lap if the current lap row is missing", () => {
    const data = makeRaceData([lap(1, 1, 28.0, 30.0, 26.0, "MEDIUM", 1)]);
    const f = frame(100, { 1: { lap: 2, d: 500 } });
    const e = computeDriverExtras(data, f, new Map([[1, 1]])).get(1)!;
    expect(e.tyreCompound).toBe("MEDIUM");
    expect(e.tyreAge).toBe(1);
  });

  it("counts pit stops as compound changes in lap history", () => {
    const data = makeRaceData([
      lap(1, 1, null, null, null, "MEDIUM", 1),
      lap(1, 2, null, null, null, "MEDIUM", 2),
      lap(1, 3, null, null, null, "HARD", 0), // pit 1
      lap(1, 4, null, null, null, "HARD", 1),
      lap(1, 5, null, null, null, "SOFT", 0), // pit 2
    ]);
    const f = frame(100, { 1: { lap: 6, d: 100 } });
    const e = computeDriverExtras(data, f, new Map([[1, 1]])).get(1)!;
    expect(e.pitStops).toBe(2);
  });
});

describe("computeDriverExtras — position change", () => {
  it("positive when driver moved up from grid", () => {
    const data = makeRaceData([
      lap(1, 1, 28.0, 30.0, 26.0),
      lap(44, 1, 28.5, 30.5, 26.5),
    ]);
    // Started: 44 first, 1 second. Now 1 is leading.
    const start = new Map([
      [44, 1],
      [1, 2],
    ]);
    const f = frame(100, {
      1: { lap: 2, d: 2000 },
      44: { lap: 2, d: 1000 },
    });
    const extras = computeDriverExtras(data, f, start);
    expect(extras.get(1)!.positionChange).toBe(1); // gained 1
    expect(extras.get(44)!.positionChange).toBe(-1); // lost 1
  });
});
