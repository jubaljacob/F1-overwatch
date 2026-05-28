# TraceLine

Web-based Formula 1 race replay and analytics platform. Loads historical F1 telemetry via FastF1, serves it from a FastAPI backend, and renders the race as an interactive replay in a Next.js frontend.

See [`CLAUDE.md`](./CLAUDE.md) for architecture and [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) for the full roadmap.

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

## Repo layout

```
apps/web        Next.js 15 frontend
apps/api        FastAPI backend + FastF1 loader
packages/       Shared TS types and static track data
supabase/       Database migrations
```

## Disclaimer

Formula 1, F1, FIA, and team names are trademarks of their respective owners. TraceLine uses publicly available timing data via FastF1 for educational and non-commercial analysis. Not affiliated with or endorsed by Formula 1.
