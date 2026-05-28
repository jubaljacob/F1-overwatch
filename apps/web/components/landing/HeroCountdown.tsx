"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { type RaceRecord, countdownTo } from "@/lib/season-data";
import { TrackSketch } from "./TrackSketch";

interface Props {
  race: RaceRecord;
  /** "upcoming" shows the FP1 countdown; "completed" shows a Completed
   *  label and a Replay CTA pointing at /replay/{year}/{round}. */
  mode?: "upcoming" | "completed";
  /** Required when `mode === "completed"` so the Replay link can route. */
  year?: number;
}

/**
 * Big hero block: oversized GP-name wordmark, location/date, plus either
 * a Practice-1 countdown (upcoming races) or a "Completed" badge with
 * Replay CTA (completed races the user has clicked in the calendar).
 */
export function HeroCountdown({ race, mode = "upcoming", year }: Props) {
  const fp1 = new Date(race.fp1);
  const raceDate = new Date(race.date);
  const [now, setNow] = useState(() => new Date());

  // Tick the countdown every 30s. Cheap, and second-level precision adds
  // nothing visible at this type scale.
  useEffect(() => {
    if (mode !== "upcoming") return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [mode]);

  const cd = countdownTo(fp1, now);
  const wordmark = (race.location.split(/[\s-]/)[0] ?? race.location).toLowerCase();
  const isCompleted = mode === "completed";

  return (
    <section className="relative overflow-hidden rounded-3xl border border-white/5 bg-carbon p-8 md:p-12">
      {/* Ambient glow — warm-red for upcoming, dim ash for completed so the
          eye reads "this is history" without a colour change punch in. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: isCompleted
            ? "radial-gradient(ellipse at 30% 30%, rgba(200,200,210,0.10), transparent 60%), " +
              "radial-gradient(ellipse at 90% 100%, rgba(80,80,90,0.18), transparent 55%)"
            : "radial-gradient(ellipse at 30% 30%, rgba(255,30,0,0.35), transparent 60%), " +
              "radial-gradient(ellipse at 90% 100%, rgba(255,90,31,0.25), transparent 55%)",
        }}
      />

      <div className="relative grid grid-cols-1 gap-8 md:grid-cols-[1fr_360px] md:items-center">
        <div className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute -top-6 -left-2 hidden select-none text-[180px] font-black uppercase leading-[0.85] text-white/[0.06] md:block"
            style={{ letterSpacing: "-0.04em" }}
          >
            {wordmark}
          </span>

          <div className="relative space-y-1">
            <div className="text-xs uppercase tracking-[0.4em] text-white/50">
              Round {String(race.round).padStart(2, "0")}
              {isCompleted && " · Completed"}
            </div>
            <h2 className="text-5xl font-black tracking-tight text-white md:text-6xl">
              {race.name}
            </h2>
            <div className="text-warm-red text-sm font-semibold tracking-wide">
              {race.location}
            </div>
            <div className="text-sm text-white/70 tabular-nums">
              {(isCompleted ? raceDate : fp1).toLocaleDateString(undefined, {
                day: "2-digit",
                month: "short",
                year: "numeric",
              })}
              {!isCompleted && (
                <>
                  {" • "}
                  {fp1.toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  local
                </>
              )}
            </div>
          </div>

          {isCompleted ? (
            <CompletedBadge year={year} round={race.round} />
          ) : (
            <div className="relative mt-8 space-y-2">
              <div className="text-xs uppercase tracking-widest text-white/50">
                {cd.totalMs >= 0 ? "Practice 1 starts in" : "Race weekend in progress"}
              </div>
              <div className="flex items-end gap-6 tabular-nums">
                <CountdownCell value={cd.days} label="Days" />
                <CountdownCell value={cd.hours} label="Hours" />
                <CountdownCell value={cd.minutes} label="Minutes" />
              </div>
            </div>
          )}
        </div>

        <div className="relative flex justify-center md:justify-end">
          <div className="relative aspect-[4/3] w-full max-w-[360px]">
            <TrackSketch circuitKey={race.circuitKey} color="#ffffff" />
          </div>
        </div>
      </div>
    </section>
  );
}

function CountdownCell({ value, label }: { value: number; label: string }) {
  const display = String(Math.max(0, value)).padStart(2, "0");
  return (
    <div className="flex flex-col items-start">
      <span className="text-6xl font-black leading-none text-white md:text-7xl">
        {display}
      </span>
      <span className="mt-1 text-xs uppercase tracking-widest text-white/55">
        {label}
      </span>
    </div>
  );
}

function CompletedBadge({ year, round }: { year?: number; round: number }) {
  return (
    <div className="relative mt-8 flex flex-wrap items-center gap-4">
      <span className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-xs font-bold uppercase tracking-[0.4em] text-white/85">
        Completed
      </span>
      {year != null && (
        <Link
          href={`/replay/${year}/${round}`}
          className="bg-warm-red inline-flex items-center gap-2 rounded-full px-6 py-3 text-xs font-bold uppercase tracking-widest text-white shadow-[0_12px_30px_rgba(255,30,0,0.35)] transition-transform hover:scale-[1.03]"
        >
          Replay this race
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 6 H 9 M 6 3 L 9 6 L 6 9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
      )}
    </div>
  );
}
