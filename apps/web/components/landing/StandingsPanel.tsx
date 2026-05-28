"use client";

import type {
  ConstructorStanding,
  DriverStanding,
} from "@/lib/season-data";
import { teamColors } from "@/lib/teams";

interface DriversProps {
  mode: "drivers";
  rows: DriverStanding[];
}

interface ConstructorsProps {
  mode: "constructors";
  rows: ConstructorStanding[];
}

type Props = DriversProps | ConstructorsProps;

/**
 * Unified standings panel — same layout shape, different row content.
 * Header hero block uses the leader's team color as a radial gradient.
 */
export function StandingsPanel(props: Props) {
  if (props.mode === "drivers") return <DriversPanel rows={props.rows} />;
  return <ConstructorsPanel rows={props.rows} />;
}

function DriversPanel({ rows }: { rows: DriverStanding[] }) {
  const leader = rows[0];
  const lc = leader ? teamColors(leader.team) : null;
  return (
    <div>
      <Header
        title="Driver Standings"
        topLine={leader?.name ?? ""}
        bottomLine={leader ? `${leader.points} PTS` : ""}
        meta={leader ? `${String(leader.position).padStart(2, "0")} Pos · ${leader.wins} Wins` : ""}
        accentColor={lc?.primary ?? "#15151e"}
      />
      <ul className="divide-y divide-white/5 px-1">
        {rows.map((r) => {
          const tc = teamColors(r.team);
          return (
            <li
              key={r.position}
              className="grid grid-cols-[40px_1fr_auto] items-center gap-4 px-4 py-4 transition-colors hover:bg-white/5"
            >
              <span className="text-lg font-bold text-white/65 tabular-nums">
                {String(r.position).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <div className="truncate text-lg font-bold text-white">
                  {r.name}
                </div>
                <div
                  className="text-sm font-semibold"
                  style={{ color: tc.primary }}
                >
                  {tc.name}
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-black text-white tabular-nums">
                  {r.points}
                </div>
                <div className="text-[10px] uppercase tracking-widest text-white/55">
                  PTS
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ConstructorsPanel({ rows }: { rows: ConstructorStanding[] }) {
  const leader = rows[0];
  const lc = leader ? teamColors(leader.team) : null;
  return (
    <div>
      <Header
        title="Team Standings"
        topLine={leader?.team ?? ""}
        bottomLine={leader ? `${leader.points} PTS` : ""}
        meta={leader?.chassis ?? ""}
        accentColor={lc?.primary ?? "#15151e"}
        secondary={lc?.secondary}
      />
      <ul className="divide-y divide-white/5 px-1">
        {rows.map((r) => {
          const tc = teamColors(r.team);
          return (
            <li
              key={r.position}
              className="grid grid-cols-[40px_1fr_auto] items-center gap-4 px-4 py-4 transition-colors hover:bg-white/5"
            >
              <span className="text-lg font-bold text-white/65 tabular-nums">
                {String(r.position).padStart(2, "0")}
              </span>
              <div className="min-w-0">
                <div className="truncate text-lg font-bold text-white">
                  {tc.name}
                </div>
                <div
                  className="text-sm font-semibold"
                  style={{ color: tc.primary }}
                >
                  {r.chassis}
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-black text-white tabular-nums">
                  {r.points}
                </div>
                <div className="text-[10px] uppercase tracking-widest text-white/55">
                  PTS
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Header({
  title,
  topLine,
  bottomLine,
  meta,
  accentColor,
  secondary,
}: {
  title: string;
  topLine: string;
  bottomLine: string;
  meta: string;
  accentColor: string;
  secondary?: string;
}) {
  return (
    <div
      className="relative overflow-hidden p-6"
      style={{
        background: `radial-gradient(circle at 80% 20%, ${accentColor}cc, transparent 65%), radial-gradient(circle at 20% 100%, ${
          secondary ?? accentColor
        }55, transparent 55%), #0a0a12`,
      }}
    >
      <div className="absolute inset-0 opacity-25 mix-blend-overlay"
        style={{
          backgroundImage:
            "radial-gradient(circle at 75% 30%, rgba(255,255,255,0.5), transparent 50%)",
        }}
      />
      <div className="relative space-y-1">
        <div className="text-xs uppercase tracking-[0.4em] text-white/70">
          {title}
        </div>
        <div className="text-3xl font-black tracking-tight text-white">
          {topLine}
        </div>
        {meta && (
          <div className="text-sm font-semibold text-white/80">{meta}</div>
        )}
        <div className="pt-2 text-4xl font-black tracking-tight text-white tabular-nums">
          {bottomLine}
        </div>
      </div>
    </div>
  );
}
