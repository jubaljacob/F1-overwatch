"use client";

import { useQuery } from "@tanstack/react-query";
import type { RaceResultsPayload } from "@traceline/shared-types";
import { getRaceResults } from "./api";

/**
 * Fetch top-finisher data for a completed race. The hook is mountable
 * even when no race is selected (or the selected race hasn't run yet) —
 * pass `undefined` for `round` to disable the fetch.
 */
export function useRaceResults(year: number, round: number | undefined) {
  return useQuery<RaceResultsPayload, Error>({
    queryKey: ["race-results", year, round],
    queryFn: () => getRaceResults(year, round!),
    // Past races are immutable, so cache long. The hook is only fired
    // for completed races so we never miss in-progress data.
    enabled: round != null,
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
}
