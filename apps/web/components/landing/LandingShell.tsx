"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useSeason } from "@/lib/use-season";
import { useRaceResults } from "@/lib/use-race-results";
import { useCachedRounds } from "@/lib/use-cached-rounds";
import { AnimatedTrackPreview } from "./AnimatedTrackPreview";
import { CalendarSection } from "./CalendarSection";
import { CollapsiblePanel } from "./CollapsiblePanel";
import { HeroCountdown } from "./HeroCountdown";
import { RaceDetailCard } from "./RaceDetailCard";
import { SeasonRaceDropdown } from "./SeasonRaceDropdown";
import { SeasonStatsCard } from "./SeasonStatsCard";
import { StandingsPanel } from "./StandingsPanel";

/**
 * The landing page has two states: a split (left preview / right panel)
 * and a full dashboard. Inside the dashboard the user can:
 *   - Change season via the top-bar dropdown → refetches `/seasons/{year}`.
 *     For non-current seasons we route into the replay flow directly when
 *     a race is picked, since the dashboard's per-race data is curated for
 *     the live season only.
 *   - Click a completed race in the calendar → centre column switches to
 *     a "completed" view with top-3 finishers and a Replay CTA.
 */
export function LandingShell({ today }: { today: Date }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  // `selectedRound` is the calendar-driven focus. `undefined` = the
  // dashboard shows the next-race countdown; a round number = the centre
  // column flips to the completed-race view for that round.
  const [selectedRound, setSelectedRound] = useState<number | undefined>();

  const { season, summary, isLive, isLoading } = useSeason(selectedYear, today);

  // Body scroll-lock during the split view; the dashboard handles its own
  // scrolling so we unlock once expanded.
  useEffect(() => {
    document.body.style.overflow = expanded ? "" : "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [expanded]);

  // Reset the highlighted round when the user switches seasons so the
  // dashboard doesn't try to render the prior season's selection against
  // the new schedule.
  useEffect(() => {
    setSelectedRound(undefined);
  }, [selectedYear]);

  return (
    <div className="relative min-h-screen overflow-hidden bg-carbon">
      <div
        className="fixed inset-y-0 left-0 transition-[width,opacity,transform] duration-[900ms] ease-[cubic-bezier(0.83,0,0.17,1)] motion-reduce:duration-150"
        style={{
          width: expanded ? "0%" : "50%",
          opacity: expanded ? 0 : 1,
          transform: expanded ? "translateX(-30%)" : "translateX(0)",
        }}
        aria-hidden={expanded}
      >
        <AnimatedTrackPreview />
      </div>

      <div
        className="fixed inset-y-0 right-0 overflow-y-auto bg-carbon transition-[width] duration-[900ms] ease-[cubic-bezier(0.83,0,0.17,1)] motion-reduce:duration-150"
        style={{ width: expanded ? "100%" : "50%" }}
      >
        {expanded ? (
          <Dashboard
            season={season}
            summary={summary}
            selectedYear={selectedYear}
            selectedRound={selectedRound}
            isLive={isLive}
            isLoading={isLoading}
            onYearChange={setSelectedYear}
            onRaceClick={(round) => {
              // Live season → swap the centre column to the completed view.
              // Past seasons → route straight to /replay since we don't
              // render a dedicated dashboard for them.
              if (selectedYear === today.getFullYear()) {
                setSelectedRound(round);
              } else {
                router.push(`/replay/${selectedYear}/${round}`);
              }
            }}
            onClearSelection={() => setSelectedRound(undefined)}
            onClose={() => setExpanded(false)}
          />
        ) : (
          <SplitPanel onEnter={() => setExpanded(true)} />
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────── split state ────────────────────────────── */

function SplitPanel({ onEnter }: { onEnter: () => void }) {
  return (
    <div className="relative flex h-full flex-col px-8 py-12 md:px-16 md:py-20">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.5em] text-white/55">
          F1Overwatch
        </span>
        <span className="text-[10px] uppercase tracking-[0.5em] text-white/40">
          Live Season
        </span>
      </div>

      <div className="flex flex-1 flex-col justify-center py-10">
        <h1
          className="text-[88px] font-black uppercase leading-[0.85] tracking-[-0.04em] text-white md:text-[120px]"
          style={{
            background:
              "linear-gradient(180deg, #ffffff 0%, #ffffff 60%, rgba(255,30,0,0.7) 120%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          Overwatch
        </h1>
        <p className="mt-6 max-w-md text-lg text-white/75">
          Replay every lap. Compare drivers move-for-move. Simulate pit-stop
          strategy. The race weekend, instrumented.
        </p>

        <button
          type="button"
          onClick={onEnter}
          className="group mt-10 inline-flex w-fit items-center gap-3 rounded-full bg-warm-red px-8 py-4 text-sm font-bold uppercase tracking-widest text-white shadow-[0_20px_60px_rgba(255,30,0,0.45)] transition-transform hover:scale-[1.03] active:scale-[0.99]"
        >
          Enter Overwatch
          <span
            aria-hidden
            className="grid h-7 w-7 place-items-center rounded-full bg-white text-warm-red transition-transform group-hover:translate-x-0.5"
          >
            <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M3 6 H 9 M 6 3 L 9 6 L 6 9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      </div>

      <div className="mt-auto grid grid-cols-3 gap-4 border-t border-white/10 pt-8">
        <FootStat big="21" label="Rounds 2026" />
        <FootStat big="10" label="Teams on grid" />
        <FootStat big="LIVE" label="Replay engine" />
      </div>
    </div>
  );
}

function FootStat({ big, label }: { big: string; label: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-2xl font-black text-white tabular-nums">{big}</div>
      <div className="text-[10px] uppercase tracking-widest text-white/50">
        {label}
      </div>
    </div>
  );
}

/* ───────────────────────────── dashboard ───────────────────────────── */

interface DashboardProps {
  season: ReturnType<typeof useSeason>["season"];
  summary: ReturnType<typeof useSeason>["summary"];
  selectedYear: number;
  selectedRound: number | undefined;
  isLive: boolean;
  isLoading: boolean;
  onYearChange: (y: number) => void;
  onRaceClick: (round: number) => void;
  onClearSelection: () => void;
  onClose: () => void;
}

function Dashboard({
  season,
  summary,
  selectedYear,
  selectedRound,
  isLive,
  isLoading,
  onYearChange,
  onRaceClick,
  onClearSelection,
  onClose,
}: DashboardProps) {
  // Resolve which race the centre column shows. Selection takes priority;
  // otherwise we surface the next upcoming race. `nextRace` is undefined
  // when the schedule is still loading or the API returned nothing — the
  // centre column renders a placeholder in that case rather than crashing.
  const focusRace = useMemo(() => {
    if (selectedRound == null) return summary.nextRace;
    return (
      season.schedule.find((r) => r.round === selectedRound) ?? summary.nextRace
    );
  }, [selectedRound, season.schedule, summary.nextRace]);

  const isFocusCompleted =
    selectedRound != null &&
    summary.completed.some((r) => r.round === selectedRound);

  // Only fetch results for the focused race when it's actually completed.
  const resultsQuery = useRaceResults(
    season.year,
    isFocusCompleted ? selectedRound : undefined,
  );

  // Persistent on-disk cache of full RaceData blobs. Surfacing this in the
  // calendar lets users see which races will replay instantly vs need a
  // fresh 1–3 min build.
  const cachedRounds = useCachedRounds(season.year);

  return (
    <div className="flex min-h-screen flex-col px-6 py-6 md:px-8 md:py-8">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <span className="text-xs uppercase tracking-[0.5em] text-white/55">
            F1Overwatch
          </span>
          <SeasonRaceDropdown
            selectedYear={selectedYear}
            schedule={season.schedule}
            onYearChange={onYearChange}
            onRaceChange={onRaceClick}
          />
          {!isLive && !isLoading && (
            <span
              title="Live API unavailable — showing cached / stub data"
              className="rounded-full border border-yellow-500/40 bg-yellow-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-yellow-300"
            >
              Stub
            </span>
          )}
          {isLoading && (
            <span className="text-[10px] uppercase tracking-widest text-white/45">
              Loading…
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-10 w-10 place-items-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
          aria-label="Exit dashboard"
        >
          <svg viewBox="0 0 12 12" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M3 3 L 9 9 M 9 3 L 3 9" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <div className="mt-6 grid flex-1 grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)_400px]">
        <aside className="space-y-5">
          <SeasonStatsCard summary={summary} />
          <CollapsiblePanel
            title="Driver Standings"
            subtitle={season.drivers[0] ? `Leader · ${season.drivers[0].name}` : undefined}
          >
            <StandingsPanel mode="drivers" rows={season.drivers} />
          </CollapsiblePanel>
          <CollapsiblePanel
            title="Team Standings"
            subtitle={season.constructors[0] ? `Leader · ${season.constructors[0].team}` : undefined}
          >
            <StandingsPanel mode="constructors" rows={season.constructors} />
          </CollapsiblePanel>
        </aside>

        <section className="min-w-0 space-y-6">
          {selectedRound != null && isFocusCompleted && (
            // Back to the next-race view. Keeps the centre column predictable
            // even after the user has drilled into a past race.
            <button
              type="button"
              onClick={onClearSelection}
              className="inline-flex items-center gap-1 text-xs font-semibold uppercase tracking-widest text-white/55 transition-colors hover:text-white"
            >
              ← Back to next race
            </button>
          )}
          {focusRace ? (
            <>
              <HeroCountdown
                race={focusRace}
                mode={isFocusCompleted ? "completed" : "upcoming"}
                year={season.year}
              />
              <RaceDetailCard
                race={focusRace}
                results={isFocusCompleted ? resultsQuery.data : undefined}
                resultsLoading={isFocusCompleted && resultsQuery.isLoading}
              />
            </>
          ) : (
            <EmptyHero loading={isLoading} year={season.year} />
          )}
        </section>

        <aside className="min-w-0">
          <CalendarSection
            year={season.year}
            schedule={season.schedule}
            summary={summary}
            highlightRound={selectedRound}
            onSelectRace={onRaceClick}
            cachedRounds={cachedRounds}
          />
        </aside>
      </div>

      <footer className="mt-8 border-t border-white/10 pt-5 text-xs text-white/45">
        Formula 1, F1, FIA, and team names are trademarks of their respective
        owners. Standings + schedule via the Jolpi mirror of Ergast; replay
        routes use historical timing data via FastF1 / OpenF1.
      </footer>
    </div>
  );
}

function EmptyHero({ loading, year }: { loading: boolean; year: number }) {
  return (
    <section className="rounded-3xl border border-white/5 bg-carbon p-12 text-center">
      <div className="text-xs uppercase tracking-[0.4em] text-white/55">
        {loading ? "Loading season" : `No schedule for ${year}`}
      </div>
      <div className="mt-3 text-2xl font-bold text-white/80">
        {loading
          ? "Pulling standings and calendar…"
          : "Pick another season from the dropdown."}
      </div>
    </section>
  );
}
