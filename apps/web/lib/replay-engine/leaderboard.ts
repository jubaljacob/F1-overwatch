import type { DriverInfo, Frame, LapRecord, RaceData } from "@traceline/shared-types";

export interface LeaderboardRow {
  position: number;
  driver: DriverInfo;
  lap: number;
  lapDistance: number;
  raceProgress: number;
  status: "on_track" | "pit" | "out";
  /** Time gap to the leader in seconds (estimated from avg lap speed). */
  gapToLeader: number;
}

/**
 * Build a map of driver number → average speed (m/s) from completed lap records.
 * Uses the median lap time to avoid outliers from safety-car laps.
 */
function buildAvgSpeeds(laps: readonly LapRecord[], trackLength: number): Map<number, number> {
  const byDriver = new Map<number, number[]>();
  for (const lap of laps) {
    if (!lap.lap_time_s || lap.lap_time_s <= 0) continue;
    const arr = byDriver.get(lap.driver) ?? [];
    arr.push(lap.lap_time_s);
    byDriver.set(lap.driver, arr);
  }
  const result = new Map<number, number>();
  for (const [driver, times] of byDriver) {
    const sorted = [...times].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    result.set(driver, trackLength / median);
  }
  return result;
}

/** Compute leaderboard order for a single frame.
 *
 *  Order key per CLAUDE.md §4: `lap * trackLength + lapDistance`. P1 baseline;
 *  P2 will layer official-classification overrides at race start and end.
 */
export function computeLeaderboard(
  data: RaceData,
  frame: Frame | null,
  drivers: ReadonlyMap<number, DriverInfo>,
): LeaderboardRow[] {
  if (!frame) return [];
  const L = data.circuit.track_length_m;
  const safeL = L > 0 ? L : 1; // guard for raceProgress division only
  const avgSpeeds = buildAvgSpeeds(data.laps, safeL);
  const fallbackSpeed = L > 0 ? L / 90 : 0;

  const rows: LeaderboardRow[] = [];
  for (const [numStr, s] of Object.entries(frame.p)) {
    const num = Number(numStr);
    const info = drivers.get(num);
    if (!info) continue;
    rows.push({
      position: 0,
      driver: info,
      lap: s.lap,
      lapDistance: s.d,
      raceProgress: s.lap * safeL + s.d,
      status: s.st,
      gapToLeader: 0,
    });
  }

  rows.sort((a, b) => b.raceProgress - a.raceProgress);
  const leaderProgress = rows[0]?.raceProgress ?? 0;
  rows.forEach((r, i) => {
    r.position = i + 1;
    const speed = avgSpeeds.get(r.driver.number) ?? fallbackSpeed;
    r.gapToLeader = speed > 0 ? (leaderProgress - r.raceProgress) / speed : 0;
  });
  return rows;
}
