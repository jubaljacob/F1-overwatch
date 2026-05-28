"use client";

import { useEffect, useRef, useState } from "react";
import { SEASON_INDEX, type RaceRecord } from "@/lib/season-data";

interface Props {
  selectedYear: number;
  /** Schedule for the currently-selected year. Comes from useSeason in
   *  the parent so the dropdown stays in sync with the dashboard data. */
  schedule: RaceRecord[];
  /** Fires when the user picks a year — parent refetches and (likely)
   *  resets selectedRound. */
  onYearChange: (year: number) => void;
  /** Fires when the user picks a race. The parent decides whether to
   *  highlight it in the calendar (live season) or route to /replay
   *  (past seasons). */
  onRaceChange: (round: number) => void;
}

/**
 * Two-step picker at the top of the dashboard: choose a season, then a race
 * within that season. The race list reflects whichever year is currently
 * active in the parent's `useSeason` query.
 */
export function SeasonRaceDropdown({
  selectedYear,
  schedule,
  onYearChange,
  onRaceChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // Click-outside-to-close. Plain document listener; no need for a framework.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div className="relative" ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-bold uppercase tracking-widest text-white transition-colors hover:bg-white/15"
      >
        <span>{selectedYear} Season</span>
        <ChevronIcon open={open} />
      </button>

      {open && (
        <div className="absolute left-0 right-auto z-50 mt-2 grid w-[420px] grid-cols-[120px_1fr] overflow-hidden rounded-2xl border border-white/10 bg-carbon-deep shadow-xl">
          <div className="border-r border-white/10 bg-white/[0.02] py-2">
            {SEASON_INDEX.map((s) => {
              const active = s.year === selectedYear;
              return (
                <button
                  key={s.year}
                  onClick={() => onYearChange(s.year)}
                  className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm transition-colors ${
                    active
                      ? "bg-warm-red/10 text-warm-red font-bold"
                      : "text-white/75 hover:bg-white/5"
                  }`}
                >
                  <span className="tabular-nums">{s.year}</span>
                  {active && <span className="text-[10px]">●</span>}
                </button>
              );
            })}
          </div>

          <div className="max-h-[320px] overflow-y-auto py-2">
            {schedule.length === 0 ? (
              <div className="px-4 py-6 text-xs text-white/55">
                Loading {selectedYear} schedule…
              </div>
            ) : (
              schedule.map((r) => (
                <button
                  key={r.round}
                  onClick={() => {
                    onRaceChange(r.round);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors hover:bg-white/5"
                >
                  <span className="w-8 text-xs font-bold uppercase text-white/45 tabular-nums">
                    R{String(r.round).padStart(2, "0")}
                  </span>
                  <span className="flex-1 truncate font-semibold text-white">
                    {r.name}
                  </span>
                  <span className="text-xs text-white/45">{r.location}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path d="M2 4 L 6 8 L 10 4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
