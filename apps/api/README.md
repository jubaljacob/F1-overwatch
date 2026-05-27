# TraceLine API

FastAPI backend powering the TraceLine replay platform.

```powershell
uv sync
uv run uvicorn traceline.main:app --reload --port 8000
```

Endpoints (P0):

- `GET /healthz` — liveness
- `GET /sessions/{year}/{round}` — session metadata (year, round, circuit, drivers, total laps)
- `GET /sessions/{year}/{round}/sample-lap?driver={code}` — one driver's fastest lap time (P0 smoke endpoint)
