"use client";

import type { LapRecord, RaceData, SimulationOut } from "@traceline/shared-types";
import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface Props {
  raceData: RaceData;
  driverNum: number;
  result: SimulationOut | null;
  busy?: boolean;
}

interface Row {
  lap: number;
  actual: number | null;
  predicted: number | null;
}

const PREDICTED_COLOUR = "rgba(245,200,90,0.95)"; // amber, matches cursors in P3
const ACTUAL_COLOUR_FALLBACK = "rgba(160,200,255,0.85)";

export function StrategyResultChart({ raceData, driverNum, result, busy }: Props) {
  const driver = useMemo(
    () => raceData.drivers.find((d) => d.number === driverNum),
    [raceData, driverNum],
  );

  const data = useMemo<Row[]>(() => {
    const actualByLap = new Map<number, number>();
    for (const lr of raceData.laps as LapRecord[]) {
      if (lr.driver !== driverNum) continue;
      if (lr.lap_time_s == null || lr.lap_time_s <= 0) continue;
      actualByLap.set(lr.lap, lr.lap_time_s);
    }
    const predictedByLap = new Map<number, number>();
    if (result) {
      for (const lp of result.laps) predictedByLap.set(lp.lap, lp.predicted_lap_time_s);
    }
    const allLaps = new Set<number>([...actualByLap.keys(), ...predictedByLap.keys()]);
    const sorted = [...allLaps].sort((a, b) => a - b);
    return sorted.map((lap) => ({
      lap,
      actual: actualByLap.get(lap) ?? null,
      predicted: predictedByLap.get(lap) ?? null,
    }));
  }, [raceData, driverNum, result]);

  const actualColour = driver?.team_colour
    ? `#${driver.team_colour}`
    : ACTUAL_COLOUR_FALLBACK;

  if (!result) {
    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <Header driverCode={driver?.code} />
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-xs">
          {busy ? "Simulating…" : "Edit a strategy and click Simulate to see predicted lap times."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-1 p-3">
      <Header
        driverCode={driver?.code}
        actualTotal={result.actual_total_race_time_s}
        predictedTotal={result.total_race_time_s}
        delta={result.delta_to_actual_s}
        finishingPosition={result.finishing_position}
      />
      <div className="min-h-[140px] flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 12, left: 4, bottom: 8 }}>
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
              tickFormatter={(v: number) => `${v.toFixed(1)}s`}
              tickLine={false}
              axisLine={{ stroke: "rgba(255,255,255,0.18)" }}
              width={48}
              domain={["auto", "auto"]}
            />
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
              formatter={(value, name) => [
                typeof value === "number" ? `${value.toFixed(3)}s` : "—",
                String(name),
              ]}
            />
            <Line
              type="monotone"
              dataKey="actual"
              stroke={actualColour}
              strokeWidth={1.5}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
              name="actual"
            />
            <Line
              type="monotone"
              dataKey="predicted"
              stroke={PREDICTED_COLOUR}
              strokeWidth={1.8}
              strokeDasharray="4 3"
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
              name="predicted"
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Header({
  driverCode,
  actualTotal,
  predictedTotal,
  delta,
  finishingPosition,
}: {
  driverCode?: string;
  actualTotal?: number | null;
  predictedTotal?: number | null;
  delta?: number | null;
  finishingPosition?: number | null;
}) {
  const showResult = predictedTotal != null;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="text-muted-foreground text-xs">
        Lap times for <span className="text-foreground font-semibold">{driverCode ?? "—"}</span>{" "}
        <span className="text-foreground/40">· actual</span>
        <span className="text-foreground/40 mx-1">vs</span>
        <span className="text-amber-300">predicted</span>
      </div>
      {showResult && (
        <div className="flex items-center gap-3 text-[11px] tabular-nums">
          <span>
            <span className="text-muted-foreground">Total </span>
            <span className="text-foreground font-semibold">
              {formatRaceTime(predictedTotal ?? 0)}
            </span>
          </span>
          {actualTotal != null && delta != null && (
            <span>
              <span className="text-muted-foreground">Δ </span>
              <span
                className={delta > 0 ? "text-amber-200" : "text-emerald-300"}
              >
                {delta >= 0 ? "+" : ""}
                {delta.toFixed(2)}s
              </span>
            </span>
          )}
          {finishingPosition && (
            <span>
              <span className="text-muted-foreground">Pos </span>
              <span className="text-foreground font-semibold">P{finishingPosition}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function formatRaceTime(s: number): string {
  const minutes = Math.floor(s / 60);
  const seconds = s - minutes * 60;
  const hours = Math.floor(minutes / 60);
  const mm = (minutes % 60).toString().padStart(2, "0");
  const ss = seconds.toFixed(1).padStart(4, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
