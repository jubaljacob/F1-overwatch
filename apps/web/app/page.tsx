import { getSampleLap } from "@/lib/api";
import { formatLapTime } from "@/lib/utils";
import Link from "next/link";

// P0 smoke page: fetch one real lap time from FastF1 via the backend.
// 2024 Round 13 = Hungarian GP, the target race per PROJECT_PLAN §5
// (the plan calls it Round 12 by mistake — R12 is Britain on the official calendar).
const DEFAULT = { year: 2024, round: 13, driver: "VER" } as const;

export const revalidate = 300;

export default async function HomePage() {
  let body: React.ReactNode;
  try {
    const lap = await getSampleLap(DEFAULT.year, DEFAULT.round, DEFAULT.driver);
    body = (
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm uppercase tracking-widest">
          {DEFAULT.year} · Round {DEFAULT.round} · {DEFAULT.driver}
        </p>
        <p className="text-6xl font-bold tabular-nums">{formatLapTime(lap.lap_time_seconds)}</p>
        <p className="text-muted-foreground text-sm">
          Fastest lap · Lap {lap.lap_number}
          {lap.compound ? ` · ${lap.compound}` : ""}
        </p>
      </div>
    );
  } catch (err) {
    body = (
      <div className="space-y-2">
        <p className="text-accent text-sm uppercase tracking-widest">Backend offline</p>
        <p className="text-foreground/70">
          Start the API: <code className="font-mono">uv run uvicorn traceline.main:app</code>
        </p>
        <p className="text-muted-foreground text-xs">{(err as Error).message}</p>
      </div>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-12">
      <div className="max-w-2xl space-y-8">
        <header>
          <h1 className="text-4xl font-bold tracking-tight">TraceLine</h1>
          <p className="text-muted-foreground mt-2">
            Web-based Formula 1 race replay and analytics platform.
          </p>
        </header>
        <section className="rounded-lg border border-foreground/10 bg-muted p-8">{body}</section>
        <Link
          href={`/replay/${DEFAULT.year}/${DEFAULT.round}`}
          className="inline-block rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90"
        >
          Open replay → {DEFAULT.year} R{DEFAULT.round}
        </Link>
        <footer className="text-muted-foreground text-xs">
          P1 scaffold · See <code className="font-mono">PROJECT_PLAN.md</code> for the roadmap.
        </footer>
      </div>
    </main>
  );
}
