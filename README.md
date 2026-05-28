# TraceLine

Web-based Formula 1 race replay and analytics platform. Loads historical F1 telemetry (via FastF1 or the OpenF1 HTTP fallback), processes it server-side, and renders the race as an interactive replay in a Next.js frontend with a leaderboard, delta-time charts, tyre-strategy simulator, and ML-driven insights.

It is a from-scratch successor to and improvement on `IAmTomShaw/f1-race-replay` (Python/Arcade desktop app), addressing that project's known limitations:

- Desktop-only Python tool → shareable web app
- Inaccurate leaderboard during pit cycles and race start/end → proper lap-distance normalisation
- No comparative analysis → delta-time and gap charts
- No predictive layer → tyre-degradation model + strategy simulator
- No live streaming API → WebSocket telemetry stream
- Flat track rendering → elevation, sector heatmaps, racing lines
- Poor street-circuit accuracy → per-circuit correction layer

## Quick start

Prerequisites: Node 20+, pnpm 9+, Python 3.11+, [uv](https://github.com/astral-sh/uv), Docker.

```powershell
# 1. Install deps
pnpm install
cd apps/api; uv sync; cd ../..

# 2. Copy env file and fill in Supabase creds (optional for v0)
copy .env.example .env.local

# 3. Start Postgres + Redis
docker compose up -d

# 4. Start backend (terminal 1)
cd apps/api
uv run uvicorn traceline.main:app --reload --port 8000

# 5. Start frontend (terminal 2)
pnpm dev
```

Open <http://localhost:3000>. The home page fetches a real lap time from FastF1 via the backend.

## Tech stack

**Frontend:** Next.js 15 (App Router) · TypeScript · React 19 · Tailwind v4 · shadcn/ui · Zustand (replay state) · TanStack Query (server state) · Canvas 2D + three.js/react-three-fiber for the track renderer · Recharts for analytics panels

**Backend:** Python 3.11+ · FastAPI · FastF1 · OpenF1 HTTP fallback · NumPy / Pandas / SciPy · Pydantic v2 · WebSockets (native FastAPI) · Redis for cache layer

**Data:** Postgres (via Supabase) for users, saved replays, and annotations · S3-compatible object store for pre-computed telemetry JSON · Redis for live session cache

**Deploy:** Vercel (frontend) · Fly.io or Railway (FastAPI backend) · Supabase managed (Postgres + Auth)

**Tooling:** pnpm · uv (Python) · Ruff · Biome · Vitest · Pytest · Docker Compose for local dev

## Repo layout

```
traceline/
├── apps/
│   ├── web/                       Next.js 15 app (frontend)
│   │   ├── app/                   App Router routes
│   │   ├── components/
│   │   │   ├── replay/            Track canvas, leaderboard, controls
│   │   │   ├── analytics/         Delta chart, tyre sim, sector heatmap
│   │   │   └── ui/                shadcn primitives
│   │   └── lib/
│   │       ├── replay-engine/     Frame interpolation, playback clock
│   │       ├── track-renderer/    Canvas drawing, projection, line styling
│   │       └── stores/            Zustand stores
│   └── api/                       FastAPI backend
│       └── traceline/
│           ├── routes/            /sessions, /telemetry, /ws
│           ├── services/          fastf1_loader, openf1_loader, lap_distance,
│           │                      tyre_model, strategy_sim
│           └── schemas/           Pydantic models (shared with frontend codegen)
├── packages/
│   ├── shared-types/              TS types generated from Pydantic schemas
│   └── track-data/                Static circuit centrelines, elevation, sectors
├── supabase/                      Database migrations
└── docker-compose.yml             Postgres, Redis for local dev
```

## Core data model

A `Session` (year + round + session_type) resolves to a `RaceData` object:

```ts
type RaceData = {
  meta: { year, round, circuit, sessionType, totalLaps }
  drivers: Driver[]              // number, code, team, colour
  frames: Frame[]                // ~10Hz, the playback timeline
  laps: LapRecord[]              // per driver per lap: sectors, compound, pit
  circuit: CircuitGeometry       // centreline, sectors, DRS zones, elevation
}

type Frame = {
  t: number                      // session time in seconds
  positions: {
    [driverNum]: {
      x, y, z?                   // raw coords
      lapDistance: number        // 0..trackLength (CRITICAL — drives leaderboard)
      lap: number
      speed, gear, throttle, brake, drs
      status: 'on_track' | 'pit' | 'out'
    }
  }
}
```

**Leaderboard order is computed from `lap * trackLength + lapDistance`**, never from raw X/Y. This is the single most important architectural decision in the project — see [Lap-distance normalisation](#lap-distance-normalisation) below.

## Build phases

Work proceeds in phases:

- **P0 — Foundations:** monorepo, FastAPI scaffold, Next.js scaffold, FastF1 session loader, JSON telemetry endpoint, Postgres via Supabase, basic auth.
- **P1 — Replay MVP:** Canvas track renderer, playback engine, leaderboard, basic controls. One race end-to-end.
- **P2 — Accurate leaderboard:** lap-distance normalisation, pit-cycle handling, end-of-race resolution.
- **P3 — Comparative analytics:** driver selection, delta-time chart, sector breakdown, gap chart over race.
- **P4 — Tyre & strategy layer:** degradation model from historical data, "what-if" strategy simulator, optimal pit-window estimator.
- **P5 — Live telemetry stream:** WebSocket endpoint, frame interpolator on client, reconnect logic.
- **P6 — Track quality:** elevation rendering, sector-speed heatmap, racing-line overlay per driver, street-circuit correction layer.
- **P7 — Social / sharing:** saved replays, annotations, shareable timestamped URLs.

## Engineering notes

### Lap-distance normalisation
Each circuit has a centreline polyline. For every telemetry sample at `(x, y)`, project onto the nearest centreline segment to get a scalar `lapDistance ∈ [0, trackLength)`. Combined with the lap counter, this gives a strictly monotonic race-progress scalar that the leaderboard sorts on. Pit-lane samples are flagged separately and excluded from the on-track distance accumulator until the car rejoins. FastF1's lap and pit-in/out times are cross-referenced — position alone is not trusted.

### Frame rate and storage
Source telemetry is ~3–10 Hz per car and irregular. We resample server-side to a uniform 10 Hz timeline (linear interpolation for continuous fields, last-known for categorical fields like compound/DRS). One race ≈ 20 drivers × ~6500 frames × ~50 bytes ≈ 6.5 MB raw, ~1.5 MB gzipped. Cache aggressively in Redis and serve as immutable static JSON from object storage where possible.

### Pre-computation vs on-demand
The first request for a session triggers full pre-computation (1–3 min for a race weekend with a cold cache). Subsequent requests are served from the precomputed blob. The frontend renders a loading state and skeleton data while the backend computes. FastF1 is never called from a synchronous request hot path.

### Tyre model
Degradation is per-compound-per-circuit-per-stint. The current baseline is a linear model — `lap_time_delta = a + b · tyre_age + c · fuel_load` per compound, with per-driver intercepts — learned from historical data for the same circuit. Validated on Hungary 2024 to ±15 s for 4/5 top finishers. Learned models (RL, GP regression) come after the linear baseline proves out.

### Street circuits
Monaco, Singapore, Baku, Jeddah, and Las Vegas have noisy GPS. A per-circuit `corrections.json` carries manually-tuned smoothing parameters and known-bad segment ranges. There is no global GPS smoothing algorithm.

### Data-source fallback
FastF1 is the default upstream. When F1's CloudFront IP filter blocks FastF1 (the state as of mid-2026), set `DATA_SOURCE=openf1` and the backend uses the OpenF1 HTTP API instead. Both loaders produce the same `RaceData` shape. In development, OpenF1 responses are cached per-request on disk to survive rate limits and resume across failed builds.

## Conventions

- **Commits:** Conventional Commits (`feat:`, `fix:`, `chore:`, `refactor:`).
- **Branching:** trunk-based; short-lived feature branches; PRs squash-merged.
- **TypeScript:** strict mode on, no `any`, prefer `unknown` + narrowing.
- **Python:** Ruff format + lint, type hints required, Pydantic for all I/O boundaries.
- **Tests:** every service in `apps/api/services/` has unit tests; the replay engine has deterministic tests with fixture telemetry; UI components are covered by Vitest + Testing Library smoke tests.
- **No telemetry data in git** — fixtures live in `apps/api/tests/fixtures/` as small synthetic samples, never real session dumps. The `.fastf1-cache/`, `.openf1-cache/`, and `.racedata-cache/` directories are gitignored.

## Disclaimer

Formula 1, F1, FIA, and team names are trademarks of their respective owners. TraceLine uses publicly available timing data via FastF1 and OpenF1 for educational and non-commercial analysis. Not affiliated with or endorsed by Formula 1.
