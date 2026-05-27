import type { Frame, LapRecord, RaceData } from "@traceline/shared-types";

/** Derived per-driver metrics that the leaderboard renders alongside the
 *  raw frame data: tyre + age, last/best lap times, sector status colours,
 *  running pace delta vs last lap, pit-stop count, position-change vs start.
 *
 *  Sector status follows the F1 broadcast convention:
 *    - `"purple"` — the most recent sector time set by this driver is the
 *                   fastest *anyone* has set in that sector so far this race
 *    - `"green"`  — personal best in that sector (driver's own quickest)
 *    - `"yellow"` — slower than this driver's personal best for that sector
 *    - `null`     — driver hasn't completed that sector even once
 *
 *  Colours roll over as the driver crosses each sector line — for example,
 *  while the driver is *in* their lap-5 S1, the S1 bar still reflects their
 *  most recent lap-4 S1 time. Once they cross the S1 line of lap 5, the S1
 *  bar updates to reflect the just-completed lap-5 S1.
 */
export type SectorStatus = "purple" | "green" | "yellow";

export interface DriverExtras {
  tyreCompound: string | null;
  /** Laps completed on the current tyre set. */
  tyreAge: number | null;
  /** Most recently completed lap's total time. */
  lastLapTime: number | null;
  /** Per-driver fastest lap time across all completed laps so far. */
  bestLapTime: number | null;
  /** Most-recent sector time per sector + its broadcast colour. Index 0=S1. */
  recentSectorTimes: [number | null, number | null, number | null];
  sectorStatus: [SectorStatus | null, SectorStatus | null, SectorStatus | null];
  /** Sector the driver is currently in (1–3) based on lap distance. */
  currentSector: 1 | 2 | 3;
  /** Running delta vs last lap, summed across already-completed sectors of
   *  the current in-progress lap. null until S1 of the current lap is done. */
  paceDeltaVsLastLap: number | null;
  /** Number of pit stops completed (compound changes in lap history). */
  pitStops: number;
  /** Positions gained (+) or lost (−) since the first racing frame. */
  positionChange: number;
}

export type DriverExtrasMap = Map<number, DriverExtras>;

/** Build per-driver extras for the current frame.
 *
 *  Returns an empty map when raceData has no laps; otherwise one entry per
 *  driver present in the frame.
 */
export function computeDriverExtras(
  raceData: RaceData,
  frame: Frame | null,
  startingPositions: ReadonlyMap<number, number>,
): DriverExtrasMap {
  const out: DriverExtrasMap = new Map();
  if (!frame) return out;

  // Bucket laps per driver, sorted ascending — used for sector PBs, last/best,
  // tyre lookups, pit-stop counting.
  const lapsByDriver = bucketLapsByDriver(raceData.laps);

  // Session-best sector time per sector across all drivers, *up to* the
  // current race progress so the replay's history matches what was known
  // at that moment. Approximated by capping at the leader's current lap.
  const leaderLap = leaderLapAtFrame(frame);
  const sessionBests = buildSessionBests(lapsByDriver, leaderLap);

  // The leaderboard ranks drivers by `lap * track_len + d`. For positions
  // at frame `t` we walk the same key.
  const currentOrder = orderByRaceProgress(frame, raceData.circuit.track_length_m);

  const trackLen = raceData.circuit.track_length_m || 1;
  for (const [driverNumStr, sample] of Object.entries(frame.p)) {
    const driver = Number(driverNumStr);
    const driverLaps = lapsByDriver.get(driver) ?? [];
    const currentLap = sample.lap;
    const currentSector = sectorFromDistance(sample.d, trackLen);

    // Lap rows: the current in-progress lap row (may carry partial sector
    // data once sectors are crossed) + the most recent fully-completed lap.
    const currentLapRow = driverLaps.find((l) => l.lap === currentLap) ?? null;
    const completedLaps = driverLaps.filter((l) => l.lap < currentLap);
    const lastLap = completedLaps.length
      ? completedLaps[completedLaps.length - 1]!
      : null;

    const tyreCompound = currentLapRow?.compound ?? lastLap?.compound ?? null;
    const tyreAge = currentLapRow?.tyre_age ?? lastLap?.tyre_age ?? null;

    const recentSectorTimes = mostRecentSectorTimes(
      currentLapRow,
      completedLaps,
      currentSector,
    );

    const personalBestSectors = computePersonalBestSectors(completedLaps);
    const sectorStatus = colourSectors(
      recentSectorTimes,
      personalBestSectors,
      sessionBests,
    );

    const bestLapTime = completedLaps
      .map((l) => l.lap_time_s)
      .filter((v): v is number => v != null && v > 0)
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);

    const paceDeltaVsLastLap = computePaceDelta(currentLapRow, lastLap, currentSector);
    const pitStops = countPitStops(driverLaps, currentLap);

    const currentPos = currentOrder.get(driver) ?? 0;
    const startPos = startingPositions.get(driver) ?? currentPos;
    const positionChange = startPos - currentPos; // positive = gained places

    out.set(driver, {
      tyreCompound,
      tyreAge,
      lastLapTime: lastLap?.lap_time_s ?? null,
      bestLapTime: Number.isFinite(bestLapTime) ? bestLapTime : null,
      recentSectorTimes,
      sectorStatus,
      currentSector,
      paceDeltaVsLastLap,
      pitStops,
      positionChange,
    });
  }
  return out;
}

/** Race-start positions, derived from the first frame at or after the
 *  lights-out moment (`raceData.meta.race_start_t`). Before that timestamp
 *  the data covers the parc-fermé / grid-walk / formation lap, where cars
 *  are stationary in arbitrary order and "position" is meaningless — using
 *  any of those frames as the baseline made the gained/lost arrow lie.
 *
 *  When `race_start_t` is missing (non-race sessions, or data shortfalls),
 *  we fall back to the first frame with any driver data so the field is
 *  populated rather than empty.
 */
export function computeStartingPositions(raceData: RaceData): Map<number, number> {
  const raceStart = raceData.meta.race_start_t ?? null;
  for (const frame of raceData.frames) {
    if (Object.keys(frame.p).length === 0) continue;
    if (raceStart != null && frame.t < raceStart) continue;
    return orderByRaceProgress(frame, raceData.circuit.track_length_m);
  }
  // Race start timestamp pointed past the last frame — degrade gracefully.
  for (const frame of raceData.frames) {
    if (Object.keys(frame.p).length > 0) {
      return orderByRaceProgress(frame, raceData.circuit.track_length_m);
    }
  }
  return new Map();
}

// --- internals ------------------------------------------------------------

function bucketLapsByDriver(laps: readonly LapRecord[]): Map<number, LapRecord[]> {
  const out = new Map<number, LapRecord[]>();
  for (const lap of laps) {
    const arr = out.get(lap.driver) ?? [];
    arr.push(lap);
    out.set(lap.driver, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.lap - b.lap);
  return out;
}

function leaderLapAtFrame(frame: Frame): number {
  let leader = 0;
  for (const s of Object.values(frame.p)) if (s.lap > leader) leader = s.lap;
  return leader;
}

function orderByRaceProgress(frame: Frame, trackLen: number): Map<number, number> {
  const L = trackLen > 0 ? trackLen : 1;
  const rows: Array<{ driver: number; progress: number }> = [];
  for (const [numStr, s] of Object.entries(frame.p)) {
    rows.push({ driver: Number(numStr), progress: s.lap * L + s.d });
  }
  rows.sort((a, b) => b.progress - a.progress);
  const out = new Map<number, number>();
  rows.forEach((r, i) => out.set(r.driver, i + 1));
  return out;
}

function sectorFromDistance(d: number, trackLen: number): 1 | 2 | 3 {
  // v1 equal-thirds; matches the track-canvas sector-colouring overlay.
  // Real per-circuit sector boundaries land with the calibrated centrelines
  // in P6.
  if (d < trackLen / 3) return 1;
  if (d < (2 * trackLen) / 3) return 2;
  return 3;
}

/** Session-best sector time per sector (index 0=S1) across all drivers'
 *  laps completed *before* the leader's current lap. */
function buildSessionBests(
  lapsByDriver: ReadonlyMap<number, LapRecord[]>,
  leaderLap: number,
): [number, number, number] {
  let s1 = Number.POSITIVE_INFINITY;
  let s2 = Number.POSITIVE_INFINITY;
  let s3 = Number.POSITIVE_INFINITY;
  for (const laps of lapsByDriver.values()) {
    for (const lap of laps) {
      if (lap.lap >= leaderLap) break; // laps are sorted; stop at the cap
      if (lap.sector_1_s != null && lap.sector_1_s < s1) s1 = lap.sector_1_s;
      if (lap.sector_2_s != null && lap.sector_2_s < s2) s2 = lap.sector_2_s;
      if (lap.sector_3_s != null && lap.sector_3_s < s3) s3 = lap.sector_3_s;
    }
  }
  return [s1, s2, s3];
}

function computePersonalBestSectors(
  completedLaps: readonly LapRecord[],
): [number, number, number] {
  let s1 = Number.POSITIVE_INFINITY;
  let s2 = Number.POSITIVE_INFINITY;
  let s3 = Number.POSITIVE_INFINITY;
  for (const lap of completedLaps) {
    if (lap.sector_1_s != null && lap.sector_1_s < s1) s1 = lap.sector_1_s;
    if (lap.sector_2_s != null && lap.sector_2_s < s2) s2 = lap.sector_2_s;
    if (lap.sector_3_s != null && lap.sector_3_s < s3) s3 = lap.sector_3_s;
  }
  return [s1, s2, s3];
}

/** For each sector, return the driver's most recently-completed time.
 *  Sectors of the in-progress lap come from `currentLapRow` when they are
 *  populated (FastF1 fills them in progressively as the driver crosses each
 *  sector line); otherwise fall back to the most recent fully-completed lap. */
function mostRecentSectorTimes(
  currentLapRow: LapRecord | null,
  completedLaps: readonly LapRecord[],
  currentSector: 1 | 2 | 3,
): [number | null, number | null, number | null] {
  const last = completedLaps[completedLaps.length - 1];

  const fromCurrent = (slot: 1 | 2 | 3): number | null => {
    if (!currentLapRow) return null;
    if (slot === 1) return currentLapRow.sector_1_s;
    if (slot === 2) return currentLapRow.sector_2_s;
    return currentLapRow.sector_3_s;
  };
  const fromLast = (slot: 1 | 2 | 3): number | null => {
    if (!last) return null;
    if (slot === 1) return last.sector_1_s;
    if (slot === 2) return last.sector_2_s;
    return last.sector_3_s;
  };

  // S1 belongs to the current lap as soon as the driver is past sector 1.
  const s1 = currentSector >= 2 ? fromCurrent(1) ?? fromLast(1) : fromLast(1);
  // S2 belongs to the current lap once the driver is in sector 3.
  const s2 = currentSector >= 3 ? fromCurrent(2) ?? fromLast(2) : fromLast(2);
  // S3 only completes at the end of the lap, by which time we're already on
  // the next lap (`currentLap` has advanced). So S3 always comes from the
  // last fully-completed lap.
  const s3 = fromLast(3);

  return [s1, s2, s3];
}

function colourSectors(
  recent: [number | null, number | null, number | null],
  personal: [number, number, number],
  session: [number, number, number],
): [SectorStatus | null, SectorStatus | null, SectorStatus | null] {
  const out: [SectorStatus | null, SectorStatus | null, SectorStatus | null] = [
    null,
    null,
    null,
  ];
  for (let i = 0; i < 3; i++) {
    const t = recent[i];
    if (t == null) continue;
    // Tight epsilon — sector times are in seconds with 3 decimals.
    const eps = 1e-4;
    if (t <= (session[i] ?? Number.POSITIVE_INFINITY) + eps) {
      out[i] = "purple";
    } else if (t <= (personal[i] ?? Number.POSITIVE_INFINITY) + eps) {
      out[i] = "green";
    } else {
      out[i] = "yellow";
    }
  }
  return out;
}

function computePaceDelta(
  currentLapRow: LapRecord | null,
  lastLap: LapRecord | null,
  currentSector: 1 | 2 | 3,
): number | null {
  if (!currentLapRow || !lastLap) return null;

  if (currentSector === 2) {
    // S1 of current vs S1 of last.
    if (currentLapRow.sector_1_s != null && lastLap.sector_1_s != null) {
      return currentLapRow.sector_1_s - lastLap.sector_1_s;
    }
  } else if (currentSector === 3) {
    // S1+S2 of current vs S1+S2 of last.
    if (
      currentLapRow.sector_1_s != null &&
      currentLapRow.sector_2_s != null &&
      lastLap.sector_1_s != null &&
      lastLap.sector_2_s != null
    ) {
      return (
        currentLapRow.sector_1_s +
        currentLapRow.sector_2_s -
        lastLap.sector_1_s -
        lastLap.sector_2_s
      );
    }
  }
  // In S1: no completed sector yet for the current lap — no delta to show.
  return null;
}

function countPitStops(driverLaps: readonly LapRecord[], throughLap: number): number {
  let count = 0;
  let prevCompound: string | null = null;
  for (const lap of driverLaps) {
    if (lap.lap > throughLap) break;
    if (lap.compound == null) continue;
    if (prevCompound != null && lap.compound !== prevCompound) count++;
    prevCompound = lap.compound;
  }
  return count;
}
