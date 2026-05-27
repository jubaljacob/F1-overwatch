import type { RaceData, SampleLap, SessionMeta } from "@traceline/shared-types";

// 127.0.0.1 rather than localhost — on Windows + Node 18+, undici resolves
// `localhost` to IPv6 ::1 by default, but uvicorn binds to IPv4 127.0.0.1.
const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:8000";

async function request<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) {
    // FastAPI puts the real cause in `.detail`. Surface it so the UI error
    // and the browser console aren't useless.
    let detail = "";
    try {
      const body = (await res.json()) as { detail?: string };
      detail = body.detail ? ` — ${body.detail}` : "";
    } catch {
      // non-JSON body; ignore
    }
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText}${detail}`);
  }
  return (await res.json()) as T;
}

export function getSession(year: number, round: number, sessionType = "R") {
  return request<SessionMeta>(`/sessions/${year}/${round}?session_type=${sessionType}`);
}

export function getSampleLap(year: number, round: number, driver: string, sessionType = "R") {
  return request<SampleLap>(
    `/sessions/${year}/${round}/sample-lap?driver=${encodeURIComponent(driver)}&session_type=${sessionType}`,
  );
}

export function getRaceData(year: number, round: number, sessionType = "R") {
  // Backend warm-build can take 1-3 minutes on a cold FastF1 cache. Disable
  // the default fetch timeout / revalidate cache by handing the call to
  // React Query on the client; Next's request cache here would block render.
  return request<RaceData>(`/sessions/${year}/${round}/race-data?session_type=${sessionType}`);
}
