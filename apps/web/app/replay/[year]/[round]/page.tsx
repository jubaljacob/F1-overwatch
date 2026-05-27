import { ReplayView } from "@/components/replay/ReplayView";

interface PageProps {
  params: Promise<{ year: string; round: string }>;
  searchParams: Promise<{ session?: string }>;
}

export default async function ReplayPage({ params, searchParams }: PageProps) {
  const { year, round } = await params;
  const { session } = await searchParams;
  const yearNum = Number(year);
  const roundNum = Number(round);

  if (!Number.isFinite(yearNum) || !Number.isFinite(roundNum)) {
    return <main className="p-12">Invalid year/round.</main>;
  }

  return <ReplayView year={yearNum} round={roundNum} sessionType={session ?? "R"} />;
}
