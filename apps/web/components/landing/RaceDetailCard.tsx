"use client";

import type { RaceResultsPayload } from "@traceline/shared-types";
import type { RaceRecord } from "@/lib/season-data";
import { teamColors } from "@/lib/teams";

interface Props {
  race: RaceRecord;
  /** Live results payload for the race. When provided, the records section
   *  is replaced with the top-3 finishers ("latest winners"). */
  results?: RaceResultsPayload;
  /** Shown while `results` is still loading so the layout doesn't shift. */
  resultsLoading?: boolean;
}

/**
 * Race-detail card. 2×2 grid of stat tiles, then either historical
 * records (default) or the live top-3 finishers (when this race has
 * been completed and the user has clicked it in the calendar).
 */
export function RaceDetailCard({ race, results, resultsLoading }: Props) {
  const raceDistanceKm = race.laps * race.lengthKm;
  // `results` may exist but be empty (e.g. race hasn't run yet upstream).
  const hasResults = results != null && results.results.length > 0;

  return (
    <section className="space-y-5">
      <div className="flex items-baseline gap-3">
        <span className="text-xl font-bold text-white/60 tabular-nums">
          R{race.round}
        </span>
        <h3 className="text-3xl font-black tracking-tight text-white">
          {race.name}
        </h3>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatTile big={String(race.laps)} label="No. of laps" />
        <StatTile big={`${raceDistanceKm.toFixed(1)} KM`} label="Race Distance" />
        <StatTile big={String(race.turns)} label="No. of Turns" />
        <StatTile big={`${race.elevationM.toFixed(2)} M`} label="Elevation" />
      </div>

      {hasResults ? (
        <TopFinishers results={results} />
      ) : results != null && resultsLoading ? (
        <SkeletonFinishers />
      ) : (
        <HistoricalRecords race={race} />
      )}
    </section>
  );
}

function StatTile({ big, label }: { big: string; label: string }) {
  return (
    <div className="rounded-2xl bg-off-white px-5 py-4">
      <div className="text-3xl font-black tracking-tight text-carbon tabular-nums">
        {big}
      </div>
      <div className="text-xs font-semibold text-carbon/70">{label}</div>
    </div>
  );
}

function HistoricalRecords({ race }: { race: RaceRecord }) {
  return (
    <div className="space-y-5">
      <RecordRow
        label="Most Successful Constructor"
        big={`${String(race.topConstructor.wins).padStart(2, "0")} WINS`}
        subtitle={race.topConstructor.name}
      />
      <RecordRow
        label="Most Successful Drivers"
        big={`${String(race.topDriver.wins).padStart(2, "0")} WINS`}
        subtitle={race.topDriver.name}
      />
      <RecordRow
        label="Race Lap Record"
        big={race.lapRecord.time}
        subtitle={`${race.lapRecord.driver} • ${race.lapRecord.year}`}
      />
    </div>
  );
}

function TopFinishers({ results }: { results: RaceResultsPayload }) {
  const top3 = results.results.slice(0, 3);
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-[0.4em] text-white/55">
        Latest Winners
      </div>
      <ul className="space-y-2">
        {top3.map((r) => {
          const tc = teamColors(r.team);
          return (
            <li
              key={r.position}
              className="grid grid-cols-[48px_1fr_auto] items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3"
              style={{ borderLeftColor: tc.primary, borderLeftWidth: 4 }}
            >
              <div
                className="grid h-10 w-10 place-items-center rounded-full text-base font-black tabular-nums"
                style={{
                  background: tc.primary,
                  color: r.position === 1 ? "#ffffff" : "#ffffff",
                }}
              >
                {r.position}
              </div>
              <div className="min-w-0">
                <div className="truncate text-lg font-bold text-white">{r.name}</div>
                <div
                  className="text-sm font-semibold"
                  style={{ color: tc.primary }}
                >
                  {tc.name}
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-black text-white tabular-nums">
                  {r.time}
                </div>
                <div className="text-[10px] uppercase tracking-widest text-white/55">
                  {r.points.toFixed(0)} PTS
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SkeletonFinishers() {
  return (
    <div className="space-y-3">
      <div className="text-xs font-semibold uppercase tracking-[0.4em] text-white/55">
        Latest Winners
      </div>
      <ul className="space-y-2">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="grid grid-cols-[48px_1fr_auto] items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3"
          >
            <div className="h-10 w-10 animate-pulse rounded-full bg-white/10" />
            <div className="space-y-2">
              <div className="h-4 w-3/5 animate-pulse rounded bg-white/10" />
              <div className="h-3 w-1/4 animate-pulse rounded bg-white/10" />
            </div>
            <div className="h-4 w-16 animate-pulse rounded bg-white/10" />
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecordRow({
  label,
  big,
  subtitle,
}: {
  label: string;
  big: string;
  subtitle: string;
}) {
  return (
    <div className="space-y-1 border-b border-white/10 pb-5">
      <div className="text-xs font-semibold text-white/55">{label}</div>
      <div className="text-4xl font-black tracking-tight text-white tabular-nums">
        {big}
      </div>
      <div className="text-sm text-white/75">{subtitle}</div>
    </div>
  );
}
