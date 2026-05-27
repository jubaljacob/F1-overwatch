"use client";

import { getRaceData } from "@/lib/api";
import { interpolatedFrame, usePlaybackStore } from "@/lib/replay-engine/playback-store";
import { usePlaybackClock, usePlaybackKeybindings } from "@/lib/replay-engine/use-playback-clock";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { DeltaTimeChart } from "../analytics/DeltaTimeChart";
import { GapOverRaceChart } from "../analytics/GapOverRaceChart";
import { SectorBreakdownChart } from "../analytics/SectorBreakdownChart";
import { StintAnalysisChart } from "../analytics/StintAnalysisChart";
import { StrategyView } from "../strategy/StrategyView";
import { Leaderboard } from "./Leaderboard";
import { PlaybackControls } from "./PlaybackControls";
import { TrackCanvas } from "./TrackCanvas";

type PanelMode = "analytics" | "stints" | "strategy";

interface Props {
  year: number;
  round: number;
  sessionType: string;
}

const LOAD_PHASES = [
  { at: 0, label: "Requesting session" },
  { at: 10, label: "FastF1 fetching telemetry (this is the slow bit)" },
  { at: 45, label: "Resampling to 10 Hz timeline" },
  { at: 75, label: "Building race-data payload" },
  { at: 100, label: "Almost there" },
];

export function ReplayView({ year, round, sessionType }: Props) {
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

  useEffect(() => {
    if (query.data) setRaceData(query.data);
  }, [query.data, setRaceData]);

  usePlaybackClock();
  usePlaybackKeybindings();

  // Interpolate between adjacent frames for smoother dot motion at <1x. At
  // 60Hz rAF and a 10Hz grid this means roughly 6 sub-frames per real frame.
  const frame = useMemo(() => interpolatedFrame(raceData, currentTime), [raceData, currentTime]);

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
      <header className="flex items-baseline gap-3 border-b border-foreground/10 px-4 py-2">
        <h1 className="text-lg font-semibold tracking-tight">TraceLine</h1>
        <span className="text-muted-foreground text-sm">
          {raceData.meta.year} · Round {raceData.meta.round} · {raceData.meta.circuit}
        </span>
        <span className="text-muted-foreground ml-auto text-xs">
          {raceData.frames.length} frames @ {raceData.meta.frame_hz}Hz · {raceData.drivers.length}{" "}
          drivers
        </span>
      </header>

      <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "minmax(0,1fr) 600px" }}>
        <section className="bg-muted/40 relative min-h-0">
          <TrackCanvas raceData={raceData} frame={frame} />
        </section>
        <aside className="overflow-y-auto border-l border-foreground/10">
          <Leaderboard raceData={raceData} frame={frame} />
        </aside>
      </div>

      {selectedCount >= 1 && (
        <section className="flex h-[280px] shrink-0 flex-col border-t border-foreground/10 bg-background/95">
          <div className="flex items-center gap-1 border-b border-foreground/10 px-3 py-1">
            <PanelTab active={panelMode === "analytics"} onClick={() => setPanelMode("analytics")}>
              Analytics
            </PanelTab>
            <PanelTab active={panelMode === "stints"} onClick={() => setPanelMode("stints")}>
              Stints
            </PanelTab>
            <PanelTab active={panelMode === "strategy"} onClick={() => setPanelMode("strategy")}>
              Strategy
            </PanelTab>
            {panelMode === "analytics" && selectedCount < 2 && (
              <span className="text-muted-foreground ml-3 text-[10px] italic">
                pick a second driver to populate analytics charts
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1">
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
            {panelMode === "stints" && <StintAnalysisChart raceData={raceData} />}
            {panelMode === "strategy" && <StrategyView raceData={raceData} />}
          </div>
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
