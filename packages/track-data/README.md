# @traceline/track-data

Calibrated track geometry for each circuit:

- Centreline polyline: `[x, y, cumulativeDistance][]`
- Sector boundaries
- DRS zones
- Elevation samples (P6)
- Per-circuit correction overrides for street tracks

These are **calibrated artefacts** — see `CLAUDE.md` §8. Do not edit centrelines by hand; regenerate via the calibration tool (built in P2).

Populated in P2.
