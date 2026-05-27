// Mirror of apps/api/traceline/schemas/session.py. P0 used a hand-written
// surface; once the schema stabilises in P2 we should generate this with
// datamodel-code-generator's TS exporter rather than maintain by hand.

export type DriverStatus = "on_track" | "pit" | "out";

export interface DriverInfo {
  number: number;
  code: string;
  full_name: string;
  team: string;
  team_colour: string | null;
}

export interface SessionMeta {
  year: number;
  round: number;
  circuit: string;
  session_type: string;
  total_laps: number | null;
  drivers: DriverInfo[];
}

export interface SampleLap {
  driver_code: string;
  lap_number: number;
  lap_time_seconds: number;
  compound: string | null;
}

// --- RaceData -------------------------------------------------------------

export interface CircuitGeometry {
  name: string;
  track_length_m: number;
  centreline: [number, number][];
  cumulative_distance: number[];
}

export interface DriverSample {
  x: number;
  y: number;
  z?: number | null;
  d: number;
  lap: number;
  spd: number;
  gear?: number | null;
  thr?: number | null;
  brk?: number | null;
  drs?: boolean | null;
  st: DriverStatus;
}

export interface Frame {
  t: number;
  // Keyed by driver number. JSON object keys are strings; consumers convert.
  p: Record<string, DriverSample>;
}

export interface LapRecord {
  driver: number;
  lap: number;
  lap_time_s: number | null;
  sector_1_s: number | null;
  sector_2_s: number | null;
  sector_3_s: number | null;
  compound: string | null;
  tyre_age: number | null;
  pit_in: boolean;
  pit_out: boolean;
}

export interface RaceDataMeta {
  year: number;
  round: number;
  circuit: string;
  session_type: string;
  total_laps: number;
  frame_hz: number;
  t_start: number;
  t_end: number;
  // P2 race-end override. After race_end_t the renderer locks leaderboard
  // order to final_classification (driver number → official position).
  // JSON object keys are strings; consumers convert when looking up.
  race_end_t?: number | null;
  final_classification?: Record<string, number> | null;
}

export interface RaceData {
  meta: RaceDataMeta;
  drivers: DriverInfo[];
  circuit: CircuitGeometry;
  frames: Frame[];
  laps: LapRecord[];
}
