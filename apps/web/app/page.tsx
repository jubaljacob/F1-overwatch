import { LandingShell } from "@/components/landing/LandingShell";

export default function HomePage() {
  // Server-side reference date keeps the first paint deterministic. Client
  // components re-derive countdowns/now from this baseline.
  const today = new Date();
  return <LandingShell today={today} />;
}
