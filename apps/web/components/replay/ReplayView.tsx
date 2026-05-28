"use client";

import { getRaceData } from "@/lib/api";
import { buildLapIndex } from "@/lib/replay-engine/lap-index";
import { interpolatedFrame, usePlaybackStore } from "@/lib/replay-engine/playback-store";
import { usePlaybackClock, usePlaybackKeybindings } from "@/lib/replay-engine/use-playback-clock";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { findCircuit } from "@/lib/circuits";
import { useRouter } from "next/navigation";
import type { WeatherSummary } from "@traceline/shared-types";
import { CircuitPicker } from "../CircuitPicker";
import { DeltaTimeChart } from "../analytics/DeltaTimeChart";
import { GapOverRaceChart } from "../analytics/GapOverRaceChart";
import { SectorBreakdownChart } from "../analytics/SectorBreakdownChart";
import { QualiTelemetryPanel } from "../analytics/QualiTelemetryPanel";
import { StintAnalysisChart } from "../analytics/StintAnalysisChart";
import { StrategyView } from "../strategy/StrategyView";
import { Leaderboard } from "./Leaderboard";
import { QualiLeaderboard } from "./QualiLeaderboard";
import { PlaybackControls } from "./PlaybackControls";
import { TrackCanvas3D } from "./TrackCanvas3D";

type PanelMode = "analytics" | "stints" | "strategy" | "live";
type QualiSegmentChoice = "Q1" | "Q2" | "Q3";

interface Props {
  year: number;
  round: number;
  sessionType: string;
}

const QUALI_SESSION_TYPES = new Set(["Q", "SQ"]);

const LOAD_PHASES = [
  { at: 0, label: "Requesting session" },
  { at: 10, label: "FastF1 fetching telemetry (this is the slow bit)" },
  { at: 45, label: "Resampling to 10 Hz timeline" },
  { at: 75, label: "Building race-data payload" },
  { at: 100, label: "Almost there" },
];

export function ReplayView({ year, round, sessionType }: Props) {
  const router = useRouter();
  const query = useQuery({
    queryKey: ["race-data", year, round, sessionType],
    queryFn: () => getRaceData(year, round, sessionType),
    retry: 1,
  });

  const setRaceData = usePlaybackStore((s) => s.setRaceData);
  const raceData = usePlaybackStore((s) => s.raceData);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const selectedCount = usePlaybackStore((s) => s.selectedDrivers.length);
  const [panelMode, setPanelMode] = useState<PanelMode>("analytics");
  // Bottom panel collapses to just its tab strip so the track canvas can
  // expand for racing-line comparisons. Defaults to collapsed so picking
  // a driver doesn't immediately steal half the viewport.
  const [panelCollapsed, setPanelCollapsed] = useState(true);
  const isQuali = QUALI_SESSION_TYPES.has(sessionType);
  // Which quali segment the user is inspecting. Only relevant on Q/SQ
  // sessions; ignored everywhere else. Defaults to Q3 because that's
  // where the headline pole-position story lives.
  const [qualiSegment, setQualiSegment] = useState<QualiSegmentChoice>("Q3");

  useEffect(() => {
    if (query.data) setRaceData(query.data);
  }, [query.data, setRaceData]);

  usePlaybackClock();
  usePlaybackKeybindings();

  // Interpolate between adjacent frames for smoother dot motion at <1x. At
  // 60Hz rAF and a 10Hz grid this means roughly 6 sub-frames per real frame.
  // Only TrackCanvas3D needs this — leaderboards and analytics panels read
  // categorical fields (speed/gear/DRS/sectors) that don't change between
  // grid points, so they get the cheaper `rawFrame` derived below.
  const frame = useMemo(() => interpolatedFrame(raceData, currentTime), [raceData, currentTime]);

  // Quantize current time → frame-grid index. Built once per raceData;
  // the index lets downstream components key their work off frame index
  // (changes ~10 Hz) instead of currentTime (changes ~60 Hz).
  const lapIndex = useMemo(() => buildLapIndex(raceData), [raceData]);
  const frameIdx = useMemo(
    () => lapIndex.frameIndexAtTime(currentTime),
    [lapIndex, currentTime],
  );
  const rawFrame = useMemo(
    () => (raceData && frameIdx >= 0 ? raceData.frames[frameIdx] ?? null : null),
    [raceData, frameIdx],
  );

  if (query.isLoading) {
    return <LoadingState year={year} round={round} />;
  }

  if (query.isError || !raceData) {
    return (
      <ErrorState
        year={year}
        round={round}
        message={(query.error as Error | undefined)?.message ?? "Unknown error"}
        onRetry={() => query.refetch()}
      />
    );
  }

  if (raceData.frames.length === 0) {
    return (
      <ErrorState
        year={year}
        round={round}
        message="Session loaded but no telemetry frames were produced. FastF1 may not have position data for this session."
        onRetry={() => query.refetch()}
      />
    );
  }

  return (
    <main className="flex h-screen flex-col">
      <header className="flex items-center gap-3 border-b border-foreground/10 px-4 py-2">
        <Link
          href="/"
          className="text-lg font-semibold tracking-tight transition-opacity hover:opacity-70"
          title="Back to circuit picker"
        >
          TraceLine
        </Link>
        <span className="text-muted-foreground text-sm">
          {findCircuit(raceData.meta.year, raceData.meta.round)?.name ?? raceData.meta.circuit}
        </span>
        <CircuitPicker current={{ year: raceData.meta.year, round: raceData.meta.round }} />
        <SessionTypeToggle
          current={sessionType}
          onChange={(s) => router.push(`/replay/${year}/${round}?session=${s}`)}
        />
        <div className="ml-auto flex items-center gap-3">
          {raceData.meta.weather && <WeatherWidget weather={raceData.meta.weather} />}
          <span className="text-muted-foreground text-xs">
            {raceData.frames.length} frames @ {raceData.meta.frame_hz}Hz ·{" "}
            {raceData.drivers.length} drivers
          </span>
        </div>
      </header>

      {isQuali && (
        <div className="flex items-center gap-2 border-b border-foreground/10 bg-background/95 px-4 py-1.5">
          <span className="text-muted-foreground text-[10px] uppercase tracking-widest">
            Segment
          </span>
          <QualiSegmentToggle current={qualiSegment} onChange={setQualiSegment} />
          <span className="text-muted-foreground text-[10px] italic">
            leaderboard + racing lines reflect each driver's best lap in this segment
          </span>
        </div>
      )}

      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "minmax(0,1fr) 600px" }}>
        <section className="bg-muted/40 relative min-h-0">
          <TrackCanvas3D
            raceData={raceData}
            frame={frame}
            qualiSegment={isQuali ? qualiSegment : null}
          />
        </section>
        <aside className="overflow-y-auto border-l border-foreground/10">
          {/* Quali sessions show a static-ranking leaderboard for the
              selected segment; race / sprint / FP keep the live one. */}
          {isQuali ? (
            <QualiLeaderboard raceData={raceData} segment={qualiSegment} frame={rawFrame} />
          ) : (
            <Leaderboard raceData={raceData} frame={rawFrame} />
          )}
        </aside>
      </div>

      {selectedCount >= 1 && (
        <section
          className={`flex shrink-0 flex-col border-t border-foreground/10 bg-background/95 ${
            panelCollapsed ? "" : "h-[280px]"
          }`}
        >
          <div className="flex items-center gap-1 border-b border-foreground/10 px-3 py-1">
            <button
              type="button"
              onClick={() => setPanelCollapsed((v) => !v)}
              title={panelCollapsed ? "Show analytics panel" : "Hide analytics panel"}
              className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground mr-1 rounded px-1.5 py-0.5 text-[11px] leading-none transition-colors"
              aria-expanded={!panelCollapsed}
            >
              {panelCollapsed ? "▴" : "▾"}
            </button>
            {isQuali ? (
              <span className="text-muted-foreground px-2 py-1 text-[11px] uppercase tracking-widest">
                Live Telemetry · {qualiSegment}
              </span>
            ) : (
              <>
                <PanelTab
                  active={panelMode === "analytics"}
                  onClick={() => setPanelMode("analytics")}
                >
                  Live Comparison
                </PanelTab>
                <PanelTab
                  active={panelMode === "live"}
                  onClick={() => setPanelMode("live")}
                >
                  Live Telemetry
                </PanelTab>
                <PanelTab
                  active={panelMode === "stints"}
                  onClick={() => setPanelMode("stints")}
                >
                  Stints
                </PanelTab>
                <PanelTab
                  active={panelMode === "strategy"}
                  onClick={() => setPanelMode("strategy")}
                >
                  Strategy
                </PanelTab>
                {panelMode === "analytics" && selectedCount < 2 && !panelCollapsed && (
                  <span className="text-muted-foreground ml-3 text-[10px] italic">
                    pick a second driver to populate analytics charts
                  </span>
                )}
              </>
            )}
          </div>
          {!panelCollapsed && (
            <div className="min-h-0 flex-1">
              {isQuali ? (
                <QualiTelemetryPanel
                  raceData={raceData}
                  frameIdx={frameIdx}
                  lapIndex={lapIndex}
                  qualiSegment={isQuali ? qualiSegment : null}
                />
              ) : (
                <>
                  {panelMode === "analytics" && (
                    <div className="grid h-full grid-cols-[1fr_1fr_300px] divide-x divide-foreground/10">
                      <div className="min-w-0">
                        <DeltaTimeChart raceData={raceData} />
                      </div>
                      <div className="min-w-0">
                        <GapOverRaceChart raceData={raceData} />
                      </div>
                      <div className="min-w-0">
                        <SectorBreakdownChart raceData={raceData} />
                      </div>
                    </div>
                  )}
                  {panelMode === "live" && (
                    <QualiTelemetryPanel
                      raceData={raceData}
                      frameIdx={frameIdx}
                      lapIndex={lapIndex}
                      qualiSegment={null}
                    />
                  )}
                  {panelMode === "stints" && <StintAnalysisChart raceData={raceData} />}
                  {panelMode === "strategy" && <StrategyView raceData={raceData} />}
                </>
              )}
            </div>
          )}
        </section>
      )}

      <PlaybackControls raceData={raceData} />
    </main>
  );
}

function LoadingState({ year, round }: { year: number; round: number }) {
  // Pure UI ticker — the backend doesn't stream progress yet, so we estimate
  // a phase from elapsed wall time. Updates every 1s, capped at "almost there".
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsedS((Date.now() - start) / 1000), 500);
    return () => clearInterval(id);
  }, []);
  const pct = Math.min(95, (elapsedS / 120) * 100); // assume ~2 min cold cache
  const phase = LOAD_PHASES.findLast((p) => p.at <= pct) ?? LOAD_PHASES[0];

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-12">
      <p className="text-muted-foreground text-sm uppercase tracking-widest">Loading race</p>
      <p className="text-2xl font-semibold">
        {year} · Round {round}
      </p>
      <p className="text-muted-foreground text-xs">{phase?.label ?? "Loading"}…</p>
      <div className="mt-4 h-1.5 w-72 overflow-hidden rounded bg-foreground/10">
        <div
          className="h-full bg-foreground/60 transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-muted-foreground mt-2 text-[10px]">
        Cold FastF1 cache: 1–3 min · subsequent loads are instant
      </p>
    </main>
  );
}

function WeatherWidget({ weather }: { weather: WeatherSummary }) {
  const items: Array<{ label: string; value: string }> = [];
  if (weather.air_temp_c != null) items.push({ label: "Air", value: `${weather.air_temp_c}°C` });
  if (weather.track_temp_c != null) {
    items.push({ label: "Track", value: `${weather.track_temp_c}°C` });
  }
  if (weather.humidity_pct != null) {
    items.push({ label: "Hum", value: `${Math.round(weather.humidity_pct)}%` });
  }
  if (weather.wind_speed_kph != null) {
    items.push({ label: "Wind", value: `${weather.wind_speed_kph.toFixed(1)} kph` });
  }
  if (items.length === 0 && !weather.rainfall) return null;
  return (
    <div
      className="flex items-center gap-2 rounded border border-foreground/15 bg-background/70 px-2 py-1 text-[10px]"
      title="Session-average weather"
    >
      {weather.rainfall && (
        <span className="rounded bg-sky-500/20 px-1 text-sky-200" title="Rain recorded">
          rain
        </span>
      )}
      {items.map((it) => (
        <span key={it.label} className="text-muted-foreground">
          <span className="uppercase tracking-widest opacity-70">{it.label}</span>{" "}
          <span className="text-foreground">{it.value}</span>
        </span>
      ))}
    </div>
  );
}

const QUALI_SEGMENTS: ReadonlyArray<QualiSegmentChoice> = ["Q1", "Q2", "Q3"];

function QualiSegmentToggle({
  current,
  onChange,
}: {
  current: QualiSegmentChoice;
  onChange: (s: QualiSegmentChoice) => void;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-foreground/20 text-xs">
      {QUALI_SEGMENTS.map((s) => {
        const active = s === current;
        return (
          <button
            key={s}
            type="button"
            onClick={() => !active && onChange(s)}
            className={`px-2 py-0.5 transition-colors ${
              active
                ? "bg-amber-400/20 text-amber-200"
                : "bg-background/60 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            }`}
          >
            {s}
          </button>
        );
      })}
    </div>
  );
}

const SESSION_TYPES: ReadonlyArray<{ value: string; label: string; title: string }> = [
  { value: "R", label: "Race", title: "Race day session" },
  { value: "Q", label: "Quali", title: "Qualifying (Q1/Q2/Q3)" },
  { value: "SQ", label: "Sprint Q", title: "Sprint qualifying (sprint weekends)" },
  { value: "S", label: "Sprint", title: "Sprint race (sprint weekends)" },
];

/** R / Q / SQ / S pill toggle. Hitting any pill pushes a new URL with
 *  ?session=… so the page re-renders with that session's RaceData. */
function SessionTypeToggle({
  current,
  onChange,
}: {
  current: string;
  onChange: (s: string) => void;
}) {
  return (
    <div className="flex items-center gap-px overflow-hidden rounded border border-foreground/20 text-xs">
      {SESSION_TYPES.map((s) => {
        const active = s.value === current;
        return (
          <button
            key={s.value}
            type="button"
            onClick={() => !active && onChange(s.value)}
            title={s.title}
            className={`px-2 py-1 transition-colors ${
              active
                ? "bg-foreground text-background"
                : "bg-background/60 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

function PanelTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-[11px] uppercase tracking-widest transition-colors ${
        active
          ? "bg-foreground/10 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function ErrorState({
  year,
  round,
  message,
  onRetry,
}: {
  year: number;
  round: number;
  message: string;
  onRetry: () => void;
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-12">
      <p className="text-sm uppercase tracking-widest text-red-400">Failed to load</p>
      <p className="text-2xl font-semibold">
        {year} · Round {round}
      </p>
      <p className="text-muted-foreground max-w-md text-center text-xs">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
      >
        Retry
      </button>
    </main>
  );
}
