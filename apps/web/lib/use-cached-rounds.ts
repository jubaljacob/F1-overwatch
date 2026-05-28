"use client";

import { useQuery } from "@tanstack/react-query";
import { getCachedRounds } from "./api";

/**
 * Per-round map of which session types are persisted on disk. The cache
 * holds full RaceData blobs at `.racedata-cache/{year}_{round:02d}_{TYPE}_*`
 * and grows over time (each successful replay adds one) without ever
 * expiring, since past sessions are immutable.
 *
 * Returned as a `Map<round, Set<sessionType>>` so the calendar can answer
 * "is round 12's R saved?" in O(1) via `result.get(12)?.has("R")`.
 */
export function useCachedRounds(year: number): Map<number, Set<string>> {
  const q = useQuery<Record<string, string[]>, Error>({
    queryKey: ["cached-rounds", year],
    queryFn: () => getCachedRounds(year),
    // The badge should refresh after returning from a freshly-cached
    // replay; 60s gives a balance between freshness and chatter.
    staleTime: 60 * 1000,
    retry: 1,
  });
  const out = new Map<number, Set<string>>();
  if (q.data) {
    for (const [k, types] of Object.entries(q.data)) {
      out.set(Number(k), new Set(types));
    }
  }
  return out;
}
