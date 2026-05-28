"use client";

import { usePlaybackStore } from "@/lib/replay-engine/playback-store";
import type { DriverInfo, Frame, QualiSegment, RaceData } from "@traceline/shared-types";
import { useMemo } from "react";

interface Props {
  raceData: RaceData;
  segment: QualiSegment;
  frame: Frame | null;
}

interface Row {
  driver: DriverInfo;
  best_lap_s: number | null;
  lap_number: number | null;
  gap_to_p1_s: number | null;
}

/** Static ranking for a qualifying segment.
 *
 *  For each driver, finds their fastest valid lap whose `quali_segment`
 *  matches the requested segment, then sorts ascending by lap time.
 *  Drivers who set no time in this segment fall to the bottom in driver-
 *  number order — keeping the list complete is useful context (you can
 *  see who was eliminated in Q1, who skipped Q3, etc.). */
export function QualiLeaderboard({ raceData, segment, frame }: Props) {
  const selected = usePlaybackStore((s) => s.selectedDrivers);
  const reference = usePlaybackStore((s) => s.referenceDriver);
  const toggleSelected = usePlaybackStore((s) => s.toggleSelectedDriver);
  const setReference = usePlaybackStore((s) => s.setReferenceDriver);

  const rows = useMemo<Row[]>(() => {
    const driverLookup = new Map(raceData.drivers.map((d) => [d.number, d]));
    const bestByDriver = new Map<number, { time: number; lap: number }>();
    for (const lap of raceData.laps) {
      if (lap.quali_segment !== segment) continue;
      if (lap.lap_time_s == null) continue;
      // Skip in-laps (driver entering pits at end of flying lap) and
      // out-laps (just leaving pits, not a representative time).
      if (lap.pit_in || lap.pit_out) continue;
      const prev = bestByDriver.get(lap.driver);
      if (!prev || lap.lap_time_s < prev.time) {
        bestByDriver.set(lap.driver, { time: lap.lap_time_s, lap: lap.lap });
      }
    }

    const ranked: Row[] = [];
    const unranked: Row[] = [];
    for (const d of raceData.drivers) {
      const best = bestByDriver.get(d.number);
      if (best) {
        ranked.push({
          driver: d,
          best_lap_s: best.time,
          lap_number: best.lap,
          gap_to_p1_s: null,
        });
      } else {
        unranked.push({
          driver: d,
          best_lap_s: null,
          lap_number: null,
          gap_to_p1_s: null,
        });
      }
    }
    ranked.sort((a, b) => (a.best_lap_s ?? 0) - (b.best_lap_s ?? 0));
    const p1 = ranked[0]?.best_lap_s ?? null;
    if (p1 != null) {
      for (const r of ranked) r.gap_to_p1_s = (r.best_lap_s ?? 0) - p1;
    }
    unranked.sort((a, b) => a.driver.number - b.driver.number);
    void driverLookup;
    return [...ranked, ...unranked];
  }, [raceData, segment]);

  return (
    <div className="flex flex-col gap-px p-2 text-xs">
      <div className="text-muted-foreground mb-1 flex items-center justify-between px-1 text-[10px] uppercase tracking-widest">
        <span>{segment} ranking</span>
        <span>{rows.filter((r) => r.best_lap_s != null).length} timed</span>
      </div>
      {rows.map((row, idx) => {
        const isSelected = selected.includes(row.driver.number);
        const isReference = reference === row.driver.number;
        const position = row.best_lap_s != null ? idx + 1 : null;
        const colour = row.driver.team_colour ? `#${row.driver.team_colour}` : "#888";
        const sample = frame?.p?.[String(row.driver.number)];
        return (
          <button
            key={row.driver.number}
            type="button"
            onClick={() => toggleSelected(row.driver.number)}
            onDoubleClick={() => setReference(row.driver.number)}
            className={`flex items-center gap-2 rounded px-2 py-1 text-left transition-colors ${
              isSelected
                ? "bg-foreground/15"
                : "hover:bg-foreground/5"
            } ${isReference ? "ring-1 ring-amber-400/60" : ""}`}
            title={
              row.best_lap_s != null
                ? `Best ${segment}: ${formatLapTime(row.best_lap_s)} (lap ${row.lap_number})`
                : `No timed lap in ${segment}`
            }
          >
            <span className="text-muted-foreground w-5 text-right text-[10px] tabular-nums">
              {position ?? "—"}
            </span>
            <span
              className="h-3 w-1 shrink-0 rounded-sm"
              style={{ backgroundColor: colour }}
              aria-hidden
            />
            <span className="w-9 font-mono text-[11px] font-semibold">
              {row.driver.code}
            </span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
              {row.driver.team}
            </span>
            <span className="font-mono text-[11px] tabular-nums">
              {row.best_lap_s != null ? formatLapTime(row.best_lap_s) : "—"}
            </span>
            <span className="text-muted-foreground w-14 text-right font-mono text-[10px] tabular-nums">
              {row.gap_to_p1_s != null && row.gap_to_p1_s > 0
                ? `+${row.gap_to_p1_s.toFixed(3)}`
                : row.best_lap_s != null && row.gap_to_p1_s === 0
                  ? "—"
                  : ""}
            </span>
            {sample && sample.st !== "out" ? (
              <span className="ml-1 flex items-center gap-1 text-[9px] tabular-nums">
                <span className="text-foreground/70">{Math.round(sample.spd)}</span>
                <span className="text-muted-foreground">kph</span>
                {sample.gear != null && sample.gear > 0 && (
                  <span className="text-foreground/60">G{sample.gear}</span>
                )}
                <span
                  className={`rounded px-1 py-px text-[8px] font-semibold uppercase tracking-widest ${
                    sample.drs
                      ? "bg-emerald-500/30 text-emerald-200"
                      : "text-foreground/25"
                  }`}
                >
                  DRS
                </span>
              </span>
            ) : (
              <span className="ml-1 w-16" />
            )}
          </button>
        );
      })}
    </div>
  );
}

function formatLapTime(s: number): string {
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem.toFixed(3).padStart(6, "0")}`;
}
