"use client";

import type { SeasonSummary } from "@/lib/season-data";

interface Props {
  summary: SeasonSummary;
}

/**
 * Compact red side-bar card surfacing season-wide progress. Lifted out of
 * the hero so the centre column can stay tight on the next-race story.
 */
export function SeasonStatsCard({ summary }: Props) {
  return (
    <section
      className="relative overflow-hidden rounded-3xl border border-white/10 p-6"
      style={{ backgroundColor: "rgb(177, 20, 8)" }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background:
            "radial-gradient(circle at 80% 0%, rgba(255,255,255,0.35), transparent 55%)",
        }}
      />
      <div className="relative mb-5 flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-[0.4em] text-white/80">
          Season Progress
        </div>
        <div className="text-[10px] uppercase tracking-widest text-white/60">
          2026
        </div>
      </div>
      <div className="relative grid grid-cols-[auto_1fr] items-center gap-5">
        <ProgressRing fraction={summary.progressFraction} />
        <div className="space-y-3">
          <StatBlock
            big={`${summary.completedRounds}/${summary.totalRounds}`}
            label="GP Completed"
          />
          <StatBlock big={`${summary.kmCovered.toFixed(1)} KM`} label="Covered" />
          <StatBlock big={String(summary.lapsCompleted)} label="Laps Completed" />
        </div>
      </div>
    </section>
  );
}

function StatBlock({ big, label }: { big: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xl font-bold text-white tabular-nums">{big}</span>
      <span className="text-[10px] uppercase tracking-widest text-white/65">
        {label}
      </span>
    </div>
  );
}

function ProgressRing({ fraction }: { fraction: number }) {
  // Same ring as in the inspo: thicker stroke, white on red, big % label.
  const pct = Math.round(fraction * 100);
  const radius = 38;
  const c = 2 * Math.PI * radius;
  const dash = c * Math.min(Math.max(fraction, 0), 1);
  return (
    <div className="flex items-center justify-center">
      <div className="relative h-24 w-24">
        <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
          <circle cx="50" cy="50" r={radius} stroke="rgba(255,255,255,0.18)" strokeWidth="8" fill="none" />
          <circle
            cx="50"
            cy="50"
            r={radius}
            stroke="#ffffff"
            strokeWidth="8"
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${dash} ${c}`}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-xl font-bold text-white tabular-nums">
          {pct}%
        </div>
      </div>
    </div>
  );
}
