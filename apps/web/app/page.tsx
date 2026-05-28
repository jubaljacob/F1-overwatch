import { CIRCUITS, type CircuitEntry, groupByCategory } from "@/lib/circuits";
import Link from "next/link";

const CATEGORY_LABELS: Record<CircuitEntry["category"], string> = {
  standard: "Standard circuits",
  street: "Street circuits",
  elevation: "Elevation showcases",
  wet: "Wet races",
  sprint: "Sprint weekends",
  night: "Night races",
};

export default function HomePage() {
  const grouped = groupByCategory();
  const categories = Object.keys(grouped) as CircuitEntry["category"][];

  return (
    <main className="min-h-screen p-8 sm:p-12">
      <div className="mx-auto max-w-5xl space-y-10">
        <header className="space-y-2">
          <h1 className="text-4xl font-bold tracking-tight">TraceLine</h1>
          <p className="text-muted-foreground max-w-2xl">
            Web-based Formula 1 race replay and analytics — accurate leaderboard,
            tyre-strategy simulator, and a 3D track viewer with elevation. Pick a
            race below to open the replay.
          </p>
          <p className="text-muted-foreground text-xs">
            {CIRCUITS.length} curated races · jump back to{" "}
            <Link
              href="/replay/2024/13"
              className="underline underline-offset-2 hover:text-foreground"
            >
              the default (Hungary 2024)
            </Link>{" "}
            anytime
          </p>
        </header>

        {categories
          .filter((cat) => grouped[cat].length > 0)
          .map((cat) => (
            <section key={cat} className="space-y-3">
              <h2 className="text-muted-foreground text-xs uppercase tracking-widest">
                {CATEGORY_LABELS[cat]}
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {grouped[cat].map((c) => (
                  <CircuitCard key={c.id} circuit={c} />
                ))}
              </div>
            </section>
          ))}

        <footer className="text-muted-foreground border-t border-foreground/10 pt-6 text-xs">
          Cold FastF1 / OpenF1 fetches take 1–3 min on first load per circuit;
          subsequent loads are instant. See{" "}
          <code className="font-mono">PROJECT_PLAN.md</code> for the roadmap.
        </footer>
      </div>
    </main>
  );
}

function CircuitCard({ circuit }: { circuit: CircuitEntry }) {
  return (
    <Link
      href={`/replay/${circuit.year}/${circuit.round}`}
      className="group block rounded-lg border border-foreground/10 bg-muted/30 p-4 transition-colors hover:border-foreground/30 hover:bg-muted/50"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{circuit.name}</span>
        <span className="text-muted-foreground text-[10px] tabular-nums">
          {circuit.year} · R{circuit.round}
        </span>
      </div>
      <div className="text-muted-foreground mt-1 text-xs">{circuit.country}</div>
      <p className="mt-3 text-xs text-foreground/70 group-hover:text-foreground/90">
        {circuit.tag}
      </p>
    </Link>
  );
}
