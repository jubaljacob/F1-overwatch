"use client";

import { buildLapIndex, type LapIndex } from "@/lib/replay-engine/lap-index";
import { usePlaybackStore } from "@/lib/replay-engine/playback-store";
import type { Frame, RaceData } from "@traceline/shared-types";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
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
  /** 10 Hz quantized frame index from ReplayView. Driving the panel off
   *  this instead of the 60 Hz currentTime stops Recharts from
   *  reconciling 6× more often than the data actually changes — that
   *  was the source of the canvas stutter when the panel was open. */
  frameIdx: number;
  /** Shared lap-range index built once in ReplayView and passed in so
   *  the panel doesn't repeat the one-pass scan. */
  lapIndex: LapIndex;
  /** Optional quali segment — when set, sector colour comparisons are
   *  scoped to that segment (the F1 colour convention is per-segment in
   *  qualifying, not per whole session). */
  qualiSegment?: "Q1" | "Q2" | "Q3" | null;
}

interface TraceRow {
  d: number; // lap distance (m)
  spd: number | null;
  gear: number | null;
  thr: number | null;
  brk: number | null;
  /** Estimated ERS state-of-charge (0–100 %), modelled from throttle/brake
   *  inputs. Real battery state isn't in the F1 public feed; this gives the
   *  user a plausible deployment/recovery shape (drains on straights,
   *  regenerates under braking) without claiming to be real telemetry. */
  ers: number | null;
}

/** Quali-specific live telemetry panel.
 *
 *  Tracks the reference (or first-selected) driver. Re-extracts the
 *  in-progress lap of that driver each frame so the chart traces the
 *  car as it's driving — when the driver completes a lap, the chart
 *  resets and starts plotting the new one.
 *
 *  Three sub-panels: throttle/brake area chart, speed line chart, and
 *  a live readout of the running lap time + last completed sector
 *  splits. */
function QualiTelemetryPanelInner({ raceData, frameIdx, lapIndex, qualiSegment = null }: Props) {
  // Subscribe ONLY to selection state — these change on user input, not
  // on the playback clock. The expensive chart subtree therefore only
  // re-runs when frameIdx (10 Hz) or selection (rare) changes.
  const selected = usePlaybackStore((s) => s.selectedDrivers);
  const reference = usePlaybackStore((s) => s.referenceDriver);
  const effectiveRef = reference ?? selected[0] ?? null;

  const driverInfo = useMemo(
    () =>
      effectiveRef != null
        ? raceData.drivers.find((d) => d.number === effectiveRef)
        : undefined,
    [raceData, effectiveRef],
  );

  // Snapshot of the in-progress lap (samples with sample.lap == active).
  // When the driver crosses the line `currentLap` advances and the
  // trace resets — only frames belonging to the *new* lap show up.
  const { trace, currentD, currentLap, lapStartT } = useMemo(
    () => extractActiveLap(raceData, lapIndex, effectiveRef, frameIdx),
    [raceData, lapIndex, effectiveRef, frameIdx],
  );

  // Stable reference for the X-axis domain so Recharts doesn't think
  // the axis changed every render.
  const xDomain = useMemo<[number, number | "dataMax"]>(
    () => [0, raceData.circuit.track_length_m || ("dataMax" as const)],
    [raceData.circuit.track_length_m],
  );

  // Sector splits from raceData.laps for this driver — show the most
  // recently completed lap's sectors so the user has a benchmark while
  // the driver does the next one. Falls back to the in-progress lap's
  // sectors if FastF1 already filled them in (it sometimes does mid-lap
  // for completed sectors).
  const sectorInfo = useMemo(
    () => extractSectorInfo(raceData, effectiveRef, currentLap, qualiSegment),
    [raceData, effectiveRef, currentLap, qualiSegment],
  );

  if (effectiveRef == null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs italic">
        Pick a driver from the leaderboard to see their live telemetry
      </div>
    );
  }

  const driverColour = driverInfo?.team_colour ? `#${driverInfo.team_colour}` : "#fbbf24";

  // Force a fresh chart instance whenever the active lap (or driver)
  // changes. Recharts otherwise diffs the previous render's SVG paths
  // against the new (mostly-empty) trace, leaving the previous lap's
  // line drawn underneath while the new lap fills in — looks like the
  // two laps are overlaid.
  const chartKey = `${effectiveRef}-${currentLap ?? "x"}`;

  return (
    <div className="grid h-full grid-cols-[1fr_1fr_220px] divide-x divide-foreground/10 text-xs">
      <ChartCell title="Throttle / Brake">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart key={chartKey} data={trace} margin={{ top: 8, right: 8, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id="ql-thr" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#10b981" stopOpacity={0.55} />
                <stop offset="100%" stopColor="#10b981" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="ql-brk" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ef4444" stopOpacity={0.55} />
                <stop offset="100%" stopColor="#ef4444" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="d"
              type="number"
              // Stable reference (memoised) so Recharts doesn't think
              // the axis changed every render.
              domain={xDomain}
              stroke="rgba(255,255,255,0.4)"
              tick={{ fontSize: 9 }}
              tickFormatter={(v) => `${Math.round(v)}m`}
            />
            <YAxis
              domain={[0, 100]}
              stroke="rgba(255,255,255,0.4)"
              tick={{ fontSize: 9 }}
              tickFormatter={(v) => `${v}%`}
              width={28}
            />
            <Tooltip
              contentStyle={chartTooltipStyle}
              labelFormatter={(v) => `${Math.round(Number(v))} m`}
              formatter={(v: number) => `${v?.toFixed?.(0) ?? "—"}%`}
            />
            <Area
              type="monotone"
              dataKey="thr"
              stroke="#10b981"
              fill="url(#ql-thr)"
              strokeWidth={1.5}
              isAnimationActive={false}
              dot={false}
            />
            <Area
              type="monotone"
              dataKey="brk"
              stroke="#ef4444"
              fill="url(#ql-brk)"
              strokeWidth={1.5}
              isAnimationActive={false}
              dot={false}
            />
            {currentD != null && (
              <ReferenceLine x={currentD} stroke="#fbbf24" strokeWidth={1} strokeDasharray="3 3" />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </ChartCell>

      <ChartCell title="Speed / Gear / ERS (est.)">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart key={chartKey} data={trace} margin={{ top: 8, right: 8, left: 4, bottom: 4 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="d"
              type="number"
              // Stable reference (memoised) so Recharts doesn't think
              // the axis changed every render.
              domain={xDomain}
              stroke="rgba(255,255,255,0.4)"
              tick={{ fontSize: 9 }}
              tickFormatter={(v) => `${Math.round(v)}m`}
            />
            <YAxis
              yAxisId="spd"
              stroke="rgba(255,255,255,0.4)"
              tick={{ fontSize: 9 }}
              width={28}
              domain={[0, "dataMax"]}
            />
            <YAxis
              yAxisId="ers"
              orientation="right"
              stroke="rgba(34,211,238,0.55)"
              tick={{ fontSize: 9, fill: "rgba(34,211,238,0.7)" }}
              width={26}
              domain={[0, 100]}
              tickFormatter={(v) => `${v}%`}
            />
            {/* Hidden axis for gear — keeps the chart visually clean (no
                extra ticks) while letting the gear step-line render. The
                value still appears in the tooltip and the line itself
                shows on hover. */}
            <YAxis yAxisId="gear" hide domain={[0, 8]} />
            <Tooltip
              contentStyle={chartTooltipStyle}
              formatter={(value: number, name: string) => {
                if (name === "Gear") return [value, "Gear"];
                if (name === "Speed (kph)") return [Math.round(value), "Speed (kph)"];
                if (name === "ERS (est. %)") return [`${value.toFixed(1)}%`, "ERS (est.)"];
                return [value, name];
              }}
              labelFormatter={(v) => `${Math.round(Number(v))} m`}
            />
            <Line
              yAxisId="spd"
              type="monotone"
              dataKey="spd"
              stroke={driverColour}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              name="Speed (kph)"
            />
            <Line
              yAxisId="ers"
              type="monotone"
              dataKey="ers"
              stroke="#22d3ee"
              strokeWidth={1.25}
              dot={false}
              isAnimationActive={false}
              name="ERS (est. %)"
            />
            <Line
              yAxisId="gear"
              type="stepAfter"
              dataKey="gear"
              stroke="rgba(255,255,255,0.35)"
              strokeWidth={1}
              dot={false}
              isAnimationActive={false}
              name="Gear"
            />
            {currentD != null && (
              <ReferenceLine
                yAxisId="spd"
                x={currentD}
                stroke="#fbbf24"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </ChartCell>

      <div className="flex h-full flex-col gap-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground text-[10px] uppercase tracking-widest">
            {driverInfo?.code ?? `#${effectiveRef}`} · Lap {currentLap ?? "—"}
          </span>
          <SkipToBestLapButton
            raceData={raceData}
            lapIndex={lapIndex}
            driver={effectiveRef}
            qualiSegment={qualiSegment}
          />
        </div>
        <RunningLapClock lapStartT={lapStartT} />
        <StatLine
          label="Last lap"
          value={sectorInfo.lastLap != null ? formatLapTime(sectorInfo.lastLap) : "—"}
        />
        <StatLine
          label="Best lap"
          value={sectorInfo.bestLap != null ? formatLapTime(sectorInfo.bestLap) : "—"}
        />
        <div className="mt-1 border-t border-foreground/10 pt-2">
          <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-widest">
            Sectors (this lap)
          </div>
          <SectorLine label="S1" v={sectorInfo.s1} colour={sectorInfo.s1Colour} />
          <SectorLine label="S2" v={sectorInfo.s2} colour={sectorInfo.s2Colour} />
          <SectorLine label="S3" v={sectorInfo.s3} colour={sectorInfo.s3Colour} />
        </div>
      </div>
    </div>
  );
}

/** Skip-to-best-lap. Finds the driver's fastest lap whose
 *  `quali_segment` matches the active scope (or anywhere in the
 *  session for non-quali), looks up its start frame via lapIndex,
 *  and seeks the playback clock there. Hidden when the driver has no
 *  timed lap in scope. */
function SkipToBestLapButton({
  raceData,
  lapIndex,
  driver,
  qualiSegment,
}: {
  raceData: RaceData;
  lapIndex: LapIndex;
  driver: number | null;
  qualiSegment: "Q1" | "Q2" | "Q3" | null;
}) {
  const seek = usePlaybackStore((s) => s.seek);
  if (driver == null) return null;

  let bestLap: number | null = null;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const lap of raceData.laps) {
    if (lap.driver !== driver) continue;
    if (lap.lap_time_s == null) continue;
    if (lap.pit_in || lap.pit_out) continue;
    if (qualiSegment != null && lap.quali_segment !== qualiSegment) continue;
    if (lap.lap_time_s < bestTime) {
      bestTime = lap.lap_time_s;
      bestLap = lap.lap;
    }
  }
  if (bestLap == null) return null;
  const range = lapIndex.byDriver.get(driver)?.get(bestLap);
  if (!range) return null;
  const startT = raceData.frames[range.startIdx]?.t;
  if (startT == null) return null;

  return (
    <button
      type="button"
      onClick={() => seek(startT)}
      className="rounded border border-amber-400/40 bg-amber-400/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-amber-200 transition-colors hover:bg-amber-400/25"
      title={`Jump to lap ${bestLap} (${formatLapTime(bestTime)})`}
    >
      ▶ Best lap
    </button>
  );
}

/** Memoised public entry-point. Only re-renders when frameIdx /
 *  raceData / lapIndex actually change — the 60 Hz currentTime tick in
 *  the parent no longer drags this whole subtree through Recharts. */
export const QualiTelemetryPanel = memo(QualiTelemetryPanelInner);

/** Tiny isolated subscriber for the running lap-time readout. It's the
 *  only piece of UI that needs to tick at 60 Hz, so it owns that
 *  subscription instead of forcing every chart in the panel to re-render
 *  alongside it. Re-renders are cheap because the rendered output is
 *  one `<span>` with a formatted number. */
function RunningLapClock({ lapStartT }: { lapStartT: number | null }) {
  // Pull currentTime via a local subscription — keeps the parent
  // panel's render frequency at 10 Hz while this single span ticks at
  // whatever rate the playback clock fires.
  const currentTime = usePlaybackStore((s) => s.currentTime);
  // Throttle the displayed value to ~12 Hz so the running clock doesn't
  // thrash text-layout 60 times per second. Keeps the lap-time digits
  // readable while saving the main thread for the canvas.
  const [displayT, setDisplayT] = useState(currentTime);
  const lastShownAt = useRef(0);
  useEffect(() => {
    const now = performance.now();
    if (now - lastShownAt.current >= 80) {
      lastShownAt.current = now;
      setDisplayT(currentTime);
    }
  }, [currentTime]);
  const running = lapStartT != null ? Math.max(0, displayT - lapStartT) : null;
  return (
    <StatLine
      label="Running"
      value={running != null ? formatLapTime(running) : "—"}
      highlight
    />
  );
}

function ChartCell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="text-muted-foreground border-b border-foreground/10 px-3 py-1 text-[10px] uppercase tracking-widest">
        {title}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

function StatLine({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-muted-foreground text-[10px] uppercase tracking-widest">{label}</span>
      <span
        className={`font-mono tabular-nums ${highlight ? "text-amber-300" : "text-foreground"} ${
          highlight ? "text-sm" : "text-[11px]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

type SectorColour = "purple" | "green" | "yellow" | "neutral";

const SECTOR_COLOUR_CLASS: Record<SectorColour, string> = {
  // F1 timing convention:
  //   purple = overall fastest sector (across all drivers in this scope)
  //   green  = personal best for this driver
  //   yellow = slower than this driver's personal best
  //   neutral = no time yet (— placeholder)
  purple: "text-fuchsia-400",
  green: "text-emerald-400",
  yellow: "text-amber-300",
  neutral: "text-foreground",
};

function SectorLine({
  label,
  v,
  colour = "neutral",
}: {
  label: string;
  v: number | null;
  colour?: SectorColour;
}) {
  return (
    <div className="flex items-baseline justify-between text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono tabular-nums ${SECTOR_COLOUR_CLASS[colour]}`}>
        {v != null ? v.toFixed(3) : "—"}
      </span>
    </div>
  );
}

const chartTooltipStyle = {
  background: "rgba(15,15,18,0.92)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6,
  fontSize: 11,
  color: "#e5e7eb",
};

function formatLapTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  if (m === 0) return r.toFixed(3);
  return `${m}:${r.toFixed(3).padStart(6, "0")}`;
}

interface ExtractActiveLapOut {
  trace: TraceRow[];
  currentD: number | null;
  currentLap: number | null;
  lapStartT: number | null;
}

/** Pull the in-progress lap's telemetry slice for `driver` at frame
 *  index `frameIdx`. Uses the precomputed `LapIndex` so this is
 *  O(log frames) instead of a per-render backward scan. The trace
 *  always represents exactly one lap — when the driver crosses the
 *  finish line and the lap counter advances, this function returns
 *  the new lap's growing trace, not a concatenation with the old one. */
function extractActiveLap(
  raceData: RaceData,
  lapIndex: ReturnType<typeof buildLapIndex>,
  driver: number | null,
  frameIdx: number,
): ExtractActiveLapOut {
  if (driver == null || frameIdx < 0 || raceData.frames.length === 0) {
    return { trace: [], currentD: null, currentLap: null, lapStartT: null };
  }
  const frames = raceData.frames;
  const key = String(driver);
  const headSample = frames[frameIdx]?.p?.[key];
  if (!headSample) {
    return { trace: [], currentD: null, currentLap: null, lapStartT: null };
  }
  const activeLap = headSample.lap;
  const range = lapIndex.byDriver.get(driver)?.get(activeLap);
  if (!range) {
    return {
      trace: [],
      currentD: headSample.d,
      currentLap: activeLap,
      lapStartT: frames[frameIdx]!.t,
    };
  }
  // Slice through the current frame — we don't want to "peek ahead"
  // and show the chart drawn for the whole lap before the driver has
  // actually reached that point on track.
  const sliceEnd = Math.min(range.endIdx, frameIdx);
  const rows: TraceRow[] = [];
  for (let i = range.startIdx; i <= sliceEnd; i++) {
    const f = frames[i] as Frame | undefined;
    if (!f) continue;
    const s = f.p?.[key];
    if (!s || s.lap !== activeLap) continue;
    rows.push({
      d: s.d,
      spd: s.spd,
      gear: s.gear ?? null,
      thr: s.thr ?? null,
      brk: s.brk ?? null,
      ers: null,
    });
  }
  // Keep the trace strictly time-ordered. d is already monotonic within
  // a single lap unless the projection produced a wrap-around kink at
  // the start/finish line — handled by a single ascending sort.
  rows.sort((a, b) => a.d - b.d);
  // Estimated ERS state-of-charge across the lap. Starts at 100 % at the
  // line, drains under throttle (deployment), recovers under braking
  // (MGU-K regen). The coefficients are eyeballed for visual plausibility,
  // not engineered — F1's broadcast feed doesn't carry real SOC so this is
  // explicitly an "estimate" and is labelled as such in the UI.
  let soc = 100;
  const DEPLOY_PER_PCT = 0.018; // 100 % throttle drains ~1.8 %/tick
  const REGEN_PER_PCT = 0.024; // 100 % brake recovers ~2.4 %/tick
  for (const r of rows) {
    if (r.thr != null) soc -= r.thr * DEPLOY_PER_PCT;
    if (r.brk != null) soc += r.brk * REGEN_PER_PCT;
    soc = Math.max(0, Math.min(100, soc));
    r.ers = soc;
  }
  // Lap-start time = the t of the first frame in this lap range.
  const lapStartT = frames[range.startIdx]?.t ?? null;
  return {
    trace: rows,
    currentD: headSample.d,
    currentLap: activeLap,
    lapStartT,
  };
}

interface SectorInfo {
  s1: number | null;
  s2: number | null;
  s3: number | null;
  s1Colour: SectorColour;
  s2Colour: SectorColour;
  s3Colour: SectorColour;
  lastLap: number | null;
  bestLap: number | null;
}

function extractSectorInfo(
  raceData: RaceData,
  driver: number | null,
  currentLap: number | null,
  qualiSegment: "Q1" | "Q2" | "Q3" | null,
): SectorInfo {
  const out: SectorInfo = {
    s1: null,
    s2: null,
    s3: null,
    s1Colour: "neutral",
    s2Colour: "neutral",
    s3Colour: "neutral",
    lastLap: null,
    bestLap: null,
  };
  if (driver == null) return out;

  // Compute personal bests (for `driver`) and overall bests (across all
  // drivers in the active scope) for each sector in one pass. In quali
  // we scope by the active segment; otherwise we use every lap in the
  // session. Pit-in/out laps are excluded so an out-lap S1 doesn't
  // accidentally hold the purple time.
  let pbS1: number | null = null;
  let pbS2: number | null = null;
  let pbS3: number | null = null;
  let overallS1: number | null = null;
  let overallS2: number | null = null;
  let overallS3: number | null = null;
  let last: number | null = null;
  let best: number | null = null;

  for (const lap of raceData.laps) {
    const inScope =
      qualiSegment == null || lap.quali_segment === qualiSegment;
    if (!inScope) continue;
    if (lap.pit_in || lap.pit_out) continue;

    if (lap.sector_1_s != null && (overallS1 == null || lap.sector_1_s < overallS1)) {
      overallS1 = lap.sector_1_s;
    }
    if (lap.sector_2_s != null && (overallS2 == null || lap.sector_2_s < overallS2)) {
      overallS2 = lap.sector_2_s;
    }
    if (lap.sector_3_s != null && (overallS3 == null || lap.sector_3_s < overallS3)) {
      overallS3 = lap.sector_3_s;
    }

    if (lap.driver !== driver) continue;
    if (lap.sector_1_s != null && (pbS1 == null || lap.sector_1_s < pbS1)) pbS1 = lap.sector_1_s;
    if (lap.sector_2_s != null && (pbS2 == null || lap.sector_2_s < pbS2)) pbS2 = lap.sector_2_s;
    if (lap.sector_3_s != null && (pbS3 == null || lap.sector_3_s < pbS3)) pbS3 = lap.sector_3_s;
    if (lap.lap_time_s != null) {
      if (best == null || lap.lap_time_s < best) best = lap.lap_time_s;
      if (currentLap == null || lap.lap < currentLap) {
        if (last == null || lap.lap > (last as number)) last = lap.lap_time_s;
      }
    }
  }

  // Current-lap sectors come from this driver's lap record for currentLap.
  if (currentLap != null) {
    for (const lap of raceData.laps) {
      if (lap.driver !== driver || lap.lap !== currentLap) continue;
      out.s1 = lap.sector_1_s ?? out.s1;
      out.s2 = lap.sector_2_s ?? out.s2;
      out.s3 = lap.sector_3_s ?? out.s3;
    }
  }

  out.s1Colour = colourFor(out.s1, pbS1, overallS1);
  out.s2Colour = colourFor(out.s2, pbS2, overallS2);
  out.s3Colour = colourFor(out.s3, pbS3, overallS3);
  out.lastLap = last;
  out.bestLap = best;
  return out;
}

/** F1 colour rule for a sector time. Tolerates floating-point noise via
 *  a 1 ms epsilon — sector times are rounded to ms in source data, so
 *  exact equality is the common case anyway. */
function colourFor(
  current: number | null,
  personalBest: number | null,
  overallBest: number | null,
): SectorColour {
  if (current == null) return "neutral";
  const eps = 1e-3;
  if (overallBest != null && current <= overallBest + eps) return "purple";
  if (personalBest != null && current <= personalBest + eps) return "green";
  return "yellow";
}
