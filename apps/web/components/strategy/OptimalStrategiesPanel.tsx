"use client";

import type { RankedStrategy } from "@traceline/shared-types";

interface Props {
  ranked: RankedStrategy[] | null;
  busy?: boolean;
  /** Loads a ranked strategy into the editor for further tweaking. */
  onPick: (strategy: RankedStrategy) => void;
}

const COMPOUND_COLOURS: Record<string, string> = {
  SOFT: "bg-red-500/30 text-red-100 border-red-500/40",
  MEDIUM: "bg-amber-400/30 text-amber-100 border-amber-400/50",
  HARD: "bg-white/20 text-foreground border-white/30",
};

export function OptimalStrategiesPanel({ ranked, busy, onPick }: Props) {
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <h3 className="text-xs uppercase tracking-widest text-muted-foreground">
        Optimal strategies
      </h3>
      {busy && (
        <p className="text-muted-foreground text-xs italic">
          Searching {/* ~7000 candidates fits in <1s for one driver */}
          1- and 2-stop candidates…
        </p>
      )}
      {!busy && !ranked && (
        <p className="text-muted-foreground text-xs italic">
          Click "Find optimal" below to enumerate the top-3 strategies for this driver.
        </p>
      )}
      <div className="flex-1 space-y-2 overflow-y-auto">
        {ranked?.map((r) => (
          <StrategyCard key={`${r.rank}-${r.strategy.starting_compound}`} ranked={r} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function StrategyCard({
  ranked,
  onPick,
}: {
  ranked: RankedStrategy;
  onPick: (s: RankedStrategy) => void;
}) {
  const { rank, strategy, result } = ranked;
  const delta = result.delta_to_actual_s;
  const compoundChain = [
    strategy.starting_compound,
    ...strategy.pit_stops.map((p) => p.new_compound),
  ];

  return (
    <button
      type="button"
      onClick={() => onPick(ranked)}
      className="w-full rounded border border-foreground/10 bg-foreground/[0.04] p-2 text-left transition-colors hover:border-foreground/30 hover:bg-foreground/[0.08]"
      title="Load this strategy into the editor"
    >
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground">
          #{rank}
        </span>
        <span className="text-xs tabular-nums">
          {formatRaceTime(result.total_race_time_s)}
          {delta != null && (
            <span
              className={`ml-1 text-[10px] ${
                delta < 0 ? "text-emerald-300" : "text-amber-200"
              }`}
            >
              ({delta >= 0 ? "+" : ""}
              {delta.toFixed(1)}s)
            </span>
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {compoundChain.map((c, i) => (
          <span key={i} className="contents">
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
                COMPOUND_COLOURS[c] ?? "bg-foreground/15 text-foreground border-foreground/20"
              }`}
            >
              {c}
            </span>
            {i < strategy.pit_stops.length && (
              <span className="text-foreground/40 text-[10px]">
                L{strategy.pit_stops[i]!.lap}
              </span>
            )}
          </span>
        ))}
      </div>
    </button>
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
