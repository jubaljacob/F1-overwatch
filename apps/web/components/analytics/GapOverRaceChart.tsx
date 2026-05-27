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

/** Cumulative race-time gap vs the reference driver, lap by lap.
 *  Positive => the driver was behind reference at the end of that lap. */
export function GapOverRaceChart({ raceData }: Props) {
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

  const { data, lines } = useMemo(() => {
    if (!effectiveReference) return { data: [] as ChartRow[], lines: [] };

    const driverByNum = new Map(raceData.drivers.map((d) => [d.number, d]));
    const cumulative = cumulativeTimeByDriverAndLap(raceData.laps);
    const refCum = cumulative.get(effectiveReference);
    if (!refCum) return { data: [] as ChartRow[], lines: [] };

    // Include the reference itself (always 0) so it shows as a baseline.
    const includes = selected.includes(effectiveReference)
      ? selected
      : [effectiveReference, ...selected];

    const driverObjs = includes
      .map((num) => driverByNum.get(num))
      .filter((d): d is DriverInfo => d != null);
    if (driverObjs.length < 1) return { data: [] as ChartRow[], lines: [] };

    const laps = [...refCum.keys()].sort((a, b) => a - b);
    const rows: ChartRow[] = laps.map((lap) => {
      const row: ChartRow = { lap };
      const refT = refCum.get(lap)!;
      for (const d of driverObjs) {
        const drvT = cumulative.get(d.number)?.get(lap);
        row[d.code] = drvT != null ? +(drvT - refT).toFixed(3) : null;
      }
      return row;
    });

    const lines = driverObjs.map((d) => ({
      code: d.code,
      colour: d.team_colour ? `#${d.team_colour}` : "#888",
      isReference: d.number === effectiveReference,
    }));

    return { data: rows, lines };
  }, [raceData, selected, effectiveReference]);

  if (!effectiveReference) {
    return <EmptyState text="Select a driver to start comparing." />;
  }
  if (lines.length === 0) {
    return <EmptyState text="No lap-time data to chart a gap." />;
  }

  const refDriver = raceData.drivers.find((d) => d.number === effectiveReference);

  return (
    <div className="flex h-full w-full flex-col gap-2">
      <div className="text-muted-foreground flex items-center justify-between gap-4 px-3 pt-2 text-xs">
        <span>
          Cumulative gap vs{" "}
          <span className="text-foreground font-semibold">{refDriver?.code}</span> (s, positive = behind)
        </span>
        <span className="text-foreground/40 text-[10px]">vertical line = current lap</span>
      </div>
      <div className="min-h-[160px] flex-1 px-2 pb-2">
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
              tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)}s`}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.18)" }}
              width={48}
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
                `${v > 0 ? "+" : ""}${v.toFixed(2)}s`,
                code,
              ]}
            />
            {lines.map((l) => (
              <Line
                key={l.code}
                type="monotone"
                dataKey={l.code}
                stroke={l.colour}
                strokeWidth={l.isReference ? 2.5 : 1.5}
                strokeDasharray={l.isReference ? undefined : undefined}
                dot={false}
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

/** Build per-driver maps of lap → cumulative race time (sum of lap_time_s up
 *  to and including this lap). Drivers with missing lap times don't get an
 *  entry for that lap, so the chart draws a gap. */
function cumulativeTimeByDriverAndLap(
  laps: readonly LapRecord[],
): Map<number, Map<number, number>> {
  // Bucket per driver, sort by lap, accumulate.
  const byDriver = new Map<number, LapRecord[]>();
  for (const lr of laps) {
    if (lr.lap_time_s == null || lr.lap_time_s <= 0) continue;
    const arr = byDriver.get(lr.driver) ?? [];
    arr.push(lr);
    byDriver.set(lr.driver, arr);
  }
  const out = new Map<number, Map<number, number>>();
  for (const [driver, records] of byDriver) {
    records.sort((a, b) => a.lap - b.lap);
    const m = new Map<number, number>();
    let total = 0;
    for (const r of records) {
      total += r.lap_time_s ?? 0;
      m.set(r.lap, total);
    }
    out.set(driver, m);
  }
  return out;
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-xs">
      {text}
    </div>
  );
}
