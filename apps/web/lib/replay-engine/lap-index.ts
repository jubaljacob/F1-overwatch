import type { Frame, RaceData } from "@traceline/shared-types";

/** One pass over `raceData.frames` produces a per-driver index mapping
 *  each lap to the [startIdx, endIdx] range of frames where that
 *  driver's sample.lap matched. Lets the quali telemetry panel and any
 *  other "show me the in-progress lap's frames" consumer skip the
 *  per-render backward scan over all frames.
 *
 *  Range endpoints are **inclusive** on both ends — endIdx is the last
 *  frame in the lap, not one past the end. Lookups should slice as
 *  `frames.slice(startIdx, endIdx + 1)` if they want a JS array.
 */
export interface LapRange {
  startIdx: number;
  endIdx: number;
}

export interface LapIndex {
  /** Keyed by driver number → keyed by lap number → frame-index range. */
  byDriver: Map<number, Map<number, LapRange>>;
  /** Frame-index → lookup for the latest frame at or before `t`.
   *  Binary search over `frames[i].t`. Returns -1 when t precedes the
   *  first frame. */
  frameIndexAtTime: (t: number) => number;
}

export function buildLapIndex(raceData: RaceData | null): LapIndex {
  const empty: LapIndex = {
    byDriver: new Map(),
    frameIndexAtTime: () => -1,
  };
  if (!raceData || raceData.frames.length === 0) return empty;

  const frames = raceData.frames;
  // Each driver's "currently open" lap range — closed and committed when
  // their sample.lap changes (lap boundary) or their sample disappears
  // for a stretch (rare, but defensive).
  const open = new Map<number, { lap: number; startIdx: number; endIdx: number }>();
  const byDriver = new Map<number, Map<number, LapRange>>();

  for (let i = 0; i < frames.length; i++) {
    const p = frames[i]!.p;
    for (const key in p) {
      const driverNum = Number(key);
      const sample = p[key]!;
      const lap = sample.lap;
      const existing = open.get(driverNum);
      if (!existing) {
        open.set(driverNum, { lap, startIdx: i, endIdx: i });
      } else if (existing.lap === lap) {
        existing.endIdx = i;
      } else {
        // Lap boundary — commit the closed range, start a new one.
        let perDriver = byDriver.get(driverNum);
        if (!perDriver) {
          perDriver = new Map();
          byDriver.set(driverNum, perDriver);
        }
        perDriver.set(existing.lap, { startIdx: existing.startIdx, endIdx: existing.endIdx });
        open.set(driverNum, { lap, startIdx: i, endIdx: i });
      }
    }
  }
  // Flush the still-open ranges at end-of-session.
  for (const [driverNum, openRange] of open) {
    let perDriver = byDriver.get(driverNum);
    if (!perDriver) {
      perDriver = new Map();
      byDriver.set(driverNum, perDriver);
    }
    perDriver.set(openRange.lap, { startIdx: openRange.startIdx, endIdx: openRange.endIdx });
  }

  const frameIndexAtTime = (t: number): number => {
    if (frames.length === 0) return -1;
    if (t < frames[0]!.t) return -1;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid]!.t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  return { byDriver, frameIndexAtTime };
}

/** Slice the cached lap range out of frames[]. Returns an empty array if
 *  the driver hasn't started this lap yet (or the lap doesn't exist). */
export function framesForLap(
  raceData: RaceData,
  index: LapIndex,
  driverNum: number,
  lap: number,
): ReadonlyArray<Frame> {
  const range = index.byDriver.get(driverNum)?.get(lap);
  if (!range) return [];
  return raceData.frames.slice(range.startIdx, range.endIdx + 1);
}
