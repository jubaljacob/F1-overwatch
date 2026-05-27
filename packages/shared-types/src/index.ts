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
  /** Session-time at which lap 1 begins for the leader — i.e. lights-out.
   *  Used to baseline the position-change arrow at race start rather than
   *  at the start of the recorded data (where order is meaningless). */
  race_start_t?: number | null;
}

export interface RaceData {
  meta: RaceDataMeta;
  drivers: DriverInfo[];
  circuit: CircuitGeometry;
  frames: Frame[];
  laps: LapRecord[];
}

// --- P4 strategy types ----------------------------------------------------

export interface CompoundFit {
  compound: string;
  intercept: number;
  coef_tyre_age: number;
  coef_lap_norm: number;
  coef_track_temp: number | null;
  n_samples: number;
  r_squared: number;
  rmse: number;
}

export interface TyreModelOut {
  year: number;
  round: number;
  n_sessions: number;
  n_samples_total: number;
  track_temp_c: number | null;
  total_laps: number;
  compounds: CompoundFit[];
}

export interface PitStop {
  lap: number;
  new_compound: string;
}

export interface Strategy {
  starting_compound: string;
  pit_stops: PitStop[];
}

export interface LapPrediction {
  lap: number;
  compound: string;
  tyre_age: number;
  predicted_lap_time_s: number;
  pit_stop: boolean;
}

export interface SimulationOut {
  driver_num: number;
  total_race_time_s: number;
  finishing_position: number;
  laps: LapPrediction[];
  actual_total_race_time_s: number | null;
  actual_finishing_position: number | null;
  delta_to_actual_s: number | null;
}

export interface RankedStrategy {
  rank: number;
  strategy: Strategy;
  result: SimulationOut;
}
