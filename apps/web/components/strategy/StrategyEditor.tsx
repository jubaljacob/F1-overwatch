"use client";

import type { PitStop, Strategy } from "@traceline/shared-types";

interface Props {
  strategy: Strategy;
  totalLaps: number;
  availableCompounds: readonly string[];
  /** True while the simulation request is in flight or refetching. */
  busy?: boolean;
  onChange: (next: Strategy) => void;
  onSimulate: () => void;
  onResetToActual: () => void;
}

const COMPOUND_COLOURS: Record<string, string> = {
  SOFT: "bg-red-500/30 text-red-100 border-red-500/40",
  MEDIUM: "bg-amber-400/30 text-amber-100 border-amber-400/50",
  HARD: "bg-white/20 text-foreground border-white/30",
};

export function StrategyEditor({
  strategy,
  totalLaps,
  availableCompounds,
  busy,
  onChange,
  onSimulate,
  onResetToActual,
}: Props) {
  const compoundsForPicker = availableCompounds.length > 0 ? availableCompounds : ["SOFT", "MEDIUM", "HARD"];

  function setStartingCompound(c: string) {
    onChange({ ...strategy, starting_compound: c });
  }
  function setPitStop(i: number, patch: Partial<PitStop>) {
    const next = strategy.pit_stops.map((p, j) => (i === j ? { ...p, ...patch } : p));
    onChange({ ...strategy, pit_stops: next });
  }
  function removePitStop(i: number) {
    onChange({ ...strategy, pit_stops: strategy.pit_stops.filter((_, j) => j !== i) });
  }
  function addPitStop() {
    // Default new stop ~halfway through whatever's left of the race, on a
    // different compound from the previous stint.
    const lastLap = strategy.pit_stops[strategy.pit_stops.length - 1]?.lap ?? 0;
    const newLap = Math.min(totalLaps - 3, Math.max(lastLap + 8, Math.floor(totalLaps / 2)));
    const lastCompound =
      strategy.pit_stops[strategy.pit_stops.length - 1]?.new_compound ??
      strategy.starting_compound;
    const alt = compoundsForPicker.find((c) => c !== lastCompound) ?? compoundsForPicker[0]!;
    onChange({
      ...strategy,
      pit_stops: [...strategy.pit_stops, { lap: newLap, new_compound: alt }],
    });
  }

  return (
    <div className="flex h-full flex-col gap-3 p-3 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-widest text-muted-foreground">
          Strategy
        </h3>
        <button
          type="button"
          onClick={onResetToActual}
          className="text-[10px] uppercase tracking-widest text-foreground/50 hover:text-foreground"
        >
          ↺ reset to actual
        </button>
      </div>

      {/* Starting compound */}
      <div className="space-y-1">
        <label className="text-[10px] uppercase tracking-widest text-muted-foreground">
          Start
        </label>
        <CompoundPicker
          value={strategy.starting_compound}
          options={compoundsForPicker}
          onChange={setStartingCompound}
        />
      </div>

      {/* Pit stops */}
      <div className="flex-1 space-y-2 overflow-y-auto">
        {strategy.pit_stops.length === 0 && (
          <p className="text-xs text-muted-foreground italic">
            No pit stops — running a no-stop strategy. F1 dry-race rules require ≥2
            compounds, so add at least one stop.
          </p>
        )}
        {strategy.pit_stops.map((stop, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded border border-foreground/10 bg-foreground/[0.04] p-2"
          >
            <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
              Stop {i + 1}
            </span>
            <label className="flex items-center gap-1">
              <span className="text-[10px] text-muted-foreground">Lap</span>
              <input
                type="number"
                min={1}
                max={totalLaps - 1}
                value={stop.lap}
                onChange={(e) => setPitStop(i, { lap: Number(e.target.value) })}
                className="w-14 rounded border border-foreground/15 bg-background px-1.5 py-0.5 text-right tabular-nums"
              />
            </label>
            <CompoundPicker
              value={stop.new_compound}
              options={compoundsForPicker}
              onChange={(c) => setPitStop(i, { new_compound: c })}
            />
            <button
              type="button"
              onClick={() => removePitStop(i)}
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-foreground/40 hover:bg-red-500/15 hover:text-red-200"
              aria-label={`Remove pit stop ${i + 1}`}
            >
              remove
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addPitStop}
          className="w-full rounded border border-dashed border-foreground/20 px-2 py-1.5 text-[11px] uppercase tracking-widest text-foreground/60 hover:border-foreground/40 hover:text-foreground"
        >
          + add pit stop
        </button>
      </div>

      <button
        type="button"
        onClick={onSimulate}
        disabled={busy}
        className="rounded bg-foreground px-3 py-2 text-sm font-semibold text-background transition-opacity disabled:opacity-50"
      >
        {busy ? "Simulating…" : "Simulate strategy"}
      </button>
    </div>
  );
}

function CompoundPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((c) => {
        const cls = COMPOUND_COLOURS[c] ?? "bg-foreground/15 text-foreground border-foreground/20";
        const active = c === value;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onChange(c)}
            className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-widest transition-opacity ${cls} ${
              active ? "opacity-100 ring-1 ring-foreground/30" : "opacity-50 hover:opacity-80"
            }`}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}
