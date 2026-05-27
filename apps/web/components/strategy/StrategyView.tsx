"use client";

import {
  getActualStrategy,
  getOptimalStrategies,
  getTyreModel,
  simulateStrategy,
} from "@/lib/api";
import { usePlaybackStore } from "@/lib/replay-engine/playback-store";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { RaceData, RankedStrategy, Strategy } from "@traceline/shared-types";
import { useEffect, useState } from "react";

import { OptimalStrategiesPanel } from "./OptimalStrategiesPanel";
import { StrategyEditor } from "./StrategyEditor";
import { StrategyResultChart } from "./StrategyResultChart";

interface Props {
  raceData: RaceData;
}

export function StrategyView({ raceData }: Props) {
  const selected = usePlaybackStore((s) => s.selectedDrivers);
  const reference = usePlaybackStore((s) => s.referenceDriver);
  const targetDriver = reference ?? selected[0] ?? null;

  const { year, round, total_laps: total_laps_meta } = raceData.meta;

  // Tyre model: triggers the per-circuit fit on the backend. Cached at the
  // backend so subsequent simulate calls don't refit.
  const tyreModelQ = useQuery({
    queryKey: ["tyre-model", year, round],
    queryFn: () => getTyreModel(year, round),
    staleTime: Number.POSITIVE_INFINITY,
    enabled: targetDriver != null,
  });

  // Pull the driver's actual strategy as the editor's initial state.
  const actualStrategyQ = useQuery({
    queryKey: ["actual-strategy", year, round, targetDriver],
    queryFn: () => getActualStrategy(year, round, targetDriver as number),
    enabled: targetDriver != null,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const [editorStrategy, setEditorStrategy] = useState<Strategy | null>(null);
  const [rankedStrategies, setRankedStrategies] = useState<RankedStrategy[] | null>(null);

  // Seed / reseed the editor whenever the target driver changes — but don't
  // clobber the user's in-progress edits when the actual fetch resolves a
  // second time for the same driver (handled by the keyed effect below).
  useEffect(() => {
    if (actualStrategyQ.data) setEditorStrategy(actualStrategyQ.data);
    setRankedStrategies(null);
  }, [actualStrategyQ.data, targetDriver]);

  const simulateM = useMutation({
    mutationFn: (s: Strategy) =>
      simulateStrategy(year, round, targetDriver as number, s),
  });
  const optimalM = useMutation({
    mutationFn: () =>
      getOptimalStrategies(year, round, targetDriver as number, 3).then((r) => {
        setRankedStrategies(r);
        return r;
      }),
  });

  if (targetDriver == null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Select a driver in the leaderboard to start exploring strategies.
      </div>
    );
  }
  if (tyreModelQ.isLoading || !tyreModelQ.data || actualStrategyQ.isLoading || !editorStrategy) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
        Fitting tyre model for {raceData.meta.circuit}… first call is slow on a cold cache.
      </div>
    );
  }
  if (tyreModelQ.isError) {
    return (
      <div className="text-red-300 flex h-full items-center justify-center text-xs">
        Tyre model failed: {(tyreModelQ.error as Error).message}
      </div>
    );
  }

  const totalLaps = tyreModelQ.data.total_laps || total_laps_meta || 50;
  const availableCompounds = tyreModelQ.data.compounds.map((c) => c.compound);

  function resetToActual() {
    if (actualStrategyQ.data) setEditorStrategy(actualStrategyQ.data);
    simulateM.reset();
  }

  function handleSimulate() {
    if (editorStrategy) simulateM.mutate(editorStrategy);
  }

  function handleFindOptimal() {
    optimalM.mutate();
  }

  function loadRankedIntoEditor(r: RankedStrategy) {
    setEditorStrategy(r.strategy);
    simulateM.reset();
  }

  return (
    <div className="grid h-full grid-cols-[280px_1fr_280px] divide-x divide-foreground/10">
      <StrategyEditor
        strategy={editorStrategy}
        totalLaps={totalLaps}
        availableCompounds={availableCompounds}
        busy={simulateM.isPending}
        onChange={setEditorStrategy}
        onSimulate={handleSimulate}
        onResetToActual={resetToActual}
      />
      <StrategyResultChart
        raceData={raceData}
        driverNum={targetDriver}
        result={simulateM.data ?? null}
        busy={simulateM.isPending}
      />
      <div className="flex h-full flex-col">
        <div className="flex-1 overflow-y-auto">
          <OptimalStrategiesPanel
            ranked={rankedStrategies}
            busy={optimalM.isPending}
            onPick={loadRankedIntoEditor}
          />
        </div>
        <div className="border-t border-foreground/10 p-3">
          <button
            type="button"
            onClick={handleFindOptimal}
            disabled={optimalM.isPending}
            className="w-full rounded bg-foreground/15 px-3 py-1.5 text-xs uppercase tracking-widest text-foreground transition-opacity hover:bg-foreground/20 disabled:opacity-50"
          >
            {optimalM.isPending ? "Searching…" : "Find optimal strategies"}
          </button>
        </div>
      </div>
    </div>
  );
}
