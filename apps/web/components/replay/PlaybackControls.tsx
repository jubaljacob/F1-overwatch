"use client";

import {
  type PlaybackSpeed,
  SPEED_OPTIONS,
  usePlaybackStore,
} from "@/lib/replay-engine/playback-store";
import { formatLapTime } from "@/lib/utils";
import type { Frame, RaceData } from "@traceline/shared-types";
import { useMemo, useState } from "react";

interface Props {
  raceData: RaceData;
}

/** Find the first frame time at which the leader hits each lap N.
 *  Used to render tick marks on the scrubber and to power jump-to-lap. */
function buildLapStartTimes(frames: readonly Frame[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const f of frames) {
    let maxLap = 0;
    for (const s of Object.values(f.p)) if (s.lap > maxLap) maxLap = s.lap;
    if (maxLap > 0 && !out.has(maxLap)) out.set(maxLap, f.t);
  }
  return out;
}

export function PlaybackControls({ raceData }: Props) {
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const currentTime = usePlaybackStore((s) => s.currentTime);
  const speed = usePlaybackStore((s) => s.speed);
  const togglePlay = usePlaybackStore((s) => s.togglePlay);
  const seek = usePlaybackStore((s) => s.seek);
  const stepFrames = usePlaybackStore((s) => s.stepFrames);
  const setSpeed = usePlaybackStore((s) => s.setSpeed);
  const jumpToLap = usePlaybackStore((s) => s.jumpToLap);
  const reset = usePlaybackStore((s) => s.reset);

  const { t_start, t_end, total_laps } = raceData.meta;
  const span = Math.max(1e-6, t_end - t_start);
  const elapsed = currentTime - t_start;
  const remaining = Math.max(0, t_end - currentTime);
  const pct = Math.max(0, Math.min(100, (elapsed / span) * 100));

  const lapStarts = useMemo(() => buildLapStartTimes(raceData.frames), [raceData.frames]);
  const currentLap = useMemo(() => {
    let lap = 0;
    for (const [n, t] of lapStarts) if (t <= currentTime && n > lap) lap = n;
    return lap;
  }, [lapStarts, currentTime]);

  const [lapInput, setLapInput] = useState("");

  function submitLap(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(lapInput);
    if (Number.isFinite(n) && n > 0) jumpToLap(Math.floor(n));
    setLapInput("");
  }

  // Render lap ticks below the scrubber. Drop every other tick if the race is
  // long, so a 70-lap race doesn't turn the bar into a solid stripe.
  const tickEntries = Array.from(lapStarts.entries()).filter(([n]) =>
    lapStarts.size > 40 ? n % 5 === 0 : true,
  );

  return (
    <div className="bg-background/80 flex flex-col gap-2 border-t border-foreground/10 p-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          className="rounded bg-foreground px-3 py-1.5 text-sm font-medium text-background hover:opacity-90"
          aria-label={isPlaying ? "Pause" : "Play"}
          title={isPlaying ? "Pause (Space)" : "Play (Space)"}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          type="button"
          onClick={reset}
          className="rounded border border-foreground/20 px-2 py-1 text-xs"
          title="Restart from lap 1"
        >
          ⟲
        </button>
        <button
          type="button"
          onClick={() => stepFrames(-10)}
          className="rounded border border-foreground/20 px-2 py-1 text-xs"
          aria-label="Back 1 second"
          title="Back 1s (Shift+←)"
        >
          −1s
        </button>
        <button
          type="button"
          onClick={() => stepFrames(10)}
          className="rounded border border-foreground/20 px-2 py-1 text-xs"
          aria-label="Forward 1 second"
          title="Forward 1s (Shift+→)"
        >
          +1s
        </button>

        <div className="ml-2 flex items-center gap-1">
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s as PlaybackSpeed)}
              className={`rounded px-2 py-1 text-xs ${
                speed === s
                  ? "bg-foreground text-background"
                  : "border border-foreground/20 text-foreground/70"
              }`}
            >
              {s}x
            </button>
          ))}
        </div>

        <form onSubmit={submitLap} className="ml-2 flex items-center gap-1">
          <label
            htmlFor="jump-to-lap"
            className="text-muted-foreground text-[10px] uppercase tracking-widest"
          >
            Lap
          </label>
          <input
            id="jump-to-lap"
            type="number"
            inputMode="numeric"
            min={1}
            max={total_laps || undefined}
            value={lapInput}
            onChange={(e) => setLapInput(e.target.value)}
            placeholder={String(currentLap || 1)}
            className="w-14 rounded border border-foreground/20 bg-transparent px-1.5 py-0.5 text-xs"
            aria-label="Jump to lap"
          />
        </form>

        <span className="text-muted-foreground ml-auto flex items-center gap-3 font-mono text-xs tabular-nums">
          <span>
            L{currentLap}
            {total_laps ? `/${total_laps}` : ""}
          </span>
          <span>
            {formatLapTime(elapsed)} / {formatLapTime(span)}
          </span>
          <span className="text-foreground/40">−{formatLapTime(remaining)}</span>
        </span>
      </div>

      <div className="relative">
        <input
          type="range"
          min={t_start}
          max={t_end}
          step={0.1}
          value={currentTime}
          onChange={(e) => seek(Number(e.target.value))}
          className="w-full accent-foreground"
          aria-label="Seek"
          aria-valuetext={`${pct.toFixed(0)} percent`}
        />
        {tickEntries.length > 0 && (
          <div className="pointer-events-none relative -mt-1 h-2">
            {tickEntries.map(([n, t]) => {
              const pos = ((t - t_start) / span) * 100;
              return (
                <div
                  key={n}
                  className="absolute top-0 h-1 w-px bg-foreground/25"
                  style={{ left: `${pos}%` }}
                  title={`Lap ${n}`}
                />
              );
            })}
          </div>
        )}
      </div>

      <p className="text-muted-foreground text-[10px]">
        Space play/pause · ←/→ step frame · Shift+←/→ ±1s · click a driver to focus
      </p>
    </div>
  );
}
