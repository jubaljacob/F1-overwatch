"use client";

import { useQuery } from "@tanstack/react-query";
import type { SeasonPayload } from "@traceline/shared-types";
import { getSeason } from "./api";
import {
  CIRCUIT_STATS,
  SEASON_2026,
  type RaceRecord,
  type SeasonData,
  type SeasonSummary,
  summariseSeason,
} from "./season-data";

/**
 * Fetch the live SeasonPayload for a year and merge it with the local
 * static circuit-stats map so the dashboard has both the dynamic bits
 * (standings, completed rounds, official schedule) and the static facts
 * (laps, top speed, turns, elevation, historical winners, lap record).
 *
 * Falls back to the hand-curated 2026 stub when the API errors or returns
 * `isStub=true`, so the UI never goes dark while the backend is offline.
 */
export interface UseSeasonResult {
  season: SeasonData;
  summary: SeasonSummary;
  /** True when the live API returned a usable payload (vs the static stub). */
  isLive: boolean;
  isLoading: boolean;
  error: Error | null;
}

export function useSeason(year: number, today: Date): UseSeasonResult {
  const query = useQuery<SeasonPayload, Error>({
    queryKey: ["season", year],
    queryFn: () => getSeason(year),
    // Standings refresh after each race weekend; an hour matches the
    // backend's disk-cache TTL so we don't hammer the route on tab focus.
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  if (!query.data || query.data.isStub) {
    // Fall back to the static stub. Only meaningful for 2026 in the stub;
    // other years still render an empty calendar/standings until the API
    // recovers.
    const fallback = year === 2026 ? SEASON_2026 : emptySeason(year);
    return {
      season: fallback,
      summary: summariseSeason(fallback, today),
      isLive: false,
      isLoading: query.isLoading,
      error: query.error ?? null,
    };
  }

  const season = mergeWithCircuitStats(query.data);
  return {
    season,
    summary: summariseSeason(season, today),
    isLive: true,
    isLoading: false,
    error: null,
  };
}

/** Drape the live schedule with our static circuit-fact lookup so every
 *  RaceRecord has the laps/turns/elevation/etc. fields downstream cards
 *  expect. Live data supplies round, name, location, circuitKey, date.
 *  Anything not in the static map gets sensible zero defaults so the UI
 *  still renders (rather than throwing on missing keys). */
function mergeWithCircuitStats(payload: SeasonPayload): SeasonData {
  const schedule: RaceRecord[] = payload.schedule.map((r) => {
    const stats = CIRCUIT_STATS[r.circuitKey];
    return {
      round: r.round,
      name: r.name,
      location: r.location,
      circuitKey: r.circuitKey,
      date: r.date,
      // FP1 isn't in the live schedule; synthesise as race day - 2 days at
      // a generic-ish hour so the countdown still works. Real FP1 times
      // can be wired in if we ever ingest the session sub-table.
      fp1: stats?.fp1 ?? defaultFp1(r.date),
      laps: stats?.laps ?? 0,
      lengthKm: stats?.lengthKm ?? 0,
      topSpeedKmph: stats?.topSpeedKmph ?? 0,
      turns: stats?.turns ?? 0,
      elevationM: stats?.elevationM ?? 0,
      lapRecord: stats?.lapRecord ?? { time: "—", driver: "—", year: 0 },
      topConstructor: stats?.topConstructor ?? { name: "—", wins: 0 },
      topDriver: stats?.topDriver ?? { name: "—", wins: 0 },
    };
  });

  return {
    year: payload.year,
    schedule,
    drivers: payload.drivers,
    // Chassis is missing from Jolpi; the SeasonData type marks it required,
    // so substitute empty string and let the standings panel decide whether
    // to render it.
    constructors: payload.constructors.map((c) => ({ ...c, chassis: c.chassis ?? "" })),
  };
}

/** Race-day minus 48 hours @ 11:00 UTC — only used when no static FP1
 *  override exists; the countdown still ticks but isn't tied to the
 *  real-world session-time. */
function defaultFp1(raceDateIso: string): string {
  const t = new Date(`${raceDateIso}T11:00:00Z`).getTime() - 2 * 24 * 3600 * 1000;
  return new Date(t).toISOString();
}

function emptySeason(year: number): SeasonData {
  return { year, schedule: [], drivers: [], constructors: [] };
}
