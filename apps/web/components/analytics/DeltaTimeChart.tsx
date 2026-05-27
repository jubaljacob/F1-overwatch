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

interface ChartRow {
  lap: number;
  [driverCode: string]: number | null;
}

/** Per-lap lap-time delta vs the reference driver, in seconds.
 *  Positive => the line driver was slower than reference that lap. */
export function DeltaTimeChart({ raceData }: Props) {
  const selected = usePlaybackStore((s) => s.selectedDrivers);
  const reference = usePlaybackStore((s) => s.referenceDriver);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const effectiveReference = reference ?? selected[0] ?? null;

  // Lap cursor = the lap the reference driver is currently on, or the leader's
  // lap as a fallback when reference data is missing. Falling back to the
  // leader keeps the cursor sensible at race start before the reference has
  // a frame.
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

  const { data, lines, pitLapsByCode } = useMemo(() => {
    if (!effectiveReference) {
      return { data: [] as ChartRow[], lines: [], pitLapsByCode: new Map<string, Set<number>>() };
    }

    const driverByNum = new Map(raceData.drivers.map((d) => [d.number, d]));
    const lapTimes = lapTimesByDriverAndLap(raceData.laps);
    const pitLaps = pitLapsByDriver(raceData.laps);
    const refTimes = lapTimes.get(effectiveReference);
    if (!refTimes) {
      return { data: [] as ChartRow[], lines: [], pitLapsByCode: new Map<string, Set<number>>() };
    }

    const comparisons = selected.filter((n) => n !== effectiveReference);
    if (comparisons.length === 0) {
      return { data: [] as ChartRow[], lines: [], pitLapsByCode: new Map<string, Set<number>>() };
    }

    // Build chart rows keyed by lap, only for laps where the reference has a
    // valid time. A driver missing a lap (DNF, pit-cycle outlier, deleted)
    // shows up as null and Recharts draws a gap.
    const laps = [...refTimes.keys()].sort((a, b) => a - b);
    const rows: ChartRow[] = laps.map((lap) => {
      const row: ChartRow = { lap };
      const refT = refTimes.get(lap)!;
      for (const num of comparisons) {
        const info = driverByNum.get(num);
        if (!info) continue;
        const drvT = lapTimes.get(num)?.get(lap);
        row[info.code] = drvT != null ? +(drvT - refT).toFixed(3) : null;
      }
      return row;
    });

    const lines = comparisons
      .map((num) => driverByNum.get(num))
      .filter((d): d is DriverInfo => d != null)
      .map((d) => ({
        code: d.code,
        colour: d.team_colour ? `#${d.team_colour}` : "#888",
        pitLaps: pitLaps.get(d.number) ?? new Set<number>(),
      }));

    const pitLapsByCode = new Map<string, Set<number>>(
      lines.map((l) => [l.code, l.pitLaps]),
    );

    return { data: rows, lines, pitLapsByCode };
  }, [raceData, selected, effectiveReference]);

  if (!effectiveReference) {
    return <EmptyState text="Select a driver to start comparing." />;
  }
  if (lines.length === 0) {
    return <EmptyState text="Pick a second driver to see lap-time deltas." />;
  }

  const refDriver = raceData.drivers.find((d) => d.number === effectiveReference);

  return (
    <div className="flex h-full w-full flex-col gap-2">
      <div className="text-muted-foreground flex items-center justify-between gap-4 px-3 pt-2 text-xs">
        <span>
          Δ lap-time vs <span className="text-foreground font-semibold">{refDriver?.code}</span>{" "}
          (seconds, positive = slower)
        </span>
        <span className="text-foreground/40 text-[10px]">
          ◇ pit stop · vertical line = current lap
        </span>
      </div>
      <div className="min-h-[200px] flex-1 px-2 pb-2">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 16, left: 4, bottom: 8 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="2 2" />
            <XAxis
              dataKey="lap"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fill: "rgba(255,255,255,0.55)", fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.18)" }}
            />
            <YAxis
              tick={{ fill: "rgba(255,255,255,0.55)", fontSize: 10 }}
              tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}s`}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.18)" }}
              width={42}
            />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.35)" strokeDasharray="2 2" />
            {currentLap != null && (
              <ReferenceLine
                x={currentLap}
                stroke="rgba(245,200,90,0.85)"
                strokeWidth={1.5}
                ifOverflow="extendDomain"
                label={{
                  value: `L${currentLap}`,
                  position: "top",
                  fill: "rgba(245,200,90,0.85)",
                  fontSize: 10,
                }}
              />
            )}
            <Tooltip
              contentStyle={{
                background: "rgba(15,15,20,0.95)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 4,
                fontSize: 12,
              }}
              labelFormatter={(lap) => `Lap ${lap}`}
              formatter={(v: number, code: string) => [
                `${v > 0 ? "+" : ""}${v.toFixed(3)}s`,
                code,
              ]}
            />
            {lines.map((l) => (
              <Line
                key={l.code}
                type="linear"
                dataKey={l.code}
                stroke={l.colour}
                strokeWidth={1.5}
                dot={renderPitDot(l.code, l.colour, pitLapsByCode)}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function lapTimesByDriverAndLap(
  laps: readonly LapRecord[],
): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  for (const lr of laps) {
    if (lr.lap_time_s == null || lr.lap_time_s <= 0) continue;
    let m = out.get(lr.driver);
    if (!m) {
      m = new Map();
      out.set(lr.driver, m);
    }
    m.set(lr.lap, lr.lap_time_s);
  }
  return out;
}

/** Laps on which a driver pitted (either entering or exiting the pit lane).
 *  Either flag counts as "this lap was a pit lap" for the purposes of
 *  marking the chart — a one-glyph annotation per stop is plenty. */
function pitLapsByDriver(laps: readonly LapRecord[]): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (const lr of laps) {
    if (!lr.pit_in && !lr.pit_out) continue;
    let s = out.get(lr.driver);
    if (!s) {
      s = new Set();
      out.set(lr.driver, s);
    }
    s.add(lr.lap);
  }
  return out;
}

interface RechartsDotProps {
  cx?: number;
  cy?: number;
  payload?: { lap: number };
  value?: number | null;
  index?: number;
}

/** Custom Recharts dot renderer: draws a small diamond on pit laps, nothing
 *  elsewhere. Recharts maps over the data per series; React needs each
 *  returned element to have a unique key, so we synthesise one from
 *  `code:lap` (driver + lap is unique across the chart).
 */
function renderPitDot(
  code: string,
  colour: string,
  pitLapsByCode: Map<string, Set<number>>,
): (props: RechartsDotProps) => React.ReactElement {
  return ({ cx, cy, payload, value, index }: RechartsDotProps) => {
    const lap = payload?.lap;
    const key = `${code}-${lap ?? index ?? 0}`;
    if (cx == null || cy == null || lap == null || value == null) {
      return <g key={key} />;
    }
    const pitLaps = pitLapsByCode.get(code);
    if (!pitLaps?.has(lap)) return <g key={key} />;
    const r = 4;
    return (
      <polygon
        key={key}
        points={`${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`}
        fill="rgba(15,15,20,0.95)"
        stroke={colour}
        strokeWidth={1.5}
      />
    );
  };
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-xs">
      {text}
    </div>
  );
}
