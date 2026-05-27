"use client";

import { currentFrame, usePlaybackStore } from "@/lib/replay-engine/playback-store";
import type { DriverInfo, LapRecord, RaceData } from "@traceline/shared-types";
import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Props {
  raceData: RaceData;
}

interface Stint {
  driverNum: number;
  driverCode: string;
  driverColour: string;
  stintNumber: number;
  compound: string;
  startLap: number;
  endLap: number;
  laps: Array<{ lap: number; time: number }>;
  fastestLap: { lap: number; time: number } | null;
}

const COMPOUND_COLOURS: Record<string, string> = {
  SOFT: "#ef4444",
  MEDIUM: "#fbbf24",
  HARD: "#e5e7eb",
  INTERMEDIATE: "#10b981",
  WET: "#3b82f6",
};

const COMPOUND_SHORT: Record<string, string> = {
  SOFT: "SFT",
  MEDIUM: "MED",
  HARD: "HRD",
  INTERMEDIATE: "INT",
  WET: "WET",
};

/** Lap-time scatter grouped by stint. For every selected driver, draw one
 *  line per stint coloured by compound, with the cluster of points telling
 *  you how the tyres degraded across that stint.
 *
 *  Pit stops show up as gaps between stints (the line break is the lap on
 *  which the driver entered the pits). Pace cliff toward the end of a stint
 *  is visible as upward drift; a fresh-tyre boost is the dip at the start
 *  of the next stint. */
export function StintAnalysisChart({ raceData }: Props) {
  const selected = usePlaybackStore((s) => s.selectedDrivers);
  const reference = usePlaybackStore((s) => s.referenceDriver);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const effectiveReference = reference ?? selected[0] ?? null;

  const currentLap = useMemo(() => {
    const f = currentFrame(raceData, currentTime);
    if (!f) return null;
    if (effectiveReference != null && f.p[effectiveReference]) {
      return f.p[effectiveReference]!.lap;
    }
    let maxLap = 0;
    for (const s of Object.values(f.p)) if (s.lap > maxLap) maxLap = s.lap;
    return maxLap || null;
  }, [raceData, currentTime, effectiveReference]);

  const driverByNum = useMemo(
    () => new Map(raceData.drivers.map((d) => [d.number, d])),
    [raceData],
  );

  const stintsByDriver = useMemo(() => {
    if (selected.length === 0) return [];
    return selected
      .map((num) => {
        const info = driverByNum.get(num);
        if (!info) return null;
        const stints = buildStints(raceData.laps, num, info);
        if (stints.length === 0) return null;
        return { driver: info, stints };
      })
      .filter((d): d is { driver: DriverInfo; stints: Stint[] } => d != null);
  }, [raceData.laps, selected, driverByNum]);

  if (selected.length === 0) {
    return <EmptyState text="Select a driver to see their tyre stints." />;
  }
  if (stintsByDriver.length === 0) {
    return <EmptyState text="No completed lap data for the selected drivers yet." />;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground flex items-center justify-between gap-4 px-3 pt-2 text-xs">
        <span>Lap times by tyre stint</span>
        <span className="text-foreground/40 text-[10px]">
          point colour = compound · line break = pit stop
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2 pt-1">
        {stintsByDriver.map(({ driver, stints }) => (
          <DriverStintBlock
            key={driver.number}
            driver={driver}
            stints={stints}
            currentLap={currentLap}
          />
        ))}
      </div>
    </div>
  );
}

function DriverStintBlock({
  driver,
  stints,
  currentLap,
}: {
  driver: DriverInfo;
  stints: Stint[];
  currentLap: number | null;
}) {
  const colour = driver.team_colour ? `#${driver.team_colour}` : "#888";

  // Build a single dataset row-per-lap; each stint gets its own column
  // keyed by stint-N so Recharts draws separate lines with breaks at pit
  // stops automatically (other stints' values are null on that lap).
  const data = useMemo(() => {
    if (stints.length === 0) return [];
    const minLap = stints[0]!.startLap;
    const maxLap = stints[stints.length - 1]!.endLap;
    const rows: Array<Record<string, number | null>> = [];
    for (let lap = minLap; lap <= maxLap; lap++) {
      const row: Record<string, number | null> = { lap };
      for (const stint of stints) {
        const key = `stint${stint.stintNumber}`;
        const hit = stint.laps.find((l) => l.lap === lap);
        row[key] = hit?.time ?? null;
      }
      rows.push(row);
    }
    return rows;
  }, [stints]);

  const allTimes = stints.flatMap((s) => s.laps.map((l) => l.time));
  const yMin = allTimes.length > 0 ? Math.min(...allTimes) - 0.5 : 0;
  const yMax = allTimes.length > 0 ? Math.max(...allTimes) + 0.5 : 100;

  return (
    <div className="rounded border border-foreground/10 bg-foreground/[0.03] p-2">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span
          className="inline-block h-3 w-1 rounded-sm"
          style={{ backgroundColor: colour }}
          aria-hidden
        />
        <span className="text-xs font-semibold">{driver.code}</span>
        <div className="flex flex-wrap items-center gap-1">
          {stints.map((s) => (
            <StintChip key={s.stintNumber} stint={s} />
          ))}
        </div>
      </div>
      <div className="h-[120px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="2 2" />
            <XAxis
              dataKey="lap"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 9 }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.18)" }}
            />
            <YAxis
              domain={[yMin, yMax]}
              tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 9 }}
              tickFormatter={(v: number) => `${v.toFixed(1)}s`}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.18)" }}
              width={42}
            />
            {currentLap != null && (
              <ReferenceLine
                x={currentLap}
                stroke="rgba(245,200,90,0.7)"
                strokeWidth={1.2}
                ifOverflow="extendDomain"
              />
            )}
            <Tooltip
              contentStyle={{
                background: "rgba(15,15,20,0.95)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 4,
                fontSize: 12,
                color: "#fff",
              }}
              labelStyle={{ color: "#fff" }}
              itemStyle={{ color: "#fff" }}
              labelFormatter={(lap) => `Lap ${lap}`}
              formatter={(value, name) => {
                const time = typeof value === "number" ? value.toFixed(3) : "—";
                const idx = Number(String(name).replace("stint", ""));
                const stint = stints[idx - 1];
                const label = stint
                  ? `${COMPOUND_SHORT[stint.compound] ?? stint.compound} (stint ${stint.stintNumber})`
                  : String(name);
                return [`${time}s`, label];
              }}
            />
            {stints.map((stint) => {
              const stintColour = COMPOUND_COLOURS[stint.compound] ?? colour;
              return (
                <Line
                  key={stint.stintNumber}
                  type="monotone"
                  dataKey={`stint${stint.stintNumber}`}
                  stroke={stintColour}
                  strokeWidth={1.5}
                  dot={{ r: 2.5, fill: stintColour, strokeWidth: 0 }}
                  activeDot={{ r: 4, fill: stintColour, strokeWidth: 0 }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function StintChip({ stint }: { stint: Stint }) {
  const colour = COMPOUND_COLOURS[stint.compound] ?? "#888";
  return (
    <span
      className="inline-flex items-center gap-1 rounded border px-1.5 py-px text-[9px] font-semibold uppercase tracking-widest"
      style={{
        background: `${colour}25`,
        borderColor: `${colour}66`,
        color: "#fff",
      }}
      title={
        stint.fastestLap
          ? `${stint.compound} · laps ${stint.startLap}-${stint.endLap} · ` +
            `fastest L${stint.fastestLap.lap}: ${stint.fastestLap.time.toFixed(3)}s`
          : `${stint.compound} · laps ${stint.startLap}-${stint.endLap}`
      }
    >
      <span>{COMPOUND_SHORT[stint.compound] ?? stint.compound.slice(0, 3)}</span>
      <span className="opacity-80 tabular-nums">
        L{stint.startLap}-{stint.endLap}
      </span>
      {stint.fastestLap && (
        <span className="opacity-60 tabular-nums">
          {stint.fastestLap.time.toFixed(2)}s
        </span>
      )}
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-xs">
      {text}
    </div>
  );
}

/** Group a driver's lap records into stints (contiguous runs on the same
 *  compound) and pull out the per-lap timing for each one. */
function buildStints(
  laps: readonly LapRecord[],
  driverNum: number,
  driver: DriverInfo,
): Stint[] {
  const driverLaps = laps
    .filter((l) => l.driver === driverNum)
    .filter((l) => l.compound != null)
    .sort((a, b) => a.lap - b.lap);
  if (driverLaps.length === 0) return [];

  const stints: Stint[] = [];
  let currentCompound: string | null = null;
  let currentStint: Stint | null = null;
  const colour = driver.team_colour ? `#${driver.team_colour}` : "#888";

  for (const lap of driverLaps) {
    const c = lap.compound!.toUpperCase();
    if (c !== currentCompound) {
      if (currentStint) stints.push(currentStint);
      currentCompound = c;
      currentStint = {
        driverNum,
        driverCode: driver.code,
        driverColour: colour,
        stintNumber: stints.length + 1,
        compound: c,
        startLap: lap.lap,
        endLap: lap.lap,
        laps: [],
        fastestLap: null,
      };
    }
    if (currentStint == null) continue;
    currentStint.endLap = lap.lap;
    if (lap.lap_time_s != null && lap.lap_time_s > 0) {
      const entry = { lap: lap.lap, time: lap.lap_time_s };
      currentStint.laps.push(entry);
      if (!currentStint.fastestLap || entry.time < currentStint.fastestLap.time) {
        currentStint.fastestLap = entry;
      }
    }
  }
  if (currentStint) stints.push(currentStint);
  return stints;
}
