"use client";

import { CIRCUITS, type CircuitEntry } from "@/lib/circuits";
import { useRouter } from "next/navigation";

interface Props {
  /** Currently-loaded circuit, so the picker can mark it active. */
  current?: { year: number; round: number };
  /** Visual variant — compact dropdown in the replay header, full select
   *  on the landing page. */
  variant?: "compact" | "full";
}

/** Dropdown that navigates to /replay/{year}/{round} on change. Used in
 *  the replay header for quick-switching between circuits. */
export function CircuitPicker({ current, variant = "compact" }: Props) {
  const router = useRouter();
  const currentId = current
    ? CIRCUITS.find((c) => c.year === current.year && c.round === current.round)?.id ?? ""
    : "";

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    const entry = CIRCUITS.find((c) => c.id === id);
    if (entry) router.push(`/replay/${entry.year}/${entry.round}`);
  };

  const baseClasses =
    "rounded border border-foreground/20 bg-background/80 text-foreground transition-colors hover:border-foreground/40 focus:border-amber-400 focus:outline-none";
  const sizeClasses =
    variant === "compact" ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm";

  return (
    <select
      value={currentId}
      onChange={onChange}
      className={`${baseClasses} ${sizeClasses}`}
      aria-label="Switch circuit"
    >
      {!currentId && (
        <option value="" disabled>
          Pick a circuit…
        </option>
      )}
      {CIRCUITS.map((c) => (
        <option key={c.id} value={c.id}>
          {labelFor(c)}
        </option>
      ))}
    </select>
  );
}

function labelFor(c: CircuitEntry): string {
  return `${c.year} · ${c.name}`;
}
