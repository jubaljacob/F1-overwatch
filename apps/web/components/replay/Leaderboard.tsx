"use client";

import { computeLeaderboard, type LeaderboardRow } from "@/lib/replay-engine/leaderboard";
import {
  computeDriverExtras,
  computeStartingPositions,
  type DriverExtras,
  type SectorStatus,
} from "@/lib/replay-engine/leaderboard-extras";
import { usePlaybackStore } from "@/lib/replay-engine/playback-store";
import type { DriverInfo, Frame, RaceData } from "@traceline/shared-types";
import { useMemo } from "react";

interface Props {
  raceData: RaceData;
  frame: Frame | null;
}

export function Leaderboard({ raceData, frame }: Props) {
  const selected = usePlaybackStore((s) => s.selectedDrivers);
  const reference = usePlaybackStore((s) => s.referenceDriver);
  const toggleSelected = usePlaybackStore((s) => s.toggleSelectedDriver);
  const setReference = usePlaybackStore((s) => s.setReferenceDriver);
  const clearSelection = usePlaybackStore((s) => s.clearSelection);

  const driverLookup = useMemo<Map<number, DriverInfo>>(
    () => new Map(raceData.drivers.map((d) => [d.number, d])),
    [raceData],
  );
  const rows = useMemo(
    () => computeLeaderboard(raceData, frame, driverLookup),
    [raceData, frame, driverLookup],
  );

  // Starting positions are stable across the whole replay — derive once per
  // raceData. computeDriverExtras then snapshots per frame.
  const startingPositions = useMemo(() => computeStartingPositions(raceData), [raceData]);
  const extras = useMemo(
    () => computeDriverExtras(raceData, frame, startingPositions),
    [raceData, frame, startingPositions],
  );

  const leaderLap = rows[0]?.lap ?? 0;
  const totalLaps = raceData.meta.total_laps || leaderLap;
  const anySelected = selected.length > 0;
  const effectiveReference = reference ?? selected[0] ?? null;

  if (rows.length === 0) {
    return <p className="text-muted-foreground p-4 text-sm">Waiting for frames…</p>;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="bg-background/95 sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-foreground/10 px-3 py-2 text-xs uppercase tracking-widest">
        <span className="text-muted-foreground">Leaderboard</span>
        <div className="flex items-center gap-3">
          {anySelected && (
            <button
              type="button"
              onClick={clearSelection}
              className="text-muted-foreground hover:text-foreground text-[10px] underline-offset-2 hover:underline"
            >
              clear ({selected.length})
            </button>
          )}
          <span className="font-mono tabular-nums">
            Lap {leaderLap}
            {totalLaps ? ` / ${totalLaps}` : ""}
          </span>
        </div>
      </div>
      <ol className="divide-foreground/10 flex-1 divide-y overflow-y-auto">
        {rows.map((r) => {
          const sample = frame?.p?.[String(r.driver.number)];
          return (
            <LeaderboardRowView
              key={r.driver.number}
              row={r}
              extras={extras.get(r.driver.number)}
              telemetry={
                sample
                  ? { speed: sample.spd, gear: sample.gear ?? null, drs: !!sample.drs }
                  : null
              }
              isSelected={selected.includes(r.driver.number)}
              isReference={effectiveReference === r.driver.number}
              anySelected={anySelected}
              onToggle={() => toggleSelected(r.driver.number)}
              onSetReference={() => setReference(r.driver.number)}
            />
          );
        })}
      </ol>
    </div>
  );
}

interface RowTelemetry {
  speed: number;
  gear: number | null;
  drs: boolean;
}

interface RowProps {
  row: LeaderboardRow;
  extras: DriverExtras | undefined;
  telemetry: RowTelemetry | null;
  isSelected: boolean;
  isReference: boolean;
  anySelected: boolean;
  onToggle: () => void;
  onSetReference: () => void;
}

function LeaderboardRowView({
  row: r,
  extras,
  telemetry,
  isSelected,
  isReference,
  anySelected,
  onToggle,
  onSetReference,
}: RowProps) {
  const dim = anySelected && !isSelected;
  const colour = r.driver.team_colour ? `#${r.driver.team_colour}` : "#888";

  return (
    <li className="relative">
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={isSelected}
        className={`flex w-full items-stretch text-left text-xs transition-colors ${
          isSelected
            ? "bg-foreground/10"
            : dim
              ? "opacity-40 hover:bg-foreground/5"
              : "hover:bg-foreground/5"
        }`}
        style={{
          display: "grid",
          gridTemplateColumns: "32px 96px 104px 116px 90px 92px",
          alignItems: "center",
          gap: "8px",
          padding: "6px 8px",
          opacity: r.status === "out" ? 0.35 : undefined,
          borderLeft: isSelected ? `3px solid ${colour}` : "3px solid transparent",
        }}
      >
        {/* Position + change arrow */}
        <div className="flex flex-col items-center leading-tight">
          <span className="text-muted-foreground tabular-nums text-sm font-semibold">
            {r.position}
          </span>
          {extras && extras.positionChange !== 0 && (
            <PositionArrow change={extras.positionChange} />
          )}
        </div>

        {/* Team strip + code */}
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="inline-block h-5 w-1 rounded-sm shrink-0"
            style={{ backgroundColor: colour }}
            aria-hidden
          />
          <span className="font-semibold tabular-nums">{r.driver.code}</span>
        </div>

        {/* Tyre compound + age on this set + pit-stop count */}
        <div className="flex flex-col items-start gap-0.5 leading-tight">
          {extras?.tyreCompound ? (
            <TyreBadge compound={extras.tyreCompound} age={extras.tyreAge ?? 0} />
          ) : (
            <span className="text-foreground/30 text-[10px]">no tyre</span>
          )}
          <span
            className={`text-[10px] tabular-nums ${
              extras && extras.pitStops > 0 ? "text-foreground/60" : "text-foreground/25"
            }`}
            title="Pit stops completed this race"
          >
            {extras?.pitStops ?? 0}× pit
          </span>
        </div>

        {/* Lap times: last (top) + best (below) */}
        <div className="flex flex-col items-end leading-tight">
          <span className="tabular-nums">
            <span className="text-muted-foreground text-[10px] mr-1">LAST</span>
            {formatLapTime(extras?.lastLapTime)}
          </span>
          <span className="tabular-nums text-foreground/60">
            <span className="text-muted-foreground text-[10px] mr-1">BEST</span>
            {formatLapTime(extras?.bestLapTime)}
          </span>
        </div>

        {/* Gap to leader + pace delta vs last lap */}
        <div className="flex flex-col items-end leading-tight">
          <span className="tabular-nums">
            {r.position === 1 ? (
              <span className="text-foreground/80 text-[10px]">LEADER</span>
            ) : (
              <span>
                <span className="text-muted-foreground text-[10px] mr-1">GAP</span>
                +{r.gapToLeader.toFixed(2)}s
              </span>
            )}
          </span>
          {extras?.paceDeltaVsLastLap != null ? (
            <span
              className={`tabular-nums text-[10px] ${
                extras.paceDeltaVsLastLap < 0 ? "text-emerald-300" : "text-amber-300"
              }`}
              title="Cumulative delta vs last lap, updated at each sector boundary"
            >
              Δ {extras.paceDeltaVsLastLap >= 0 ? "+" : ""}
              {extras.paceDeltaVsLastLap.toFixed(3)}s
            </span>
          ) : (
            <span className="text-foreground/30 text-[10px]">Δ —</span>
          )}
        </div>

        {/* Sector bars + live telemetry + status pills */}
        <div className="flex flex-col items-end gap-0.5">
          <SectorBars status={extras?.sectorStatus} />
          {telemetry && r.status !== "out" && <TelemetryStrip tel={telemetry} />}
          {r.status === "pit" && (
            <span className="rounded bg-amber-500/20 px-1 py-px text-[9px] uppercase tracking-widest text-amber-300">
              PIT
            </span>
          )}
          {r.status === "out" && (
            <span className="rounded bg-red-500/20 px-1 py-px text-[9px] uppercase tracking-widest text-red-300">
              OUT
            </span>
          )}
        </div>
      </button>
      {isSelected && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSetReference();
          }}
          className={`absolute right-1 top-1 rounded p-1 text-xs leading-none transition-colors ${
            isReference ? "text-amber-400" : "text-foreground/30 hover:text-amber-300"
          }`}
          aria-label={isReference ? "Reference driver" : "Set as reference"}
          title={isReference ? "Reference driver" : "Set as reference"}
        >
          {isReference ? "★" : "☆"}
        </button>
      )}
    </li>
  );
}

/** Tight live-telemetry strip: speed · gear · DRS chip. Updates on each
 *  playback frame so the leaderboard row doubles as a per-driver
 *  micro-readout without bloating layout. */
function TelemetryStrip({ tel }: { tel: RowTelemetry }) {
  return (
    <div className="flex items-center gap-1 text-[9px] tabular-nums leading-none">
      <span className="text-foreground/80">{Math.round(tel.speed)}</span>
      <span className="text-muted-foreground">kph</span>
      {tel.gear != null && tel.gear > 0 && (
        <span
          className="text-foreground/70 ml-0.5"
          title={`Gear ${tel.gear}`}
        >
          G{tel.gear}
        </span>
      )}
      <span
        className={`ml-0.5 rounded px-1 py-px text-[8px] font-semibold uppercase tracking-widest ${
          tel.drs
            ? "bg-emerald-500/30 text-emerald-200"
            : "text-foreground/25"
        }`}
        title={tel.drs ? "DRS open" : "DRS closed"}
      >
        DRS
      </span>
    </div>
  );
}

function PositionArrow({ change }: { change: number }) {
  if (change === 0) return null;
  const positive = change > 0;
  return (
    <span
      className={`flex items-center gap-px text-[9px] leading-none tabular-nums ${
        positive ? "text-emerald-400" : "text-red-400"
      }`}
      aria-label={positive ? `gained ${change} places` : `lost ${-change} places`}
    >
      <span aria-hidden>{positive ? "▲" : "▼"}</span>
      {Math.abs(change)}
    </span>
  );
}

const COMPOUND_STYLES: Record<string, { bg: string; text: string; border: string; short: string }> = {
  SOFT: { bg: "rgba(239,68,68,0.25)", text: "#fecaca", border: "rgba(239,68,68,0.55)", short: "SFT" },
  MEDIUM: { bg: "rgba(251,191,36,0.25)", text: "#fde68a", border: "rgba(251,191,36,0.55)", short: "MED" },
  HARD: { bg: "rgba(255,255,255,0.18)", text: "#f5f5f5", border: "rgba(255,255,255,0.45)", short: "HRD" },
  INTERMEDIATE: { bg: "rgba(16,185,129,0.25)", text: "#a7f3d0", border: "rgba(16,185,129,0.55)", short: "INT" },
  WET: { bg: "rgba(59,130,246,0.3)", text: "#bfdbfe", border: "rgba(59,130,246,0.6)", short: "WET" },
};
const COMPOUND_FALLBACK = { bg: "rgba(255,255,255,0.12)", text: "#e5e7eb", border: "rgba(255,255,255,0.25)", short: "—" };

function TyreBadge({ compound, age }: { compound: string; age: number }) {
  const key = compound.toUpperCase();
  const style = COMPOUND_STYLES[key] ?? { ...COMPOUND_FALLBACK, short: key.slice(0, 3) };
  return (
    <span
      className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest"
      style={{
        background: style.bg,
        color: style.text,
        borderColor: style.border,
      }}
      title={`${compound} · ${age} lap${age === 1 ? "" : "s"} on this set`}
    >
      <span>{style.short}</span>
      <span className="tabular-nums opacity-90">L{age}</span>
    </span>
  );
}

const SECTOR_COLOURS: Record<SectorStatus, string> = {
  purple: "bg-fuchsia-500",
  green: "bg-emerald-400",
  yellow: "bg-amber-400",
};

function SectorBars({
  status,
}: {
  status: [SectorStatus | null, SectorStatus | null, SectorStatus | null] | undefined;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {[0, 1, 2].map((i) => {
        const s = status?.[i];
        const cls = s ? SECTOR_COLOURS[s] : "bg-foreground/15";
        return (
          <span
            key={i}
            className={`block h-2.5 w-3 rounded-sm ${cls}`}
            aria-label={s ? `Sector ${i + 1}: ${s}` : `Sector ${i + 1}: no data`}
            title={s ? `S${i + 1}: ${s}` : `S${i + 1}: —`}
          />
        );
      })}
    </div>
  );
}

function formatLapTime(s: number | null | undefined): string {
  if (s == null) return "—";
  const minutes = Math.floor(s / 60);
  const seconds = s - minutes * 60;
  if (minutes === 0) return `${seconds.toFixed(3)}`;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}
