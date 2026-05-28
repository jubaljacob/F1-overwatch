"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { RaceRecord, SeasonSummary } from "@/lib/season-data";
import { TrackSketch } from "./TrackSketch";

interface Props {
  year: number;
  schedule: RaceRecord[];
  summary: SeasonSummary;
  /** When set, the calendar scrolls this round into view on mount and on
   *  changes. If the matching round is inside the collapsed upcoming list,
   *  the list auto-opens. */
  highlightRound?: number;
  /** Called when the user clicks a completed-race row (anywhere except
   *  the Replay button). The parent uses this to swap the centre column
   *  to a completed-race view. */
  onSelectRace?: (round: number) => void;
  /** Per-round set of cached session types. Rows whose round is in this
   *  map get a "SAVED" indicator listing which sessions (R, Q, etc.) are
   *  on disk and will replay instantly with no network. */
  cachedRounds?: Map<number, Set<string>>;
}

/**
 * Vertical calendar. Completed races appear at the top with `Replay` CTAs
 * (they're replayable). The next race is rendered as the hero row in the
 * middle. Remaining upcoming races are tucked inside a collapsible accordion
 * to keep the column compact on the side panel.
 */
export function CalendarSection({ year, summary, highlightRound, onSelectRace, cachedRounds }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const upcomingRest = summary.upcoming.slice(1);
  const highlightInUpcoming =
    highlightRound != null && upcomingRest.some((r) => r.round === highlightRound);
  const [showUpcoming, setShowUpcoming] = useState(false);

  // Auto-expand the upcoming list when the user selects a race from the
  // dropdown that's hidden inside it.
  useEffect(() => {
    if (highlightInUpcoming) setShowUpcoming(true);
  }, [highlightInUpcoming]);

  // Re-run the scroll-into-view after the accordion finishes opening,
  // otherwise the target row hasn't been laid out yet.
  useEffect(() => {
    if (highlightRound == null) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-round="${highlightRound}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlightRound, showUpcoming]);

  const next = summary.nextRace;

  return (
    <section className="space-y-5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-3xl font-black tracking-tight text-white">Calendar</h3>
        <span className="text-xs uppercase tracking-widest text-white/55">
          {summary.completedRounds} done · {summary.totalRounds - summary.completedRounds} to go
        </span>
      </div>

      <div ref={containerRef} className="space-y-3">
        {summary.completed.map((r) => (
          <Row
            key={r.round}
            year={year}
            race={r}
            state="completed"
            highlight={highlightRound === r.round}
            onSelect={onSelectRace}
            cachedTypes={cachedRounds?.get(r.round)}
          />
        ))}

        {next && (
          <HeroRow year={year} race={next} highlight={highlightRound === next.round} />
        )}

        {upcomingRest.length > 0 && (
          <div className="overflow-hidden rounded-3xl border border-white/10 bg-[#0a0a12]">
            <button
              type="button"
              onClick={() => setShowUpcoming((o) => !o)}
              className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-white/[0.03]"
            >
              <div className="flex flex-col">
                <span className="text-sm font-bold uppercase tracking-widest text-white">
                  Upcoming Races
                </span>
                <span className="text-[11px] text-white/55">
                  {upcomingRest.length} rounds left this season
                </span>
              </div>
              <span
                aria-hidden
                className={`grid h-7 w-7 place-items-center rounded-full bg-white/10 text-white transition-transform duration-500 ${
                  showUpcoming ? "rotate-180" : ""
                }`}
              >
                <svg
                  viewBox="0 0 12 12"
                  className="h-3 w-3"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M2 4 L 6 8 L 10 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            </button>
            <div
              className="grid transition-[grid-template-rows] duration-500 ease-out"
              style={{ gridTemplateRows: showUpcoming ? "1fr" : "0fr" }}
            >
              <div className="overflow-hidden">
                <div className="space-y-3 border-t border-white/5 px-2 py-3">
                  {upcomingRest.map((r) => (
                    <Row
                      key={r.round}
                      year={year}
                      race={r}
                      state="upcoming"
                      highlight={highlightRound === r.round}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function HeroRow({
  year,
  race,
  highlight,
}: {
  year: number;
  race: RaceRecord;
  highlight: boolean;
}) {
  return (
    <div
      data-round={race.round}
      className={`relative overflow-hidden rounded-3xl p-6 ${
        highlight ? "ring-2 ring-warm-red" : ""
      }`}
      style={{
        background:
          "linear-gradient(135deg, rgba(255,30,0,0.95) 0%, rgba(180,10,0,0.95) 70%, rgba(80,5,0,0.95) 100%)",
      }}
    >
      <div className="relative grid grid-cols-[1fr_auto] items-center gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-white/80">
            Round {String(race.round).padStart(2, "0")} · Next up
          </div>
          <div className="mt-1 text-3xl font-black tracking-tight text-white">
            {race.name}
          </div>
          <div className="text-sm font-semibold text-white/90">{race.location}</div>
          <div className="mt-3 text-xs tabular-nums text-white/75">
            {new Date(race.date).toLocaleDateString(undefined, {
              day: "2-digit",
              month: "short",
              year: "numeric",
            })}
          </div>
        </div>
        <div className="h-20 w-32 opacity-80">
          <TrackSketch circuitKey={race.circuitKey} color="#ffffff" />
        </div>
      </div>
    </div>
  );
}

function Row({
  year,
  race,
  state,
  highlight,
  onSelect,
  cachedTypes,
}: {
  year: number;
  race: RaceRecord;
  state: "completed" | "upcoming";
  highlight: boolean;
  onSelect?: (round: number) => void;
  /** Session types saved on disk for this round. Undefined or empty =
   *  no badge; otherwise the badge text lists the saved types (e.g. "R · Q"). */
  cachedTypes?: Set<string>;
}) {
  const date = new Date(race.date);
  const clickable = state === "completed" && onSelect != null;
  // Stable display order: R first (most common), then Q, then sprint/other.
  const cachedList = cachedTypes
    ? Array.from(cachedTypes).sort((a, b) => {
        const order: Record<string, number> = { R: 0, Q: 1, S: 2 };
        return (order[a] ?? 99) - (order[b] ?? 99);
      })
    : [];
  // Completed rows are interactive — clicking anywhere (except the Replay
  // button, which stops propagation) tells the parent to swap the centre
  // column to this race's view.
  const interactiveProps = clickable
    ? {
        role: "button" as const,
        tabIndex: 0,
        onClick: () => onSelect?.(race.round),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect?.(race.round);
          }
        },
      }
    : {};
  return (
    <div
      data-round={race.round}
      {...interactiveProps}
      className={`group grid grid-cols-[64px_1fr_auto_120px] items-center gap-4 rounded-2xl px-4 py-4 transition-colors hover:bg-white/5 ${
        highlight ? "ring-1 ring-warm-red/60" : ""
      } ${clickable ? "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-warm-red" : ""}`}
    >
      <div className="flex flex-col items-start">
        <span className="text-2xl font-bold text-white tabular-nums">
          {date.getDate()}
        </span>
        <span className="text-[10px] uppercase tracking-widest text-white/55">
          {date.toLocaleDateString(undefined, { month: "short" })}
        </span>
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-lg font-bold text-white">
            {race.name}
          </span>
          {cachedList.length > 0 && (
            <span
              title={`Cached locally (${cachedList.join(", ")}) — replays instantly with no network`}
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-widest text-emerald-300"
            >
              <span aria-hidden>●</span>
              {cachedList.join(" · ")} Saved
            </span>
          )}
        </div>
        <div className="truncate text-xs text-white/55">
          <span className="font-semibold tabular-nums">
            R{String(race.round).padStart(2, "0")}
          </span>{" "}
          ·{" "}
          <span
            className={state === "completed" ? "text-white/55" : "text-warm-red"}
          >
            {race.location}
          </span>
        </div>
      </div>
      <div className="h-12 w-20 opacity-70 transition-opacity group-hover:opacity-100">
        <TrackSketch circuitKey={race.circuitKey} color="#ffffff" />
      </div>
      {state === "completed" ? (
        <Link
          href={`/replay/${year}/${race.round}`}
          // Stop the click from bubbling to the row's onSelect handler —
          // the Replay button must always route, regardless of selection.
          onClick={(e) => e.stopPropagation()}
          className="bg-warm-red rounded-full px-4 py-2 text-center text-xs font-bold uppercase tracking-widest text-white transition-transform hover:scale-[1.03]"
        >
          Replay →
        </Link>
      ) : (
        <span className="rounded-full border border-white/20 px-4 py-2 text-center text-[10px] uppercase tracking-widest text-white/55">
          Upcoming
        </span>
      )}
    </div>
  );
}
