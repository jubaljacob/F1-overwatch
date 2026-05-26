"use client";

import { computeLeaderboard } from "@/lib/replay-engine/leaderboard";
import type { DriverInfo, Frame, RaceData } from "@traceline/shared-types";
import { useMemo } from "react";

interface Props {
  raceData: RaceData;
  frame: Frame | null;
}

export function Leaderboard({ raceData, frame }: Props) {
  const driverLookup = useMemo<Map<number, DriverInfo>>(
    () => new Map(raceData.drivers.map((d) => [d.number, d])),
    [raceData],
  );
  const rows = useMemo(
    () => computeLeaderboard(raceData, frame, driverLookup),
    [raceData, frame, driverLookup],
  );

  if (rows.length === 0) {
    return <p className="text-muted-foreground p-4 text-sm">Waiting for frames…</p>;
  }

  return (
    <ol className="divide-foreground/10 divide-y text-sm">
      {rows.map((r) => (
        <li
          key={r.driver.number}
          className="flex items-center gap-3 px-3 py-1.5 tabular-nums"
          style={{ opacity: r.status === "out" ? 0.35 : 1 }}
        >
          <span className="text-muted-foreground w-5 text-right">{r.position}</span>
          <span
            className="inline-block h-3 w-1 rounded-sm"
            style={{ backgroundColor: r.driver.team_colour ? `#${r.driver.team_colour}` : "#888" }}
            aria-hidden
          />
          <span className="w-10 font-semibold">{r.driver.code}</span>
          <span className="text-muted-foreground w-12 text-right text-xs">L{r.lap}</span>
          <span className="text-muted-foreground ml-auto text-xs">
            {r.position === 1 ? "LEADER" : `+${r.gapToLeader.toFixed(3)}s`}
          </span>
          {r.status === "pit" && (
            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-300">
              PIT
            </span>
          )}
          {r.status === "out" && (
            <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-300">
              OUT
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
