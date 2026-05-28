/**
 * Hand-curated F1 season data used by the landing dashboard while a live
 * source (Jolpi/Ergast, etc.) is not yet wired in. Treat this as a fixture:
 * every shape here is what the eventual API will return.
 *
 * "today" is anchored to the current date (2026-05-28). Races with a start
 * date before today are treated as completed; today's race week or the next
 * future race is the "current" round.
 */

export type RaceStatus = "completed" | "current" | "upcoming";

export interface RaceRecord {
  round: number;
  name: string;
  /** Short location label shown under the GP name (e.g. "Monte-Carlo"). */
  location: string;
  /** Circuit identifier used for replay routing — matches existing track-data slugs. */
  circuitKey: string;
  /** ISO date of race day. */
  date: string;
  /** Practice 1 start ISO timestamp — drives the countdown widget. */
  fp1: string;
  /** Number of race laps. */
  laps: number;
  /** Circuit length in km. */
  lengthKm: number;
  /** Top speed seen at this circuit in recent seasons (KMPH). */
  topSpeedKmph: number;
  /** Number of turns on the lap. */
  turns: number;
  /** Vertical elevation change across the lap, metres. */
  elevationM: number;
  /** All-time race lap record at this circuit. */
  lapRecord: { time: string; driver: string; year: number };
  /** Most successful constructor at this circuit (all-time wins). */
  topConstructor: { name: string; wins: number };
  /** Most successful driver at this circuit (all-time wins). */
  topDriver: { name: string; wins: number };
}

export interface DriverStanding {
  position: number;
  name: string;
  team: string;
  points: number;
  wins: number;
}

export interface ConstructorStanding {
  position: number;
  team: string;
  /** Chassis designation shown under the team name (e.g. "F1 W17"). */
  chassis: string;
  points: number;
}

export interface SeasonData {
  year: number;
  schedule: RaceRecord[];
  drivers: DriverStanding[];
  constructors: ConstructorStanding[];
}

/* ───────────────────────────── 2026 season ───────────────────────────── */

const SCHEDULE_2026: RaceRecord[] = [
  {
    round: 1, name: "Bahrain GP", location: "Sakhir", circuitKey: "bahrain",
    date: "2026-03-08", fp1: "2026-03-06T11:30:00Z",
    laps: 57, lengthKm: 5.412, topSpeedKmph: 330, turns: 15, elevationM: 16.6,
    lapRecord: { time: "1:31.447", driver: "Pedro de la Rosa", year: 2005 },
    topConstructor: { name: "Ferrari", wins: 7 },
    topDriver: { name: "Lewis Hamilton", wins: 5 },
  },
  {
    round: 2, name: "Saudi Arabian GP", location: "Jeddah", circuitKey: "jeddah",
    date: "2026-03-22", fp1: "2026-03-20T13:30:00Z",
    laps: 50, lengthKm: 6.174, topSpeedKmph: 343, turns: 27, elevationM: 4.2,
    lapRecord: { time: "1:30.734", driver: "Lewis Hamilton", year: 2021 },
    topConstructor: { name: "Red Bull", wins: 3 },
    topDriver: { name: "Max Verstappen", wins: 2 },
  },
  {
    round: 3, name: "Australian GP", location: "Melbourne", circuitKey: "melbourne",
    date: "2026-04-05", fp1: "2026-04-03T01:30:00Z",
    laps: 58, lengthKm: 5.278, topSpeedKmph: 333, turns: 14, elevationM: 6.0,
    lapRecord: { time: "1:19.813", driver: "Charles Leclerc", year: 2024 },
    topConstructor: { name: "McLaren", wins: 12 },
    topDriver: { name: "Michael Schumacher", wins: 4 },
  },
  {
    round: 4, name: "Japanese GP", location: "Suzuka", circuitKey: "suzuka",
    date: "2026-04-19", fp1: "2026-04-17T02:30:00Z",
    laps: 53, lengthKm: 5.807, topSpeedKmph: 327, turns: 18, elevationM: 40.0,
    lapRecord: { time: "1:30.983", driver: "Lewis Hamilton", year: 2019 },
    topConstructor: { name: "McLaren", wins: 9 },
    topDriver: { name: "Michael Schumacher", wins: 6 },
  },
  {
    round: 5, name: "Miami GP", location: "Miami", circuitKey: "miami",
    date: "2026-05-10", fp1: "2026-05-08T16:30:00Z",
    laps: 57, lengthKm: 5.412, topSpeedKmph: 322, turns: 19, elevationM: 3.0,
    lapRecord: { time: "1:29.708", driver: "Max Verstappen", year: 2023 },
    topConstructor: { name: "Red Bull", wins: 2 },
    topDriver: { name: "Max Verstappen", wins: 2 },
  },
  {
    round: 6, name: "Monaco GP", location: "Monte-Carlo", circuitKey: "monaco",
    date: "2026-06-07", fp1: "2026-06-05T11:30:00Z",
    laps: 78, lengthKm: 3.337, topSpeedKmph: 289, turns: 19, elevationM: 41.95,
    lapRecord: { time: "1:12.909", driver: "Lewis Hamilton", year: 2021 },
    topConstructor: { name: "McLaren", wins: 16 },
    topDriver: { name: "Ayrton Senna", wins: 6 },
  },
  {
    round: 7, name: "Spanish GP", location: "Montmeló", circuitKey: "barcelona",
    date: "2026-06-14", fp1: "2026-06-12T11:30:00Z",
    laps: 66, lengthKm: 4.657, topSpeedKmph: 320, turns: 14, elevationM: 30.0,
    lapRecord: { time: "1:16.330", driver: "Max Verstappen", year: 2023 },
    topConstructor: { name: "Ferrari", wins: 12 },
    topDriver: { name: "Michael Schumacher", wins: 6 },
  },
  {
    round: 8, name: "Austrian GP", location: "Spielberg", circuitKey: "redbullring",
    date: "2026-06-28", fp1: "2026-06-26T11:30:00Z",
    laps: 71, lengthKm: 4.318, topSpeedKmph: 318, turns: 10, elevationM: 65.0,
    lapRecord: { time: "1:05.619", driver: "Carlos Sainz", year: 2020 },
    topConstructor: { name: "McLaren", wins: 6 },
    topDriver: { name: "Max Verstappen", wins: 5 },
  },
  {
    round: 9, name: "British GP", location: "Silverstone", circuitKey: "silverstone",
    date: "2026-07-05", fp1: "2026-07-03T11:30:00Z",
    laps: 52, lengthKm: 5.891, topSpeedKmph: 325, turns: 18, elevationM: 11.0,
    lapRecord: { time: "1:27.097", driver: "Max Verstappen", year: 2020 },
    topConstructor: { name: "Ferrari", wins: 18 },
    topDriver: { name: "Lewis Hamilton", wins: 8 },
  },
  {
    round: 10, name: "Hungarian GP", location: "Mogyoród", circuitKey: "hungaroring",
    date: "2026-07-26", fp1: "2026-07-24T11:30:00Z",
    laps: 70, lengthKm: 4.381, topSpeedKmph: 312, turns: 14, elevationM: 36.0,
    lapRecord: { time: "1:16.627", driver: "Lewis Hamilton", year: 2020 },
    topConstructor: { name: "McLaren", wins: 11 },
    topDriver: { name: "Lewis Hamilton", wins: 8 },
  },
  {
    round: 11, name: "Belgian GP", location: "Spa", circuitKey: "spa",
    date: "2026-08-30", fp1: "2026-08-28T11:30:00Z",
    laps: 44, lengthKm: 7.004, topSpeedKmph: 339, turns: 19, elevationM: 102.0,
    lapRecord: { time: "1:46.286", driver: "Valtteri Bottas", year: 2018 },
    topConstructor: { name: "Ferrari", wins: 18 },
    topDriver: { name: "Michael Schumacher", wins: 6 },
  },
  {
    round: 12, name: "Dutch GP", location: "Zandvoort", circuitKey: "zandvoort",
    date: "2026-09-06", fp1: "2026-09-04T10:30:00Z",
    laps: 72, lengthKm: 4.259, topSpeedKmph: 320, turns: 14, elevationM: 9.5,
    lapRecord: { time: "1:11.097", driver: "Lewis Hamilton", year: 2021 },
    topConstructor: { name: "Ferrari", wins: 8 },
    topDriver: { name: "Jim Clark", wins: 4 },
  },
  {
    round: 13, name: "Italian GP", location: "Monza", circuitKey: "monza",
    date: "2026-09-13", fp1: "2026-09-11T11:30:00Z",
    laps: 53, lengthKm: 5.793, topSpeedKmph: 360, turns: 11, elevationM: 6.0,
    lapRecord: { time: "1:21.046", driver: "Rubens Barrichello", year: 2004 },
    topConstructor: { name: "Ferrari", wins: 20 },
    topDriver: { name: "Michael Schumacher", wins: 5 },
  },
  {
    round: 14, name: "Azerbaijan GP", location: "Baku", circuitKey: "baku",
    date: "2026-09-27", fp1: "2026-09-25T08:30:00Z",
    laps: 51, lengthKm: 6.003, topSpeedKmph: 359, turns: 20, elevationM: 5.0,
    lapRecord: { time: "1:43.009", driver: "Charles Leclerc", year: 2019 },
    topConstructor: { name: "Red Bull", wins: 2 },
    topDriver: { name: "Sergio Pérez", wins: 2 },
  },
  {
    round: 15, name: "Singapore GP", location: "Marina Bay", circuitKey: "singapore",
    date: "2026-10-04", fp1: "2026-10-02T09:30:00Z",
    laps: 62, lengthKm: 4.940, topSpeedKmph: 323, turns: 19, elevationM: 9.0,
    lapRecord: { time: "1:35.867", driver: "Lewis Hamilton", year: 2023 },
    topConstructor: { name: "Mercedes", wins: 4 },
    topDriver: { name: "Lewis Hamilton", wins: 4 },
  },
  {
    round: 16, name: "United States GP", location: "Austin", circuitKey: "austin",
    date: "2026-10-25", fp1: "2026-10-23T18:30:00Z",
    laps: 56, lengthKm: 5.513, topSpeedKmph: 330, turns: 20, elevationM: 41.0,
    lapRecord: { time: "1:36.169", driver: "Charles Leclerc", year: 2019 },
    topConstructor: { name: "Mercedes", wins: 4 },
    topDriver: { name: "Lewis Hamilton", wins: 5 },
  },
  {
    round: 17, name: "Mexico City GP", location: "Mexico City", circuitKey: "mexico",
    date: "2026-11-01", fp1: "2026-10-30T18:30:00Z",
    laps: 71, lengthKm: 4.304, topSpeedKmph: 354, turns: 17, elevationM: 8.0,
    lapRecord: { time: "1:17.774", driver: "Valtteri Bottas", year: 2021 },
    topConstructor: { name: "McLaren", wins: 5 },
    topDriver: { name: "Max Verstappen", wins: 5 },
  },
  {
    round: 18, name: "São Paulo GP", location: "Interlagos", circuitKey: "interlagos",
    date: "2026-11-08", fp1: "2026-11-06T14:30:00Z",
    laps: 71, lengthKm: 4.309, topSpeedKmph: 332, turns: 15, elevationM: 43.0,
    lapRecord: { time: "1:10.540", driver: "Valtteri Bottas", year: 2018 },
    topConstructor: { name: "McLaren", wins: 12 },
    topDriver: { name: "Alain Prost", wins: 6 },
  },
  {
    round: 19, name: "Las Vegas GP", location: "Las Vegas", circuitKey: "lasvegas",
    date: "2026-11-22", fp1: "2026-11-20T04:30:00Z",
    laps: 50, lengthKm: 6.201, topSpeedKmph: 346, turns: 17, elevationM: 2.0,
    lapRecord: { time: "1:35.490", driver: "Oscar Piastri", year: 2024 },
    topConstructor: { name: "Mercedes", wins: 1 },
    topDriver: { name: "George Russell", wins: 1 },
  },
  {
    round: 20, name: "Qatar GP", location: "Lusail", circuitKey: "lusail",
    date: "2026-11-29", fp1: "2026-11-27T13:30:00Z",
    laps: 57, lengthKm: 5.419, topSpeedKmph: 325, turns: 16, elevationM: 6.5,
    lapRecord: { time: "1:24.319", driver: "Lando Norris", year: 2024 },
    topConstructor: { name: "Mercedes", wins: 1 },
    topDriver: { name: "Max Verstappen", wins: 1 },
  },
  {
    round: 21, name: "Abu Dhabi GP", location: "Yas Marina", circuitKey: "yasmarina",
    date: "2026-12-06", fp1: "2026-12-04T09:30:00Z",
    laps: 58, lengthKm: 5.281, topSpeedKmph: 332, turns: 16, elevationM: 5.0,
    lapRecord: { time: "1:26.103", driver: "Max Verstappen", year: 2021 },
    topConstructor: { name: "Mercedes", wins: 5 },
    topDriver: { name: "Lewis Hamilton", wins: 5 },
  },
];

const DRIVERS_2026: DriverStanding[] = [
  { position: 1, name: "Andrea Kimi Antonelli", team: "Mercedes", points: 131, wins: 2 },
  { position: 2, name: "George Russell", team: "Mercedes", points: 88, wins: 1 },
  { position: 3, name: "Charles Leclerc", team: "Ferrari", points: 75, wins: 1 },
  { position: 4, name: "Lewis Hamilton", team: "Ferrari", points: 72, wins: 0 },
  { position: 5, name: "Lando Norris", team: "McLaren", points: 58, wins: 1 },
  { position: 6, name: "Oscar Piastri", team: "McLaren", points: 48, wins: 0 },
  { position: 7, name: "Max Verstappen", team: "Red Bull", points: 42, wins: 0 },
  { position: 8, name: "Fernando Alonso", team: "Aston Martin", points: 22, wins: 0 },
  { position: 9, name: "Pierre Gasly", team: "Alpine", points: 18, wins: 0 },
  { position: 10, name: "Lance Stroll", team: "Aston Martin", points: 15, wins: 0 },
  { position: 11, name: "Yuki Tsunoda", team: "Red Bull", points: 15, wins: 0 },
  { position: 12, name: "Esteban Ocon", team: "Haas", points: 12, wins: 0 },
  { position: 13, name: "Alex Albon", team: "Williams", points: 10, wins: 0 },
  { position: 14, name: "Nico Hülkenberg", team: "Audi", points: 7, wins: 0 },
  { position: 15, name: "Liam Lawson", team: "Racing Bulls", points: 5, wins: 0 },
  { position: 16, name: "Isack Hadjar", team: "Racing Bulls", points: 4, wins: 0 },
  { position: 17, name: "Oliver Bearman", team: "Haas", points: 3, wins: 0 },
  { position: 18, name: "Carlos Sainz", team: "Williams", points: 2, wins: 0 },
  { position: 19, name: "Gabriel Bortoleto", team: "Audi", points: 1, wins: 0 },
  { position: 20, name: "Jack Doohan", team: "Alpine", points: 0, wins: 0 },
  { position: 21, name: "Sergio Pérez", team: "Cadillac", points: 0, wins: 0 },
  { position: 22, name: "Mick Schumacher", team: "Cadillac", points: 0, wins: 0 },
];

const CONSTRUCTORS_2026: ConstructorStanding[] = [
  { position: 1, team: "Mercedes", chassis: "F1 W17", points: 219 },
  { position: 2, team: "Ferrari", chassis: "SF-26", points: 147 },
  { position: 3, team: "McLaren", chassis: "MCL40", points: 106 },
  { position: 4, team: "Red Bull", chassis: "RB22", points: 57 },
  { position: 5, team: "Aston Martin", chassis: "AMR26", points: 37 },
  { position: 6, team: "Alpine", chassis: "A526", points: 18 },
  { position: 7, team: "Haas", chassis: "VF-26", points: 15 },
  { position: 8, team: "Williams", chassis: "FW48", points: 12 },
  { position: 9, team: "Racing Bulls", chassis: "VCARB-02", points: 9 },
  { position: 10, team: "Audi", chassis: "C46", points: 8 },
  { position: 11, team: "Cadillac", chassis: "CDX-01", points: 0 },
];

export const SEASON_2026: SeasonData = {
  year: 2026,
  schedule: SCHEDULE_2026,
  drivers: DRIVERS_2026,
  constructors: CONSTRUCTORS_2026,
};

/**
 * Static circuit facts keyed by `circuitKey`. The live `/seasons/{year}`
 * endpoint only ships dynamic data (schedule + standings), so we drape
 * each race in these facts (laps, top speed, turns, elevation, lap
 * record, historical winners) when merging server data into the dashboard.
 *
 * Sourced from the same hand-curated 2026 schedule so any tweak there
 * automatically reaches the live path too.
 */
export type CircuitStats = Omit<
  RaceRecord,
  "round" | "name" | "location" | "circuitKey" | "date"
>;

export const CIRCUIT_STATS: Record<string, CircuitStats> = Object.fromEntries(
  SCHEDULE_2026.map((r) => [
    r.circuitKey,
    {
      fp1: r.fp1,
      laps: r.laps,
      lengthKm: r.lengthKm,
      topSpeedKmph: r.topSpeedKmph,
      turns: r.turns,
      elevationM: r.elevationM,
      lapRecord: r.lapRecord,
      topConstructor: r.topConstructor,
      topDriver: r.topDriver,
    } satisfies CircuitStats,
  ]),
);

/** Past seasons exposed in the season dropdown. Just the year + a placeholder
 *  schedule from FastF1/OpenF1 — populated on demand. For now we only carry
 *  enough metadata to render the dropdown; the replay flow already knows how
 *  to fetch race data by (year, round). */
export const SEASON_INDEX: { year: number; label: string }[] = [
  { year: 2026, label: "2026 Season" },
  { year: 2025, label: "2025 Season" },
  { year: 2024, label: "2024 Season" },
  { year: 2023, label: "2023 Season" },
];

/* ───────────────────────────── derivations ───────────────────────────── */

export interface SeasonSummary {
  /** Index of the current race within `schedule`. -1 if season hasn't started. */
  currentIndex: number;
  /** The round currently treated as "next up". `undefined` when the
   *  schedule is empty (e.g. mid-load or an unknown season year). */
  nextRace: RaceRecord | undefined;
  /** Races already completed (race day < today). */
  completed: RaceRecord[];
  /** Races still ahead (race day >= today). */
  upcoming: RaceRecord[];
  /** Fraction of season completed by round count. */
  progressFraction: number;
  totalRounds: number;
  completedRounds: number;
  /** Total km covered across completed races. */
  kmCovered: number;
  /** Total race laps run across completed races. */
  lapsCompleted: number;
}

/**
 * Build a summary view of the season relative to a reference date.
 * `today` is a parameter (not `new Date()`) so callers can render
 * deterministic SSR output and tests can pin the date.
 */
export function summariseSeason(season: SeasonData, today: Date): SeasonSummary {
  const t = today.getTime();
  const completed: RaceRecord[] = [];
  const upcoming: RaceRecord[] = [];
  for (const r of season.schedule) {
    // A race counts as "completed" once race-day midnight has passed.
    const raceTime = new Date(r.date + "T23:59:59Z").getTime();
    if (raceTime < t) completed.push(r);
    else upcoming.push(r);
  }
  // `undefined` when the schedule itself is empty — the dashboard renders
  // a placeholder for that case rather than crashing.
  const nextRace: RaceRecord | undefined =
    upcoming[0] ?? season.schedule[season.schedule.length - 1];
  const currentIndex = nextRace
    ? season.schedule.findIndex((r) => r.round === nextRace.round)
    : -1;
  const kmCovered = completed.reduce((acc, r) => acc + r.laps * r.lengthKm, 0);
  const lapsCompleted = completed.reduce((acc, r) => acc + r.laps, 0);
  return {
    currentIndex,
    nextRace,
    completed,
    upcoming,
    progressFraction: completed.length / season.schedule.length,
    totalRounds: season.schedule.length,
    completedRounds: completed.length,
    kmCovered,
    lapsCompleted,
  };
}

/**
 * Countdown from `now` to `target`. Returns negative values if the target is
 * in the past; the consumer decides how to render that.
 */
export interface Countdown {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  totalMs: number;
}

export function countdownTo(target: Date, now: Date): Countdown {
  const totalMs = target.getTime() - now.getTime();
  const sign = totalMs >= 0 ? 1 : -1;
  const abs = Math.abs(totalMs);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  const seconds = Math.floor((abs % 60_000) / 1_000);
  return {
    days: days * sign,
    hours: hours * sign,
    minutes: minutes * sign,
    seconds: seconds * sign,
    totalMs,
  };
}
