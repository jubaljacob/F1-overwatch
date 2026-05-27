"use client";

import { currentFrame, usePlaybackStore } from "@/lib/replay-engine/playback-store";
import type { LapRecord, RaceData } from "@traceline/shared-types";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Props {
  raceData: RaceData;
}

interface SectorRow {
  sector: "S1" | "S2" | "S3";
  /** Per-driver delta in seconds. Recharts indexes bars off the column key. */
  [driverCode: string]: number | string | null;
}

/** Sector-time deltas vs the reference driver for the reference driver's
 *  current lap. Three rows (S1, S2, S3) × one bar per comparison driver. */
export function SectorBreakdownChart({ raceData }: Props) {
  const selected = usePlaybackStore((s) => s.selectedDrivers);
  const reference = usePlaybackStore((s) => s.referenceDriver);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const effectiveReference = reference ?? selected[0] ?? null;

  // Which lap to score against. We use the reference driver's current lap so
  // the chart reads "how is X doing this lap vs the reference's current
  // lap". Fall back to the leader's lap if the reference isn't yet in frame.
  const lap = useMemo(() => {
    const f = currentFrame(raceData, currentTime);
    if (!f) return null;
    if (effectiveReference != null && f.p[effectiveReference]) {
      return f.p[effectiveReference]!.lap;
    }
    let maxLap = 0;
    for (const s of Object.values(f.p)) if (s.lap > maxLap) maxLap = s.lap;
    return maxLap || null;
  }, [raceData, currentTime, effectiveReference]);

  const { rows, drivers } = useMemo(() => {
    if (!effectiveReference || lap == null) return { rows: [] as SectorRow[], drivers: [] };

    const driverByNum = new Map(raceData.drivers.map((d) => [d.number, d]));
    const byKey = new Map<string, LapRecord>(); // `${driver}:${lap}` -> LapRecord
    for (const lr of raceData.laps) byKey.set(`${lr.driver}:${lr.lap}`, lr);

    const refLap = byKey.get(`${effectiveReference}:${lap}`);
    if (!refLap) return { rows: [] as SectorRow[], drivers: [] };

    const comparisons = selected
      .filter((n) => n !== effectiveReference)
      .map((n) => ({ num: n, info: driverByNum.get(n), lapRec: byKey.get(`${n}:${lap}`) }))
      .filter(
        (c): c is { num: number; info: NonNullable<typeof c.info>; lapRec: LapRecord } =>
          c.info != null && c.lapRec != null,
      );

    if (comparisons.length === 0) return { rows: [] as SectorRow[], drivers: [] };

    const sectorKeys: Array<{ key: "S1" | "S2" | "S3"; ref: number | null | undefined; pick: (l: LapRecord) => number | null | undefined }> = [
      { key: "S1", ref: refLap.sector_1_s, pick: (l) => l.sector_1_s },
      { key: "S2", ref: refLap.sector_2_s, pick: (l) => l.sector_2_s },
      { key: "S3", ref: refLap.sector_3_s, pick: (l) => l.sector_3_s },
    ];

    const rows: SectorRow[] = sectorKeys.map(({ key, ref, pick }) => {
      const row: SectorRow = { sector: key };
      for (const c of comparisons) {
        const v = pick(c.lapRec);
        row[c.info.code] = v != null && ref != null ? +(v - ref).toFixed(3) : null;
      }
      return row;
    });

    const drivers = comparisons.map((c) => ({
      code: c.info.code,
      colour: c.info.team_colour ? `#${c.info.team_colour}` : "#888",
    }));

    return { rows, drivers };
  }, [raceData, selected, effectiveReference, lap]);

  if (!effectiveReference) {
    return <EmptyState text="Select a driver to start comparing." />;
  }
  if (lap == null) {
    return <EmptyState text="Waiting for frames…" />;
  }
  if (drivers.length === 0) {
    return (
      <EmptyState
        text={
          selected.length < 2
            ? "Pick a second driver to see sector deltas."
            : `No sector data for lap ${lap} yet.`
        }
      />
    );
  }

  const refDriver = raceData.drivers.find((d) => d.number === effectiveReference);

  return (
    <div className="flex h-full w-full flex-col gap-2">
      <div className="text-muted-foreground flex items-center justify-between gap-4 px-3 pt-2 text-xs">
        <span>
          Sectors L{lap} vs{" "}
          <span className="text-foreground font-semibold">{refDriver?.code}</span> (Δ s, positive = slower)
        </span>
        <span className="text-foreground/40 text-[10px]">{drivers.length} compared</span>
      </div>
      <div className="min-h-[160px] flex-1 px-2 pb-2">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 6, right: 16, left: 4, bottom: 8 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" strokeDasharray="2 2" />
            <XAxis
              dataKey="sector"
              tick={{ fill: "rgba(255,255,255,0.55)", fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.18)" }}
            />
            <YAxis
              tick={{ fill: "rgba(255,255,255,0.55)", fontSize: 10 }}
              tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}s`}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.18)" }}
              width={48}
            />
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.35)" />
            <Tooltip
              contentStyle={{
                background: "rgba(15,15,20,0.95)",
                border: "1px solid rgba(255,255,255,0.12)",
                borderRadius: 4,
                fontSize: 12,
              }}
              cursor={{ fill: "rgba(255,255,255,0.06)" }}
              formatter={(v: number, code: string) => [
                `${v > 0 ? "+" : ""}${v.toFixed(3)}s`,
                code,
              ]}
            />
            {drivers.map((d) => (
              <Bar key={d.code} dataKey={d.code} isAnimationActive={false}>
                {rows.map((r) => {
                  const v = r[d.code];
                  // Subtle hint: green when faster than reference, team colour
                  // when slower. Tints make it readable at a glance without
                  // adding a legend.
                  const fill =
                    typeof v === "number" && v < 0 ? "rgba(120,220,140,0.85)" : d.colour;
                  return <Cell key={`${d.code}-${r.sector}`} fill={fill} />;
                })}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-xs">
      {text}
    </div>
  );
}
