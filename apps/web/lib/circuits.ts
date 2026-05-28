/** Curated list of demo-worthy circuits.
 *
 *  Each entry is one race the user can jump straight into from the landing
 *  page or the in-replay switcher. Picked to span the diversity our
 *  validation harnesses already use (standard / wet / safety car / sprint /
 *  street) plus a few visual standouts (Spa for elevation, Singapore for
 *  the night-race look, Vegas for the modern street layout).
 *
 *  Calendar reshuffles between seasons, so we pin (year, round) explicitly
 *  rather than relying on round numbers staying stable.
 */

export interface CircuitEntry {
  /** Unique key for React. */
  id: string;
  year: number;
  round: number;
  /** Race name as it'll appear in the picker. */
  name: string;
  /** Country / venue, shown as secondary text. */
  country: string;
  /** One-liner — pick a feature that makes this entry interesting. */
  tag: string;
  /** Loose grouping for the landing-page grid. */
  category: "standard" | "street" | "wet" | "sprint" | "elevation" | "night";
}

export const CIRCUITS: readonly CircuitEntry[] = [
  {
    id: "2024-r13-hungary",
    year: 2024,
    round: 13,
    name: "Hungarian GP",
    country: "Hungary",
    tag: "Standard dry — the P2/P4 validation target",
    category: "standard",
  },
  {
    id: "2024-r14-belgium",
    year: 2024,
    round: 14,
    name: "Belgian GP",
    country: "Spa-Francorchamps",
    tag: "High-speed permanent · dramatic elevation at Eau Rouge",
    category: "elevation",
  },
  {
    id: "2024-r8-monaco",
    year: 2024,
    round: 8,
    name: "Monaco GP",
    country: "Monte Carlo",
    tag: "Street circuit · noisy GPS, P6 correction layer territory",
    category: "street",
  },
  {
    id: "2024-r3-australia",
    year: 2024,
    round: 3,
    name: "Australian GP",
    country: "Melbourne",
    tag: "Safety-car race · good test of pit-cycle handling",
    category: "standard",
  },
  {
    id: "2023-r14-netherlands",
    year: 2023,
    round: 14,
    name: "Dutch GP",
    country: "Zandvoort",
    tag: "Wet race · pace-vs-strategy puzzle",
    category: "wet",
  },
  {
    id: "2023-r4-azerbaijan",
    year: 2023,
    round: 4,
    name: "Azerbaijan GP",
    country: "Baku",
    tag: "Sprint weekend on a street circuit",
    category: "sprint",
  },
  {
    id: "2024-r12-britain",
    year: 2024,
    round: 12,
    name: "British GP",
    country: "Silverstone",
    tag: "Fast flowing permanent · classic high-speed test",
    category: "standard",
  },
  {
    id: "2024-r16-italy",
    year: 2024,
    round: 16,
    name: "Italian GP",
    country: "Monza",
    tag: "Temple of speed · long straights, low downforce",
    category: "standard",
  },
  {
    id: "2024-r18-singapore",
    year: 2024,
    round: 18,
    name: "Singapore GP",
    country: "Marina Bay",
    tag: "Night race · longest, hottest, most physical",
    category: "night",
  },
  {
    id: "2024-r22-saopaulo",
    year: 2024,
    round: 22,
    name: "São Paulo GP",
    country: "Interlagos",
    tag: "Sprint + chaotic wet conditions",
    category: "sprint",
  },
  {
    id: "2024-r23-lasvegas",
    year: 2024,
    round: 23,
    name: "Las Vegas GP",
    country: "Las Vegas Strip",
    tag: "Night street circuit · modern layout",
    category: "night",
  },
  {
    id: "2024-r6-emiliaromagna",
    year: 2024,
    round: 6,
    name: "Emilia-Romagna GP",
    country: "Imola",
    tag: "Old-school flowing permanent · narrow with elevation",
    category: "elevation",
  },
];

/** Group entries by category for the landing-page grid. */
export function groupByCategory(): Record<CircuitEntry["category"], CircuitEntry[]> {
  const out: Record<CircuitEntry["category"], CircuitEntry[]> = {
    standard: [],
    street: [],
    wet: [],
    sprint: [],
    elevation: [],
    night: [],
  };
  for (const c of CIRCUITS) out[c.category].push(c);
  return out;
}

export function findCircuit(year: number, round: number): CircuitEntry | undefined {
  return CIRCUITS.find((c) => c.year === year && c.round === round);
}
