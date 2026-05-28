/**
 * 2026 F1 team color map.
 *
 * `primary` is the team's signature color — used for accent borders, name
 * underlines, and the radial gradient behind the standings hero. `secondary`
 * is the supporting brand color for chips and small highlights. Values are
 * public-reference hex codes (no copyrighted assets).
 */

export interface TeamColors {
  primary: string;
  secondary: string;
  /** Display name shown in the UI. */
  name: string;
}

export const TEAM_COLORS: Record<string, TeamColors> = {
  Ferrari: { name: "Ferrari", primary: "#EF1A2D", secondary: "#FFF200" },
  McLaren: { name: "McLaren", primary: "#FF8000", secondary: "#000000" },
  Mercedes: { name: "Mercedes", primary: "#00A19B", secondary: "#C8CCCE" },
  "Red Bull": { name: "Red Bull", primary: "#003087", secondary: "#FF1801" },
  "Aston Martin": { name: "Aston Martin", primary: "#006B4F", secondary: "#C8FF00" },
  Alpine: { name: "Alpine", primary: "#00A1E8", secondary: "#F282B4" },
  Haas: { name: "Haas", primary: "#E6002B", secondary: "#000000" },
  Audi: { name: "Audi", primary: "#C8102E", secondary: "#C0C0C0" },
  Williams: { name: "Williams", primary: "#1868DB", secondary: "#FFFFFF" },
  "Racing Bulls": { name: "Racing Bulls", primary: "#3671C6", secondary: "#FFFFFF" },
  Cadillac: { name: "Cadillac", primary: "#1A1A1A", secondary: "#E6002B" },
};

const FALLBACK: TeamColors = { name: "Independent", primary: "#888888", secondary: "#444444" };

export function teamColors(team: string): TeamColors {
  return TEAM_COLORS[team] ?? FALLBACK;
}
