"use client";

import { computeLeaderboard } from "@/lib/replay-engine/leaderboard";
import { usePlaybackStore } from "@/lib/replay-engine/playback-store";
import type { DriverInfo, Frame, RaceData } from "@traceline/shared-types";
import { useMemo } from "react";

interface Props {
  raceData: RaceData;
  frame: Frame | null;
}

export function Leaderboard({ raceData, frame }: Props) {
  const focused = usePlaybackStore((s) => s.focusedDriver);
  const toggleFocused = usePlaybackStore((s) => s.toggleFocusedDriver);

  const driverLookup = useMemo<Map<number, DriverInfo>>(
    () => new Map(raceData.drivers.map((d) => [d.number, d])),
    [raceData],
  );
  const rows = useMemo(
    () => computeLeaderboard(raceData, frame, driverLookup),
    [raceData, frame, driverLookup],
  );

  const leaderLap = rows[0]?.lap ?? 0;
  const totalLaps = raceData.meta.total_laps || leaderLap;

  if (rows.length === 0) {
    return <p className="text-muted-foreground p-4 text-sm">Waiting for frames…</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="bg-background/95 sticky top-0 z-10 flex items-center justify-between border-b border-foreground/10 px-3 py-2 text-xs uppercase tracking-widest">
        <span className="text-muted-foreground">Leaderboard</span>
        <span className="font-mono tabular-nums">
          Lap {leaderLap}
          {totalLaps ? ` / ${totalLaps}` : ""}
        </span>
      </div>
      <ol className="divide-foreground/10 flex-1 divide-y overflow-y-auto text-sm">
        {rows.map((r) => {
          const isFocused = focused === r.driver.number;
          return (
            <li key={r.driver.number}>
              <button
                type="button"
                onClick={() => toggleFocused(r.driver.number)}
                className={`flex w-full items-center gap-3 px-3 py-1.5 tabular-nums text-left transition-colors ${
                  isFocused
                    ? "bg-foreground/10"
                    : focused != null
                      ? "opacity-50 hover:bg-foreground/5"
                      : "hover:bg-foreground/5"
                }`}
                style={{ opacity: r.status === "out" ? 0.35 : undefined }}
                aria-pressed={isFocused}
              >
                <span className="text-muted-foreground w-5 text-right">{r.position}</span>
                <span
                  className="inline-block h-3 w-1 rounded-sm"
                  style={{
                    backgroundColor: r.driver.team_colour ? `#${r.driver.team_colour}` : "#888",
                  }}
                  aria-hidden
                />
                <span className="w-10 font-semibold">{r.driver.code}</span>
                <span className="text-muted-foreground w-10 text-right text-xs">L{r.lap}</span>
                <span className="ml-auto flex flex-col items-end leading-tight">
                  <span className="text-xs">
                    {r.position === 1 ? (
                      <span className="text-foreground/80">LEADER</span>
                    ) : (
                      <span className="text-muted-foreground">+{r.gapToLeader.toFixed(3)}s</span>
                    )}
                  </span>
                  {r.position > 1 && (
                    <span className="text-foreground/40 text-[10px]">
                      Δ {r.gapToAhead.toFixed(3)}s
                    </span>
                  )}
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
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
