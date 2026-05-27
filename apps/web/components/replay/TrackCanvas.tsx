"use client";

import { usePlaybackStore } from "@/lib/replay-engine/playback-store";
import { type Projection, makeProjection } from "@/lib/track-renderer/projection";
import type { DriverInfo, Frame, LapRecord, RaceData } from "@traceline/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  raceData: RaceData;
  frame: Frame | null;
}

const DOT_RADIUS = 5;
const FOCUS_HALO_RADIUS = 11;
const TRACK_LINE_WIDTH = 2;
const TRACK_COLOUR = "rgba(255,255,255,0.18)";
const START_LINE_COLOUR = "rgba(255,255,255,0.85)";
const FALLBACK_DRIVER_COLOUR = "#888";

export function TrackCanvas({ raceData, frame }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selected = usePlaybackStore((s) => s.selectedDrivers);
  const reference = usePlaybackStore((s) => s.referenceDriver);
  const toggleSelected = usePlaybackStore((s) => s.toggleSelectedDriver);
  const clearSelection = usePlaybackStore((s) => s.clearSelection);
  const effectiveReference = reference ?? selected[0] ?? null;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const [showSectorColouring, setShowSectorColouring] = useState(false);

  // Compute "fastest selected driver per sector" for the lap the reference
  // driver is currently on. Returns null when overlay is off, <2 selected,
  // or no sector data for that lap. v1 splits the centreline into three
  // equal arc-length thirds; P6 should swap in true sector boundaries from
  // FastF1's CircuitInfo or per-circuit calibration.
  const sectorOverlay = useMemo(() => {
    if (!showSectorColouring) return null;
    if (selected.length < 2) return null;
    const currentLap = frame ? frame.p[effectiveReference ?? -1]?.lap : null;
    if (currentLap == null) return null;
    return computeSectorOverlay(raceData, selected, currentLap);
  }, [showSectorColouring, selected, effectiveReference, frame, raceData]);

  const driverLookup = useRef<Map<number, DriverInfo>>(new Map());
  useEffect(() => {
    driverLookup.current = new Map(raceData.drivers.map((d) => [d.number, d]));
  }, [raceData]);

  // Last-rendered projection + frame snapshot let click handler do hit-testing
  // without recomputing the projection on every pointer event.
  const lastProj = useRef<Projection | null>(null);
  const lastFrame = useRef<Frame | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = Math.max(1, Math.floor(cssW * dpr));
        canvas.height = Math.max(1, Math.floor(cssH * dpr));
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const proj = makeProjection(raceData.circuit, {
        width: cssW,
        height: cssH,
        padding: 24,
      });
      lastProj.current = proj;
      lastFrame.current = frame;

      drawCentreline(ctx, raceData, proj, sectorOverlay);
      drawStartLine(ctx, raceData, proj);
      if (frame)
        drawDrivers(ctx, frame, proj, driverLookup.current, selectedSet, effectiveReference);
    };

    draw();

    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [raceData, frame, selectedSet, effectiveReference, sectorOverlay]);

  function handleClick(ev: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const proj = lastProj.current;
    const f = lastFrame.current;
    if (!canvas || !proj || !f) return;
    const rect = canvas.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const hitR = DOT_RADIUS + 6;
    let best: { num: number; d2: number } | null = null;
    for (const [numStr, sample] of Object.entries(f.p)) {
      if (sample.st === "out") continue;
      const [sx, sy] = proj.toScreen(sample.x, sample.y);
      const d2 = (sx - cx) ** 2 + (sy - cy) ** 2;
      if (d2 <= hitR * hitR && (!best || d2 < best.d2)) {
        best = { num: Number(numStr), d2 };
      }
    }
    if (best) toggleSelected(best.num);
    else if (selected.length > 0) clearSelection(); // click empty space → clear
  }

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        onClick={handleClick}
        onKeyDown={(e) => {
          if (e.key === "Escape" && selected.length > 0) clearSelection();
        }}
        tabIndex={-1}
        className="h-full w-full cursor-pointer"
        aria-label="Race track"
      />
      {selected.length >= 2 && (
        <button
          type="button"
          onClick={() => setShowSectorColouring((v) => !v)}
          className={`absolute right-3 top-3 rounded border px-2 py-1 text-[10px] uppercase tracking-widest transition-colors ${
            showSectorColouring
              ? "border-amber-400/60 bg-amber-400/15 text-amber-200"
              : "border-foreground/20 bg-background/70 text-foreground/70 hover:bg-foreground/10"
          }`}
          title="Colour each sector by the fastest selected driver in that sector this lap"
        >
          {showSectorColouring ? "Sector colours: on" : "Sector colours: off"}
        </button>
      )}
    </div>
  );
}

interface SectorOverlay {
  /** Colour per sector (S1, S2, S3) — null if no winner for that sector. */
  colours: [string | null, string | null, string | null];
  /** Cumulative-distance boundaries (s1End, s2End) splitting the closed
   *  centreline into three sectors. v1 = equal thirds. */
  bounds: [number, number];
}

function drawCentreline(
  ctx: CanvasRenderingContext2D,
  data: RaceData,
  proj: Projection,
  overlay: SectorOverlay | null,
) {
  const pts = data.circuit.centreline;
  const cum = data.circuit.cumulative_distance;
  if (pts.length < 2) return;

  if (!overlay) {
    // Single-stroke baseline path.
    ctx.beginPath();
    const first = pts[0] as [number, number];
    const [x0, y0] = proj.toScreen(first[0], first[1]);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const pt = pts[i] as [number, number];
      const [x, y] = proj.toScreen(pt[0], pt[1]);
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = TRACK_COLOUR;
    ctx.lineWidth = TRACK_LINE_WIDTH;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke();
    return;
  }

  // Sector-coloured pass: draw one stroke per vertex pair, picking the
  // colour from whichever sector that segment's midpoint sits in. Slightly
  // thicker line so the colours read at a glance.
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = TRACK_LINE_WIDTH + 1.5;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i] as [number, number];
    const b = pts[i + 1] as [number, number];
    const midDist = ((cum[i] ?? 0) + (cum[i + 1] ?? 0)) / 2;
    const sectorIdx = midDist < overlay.bounds[0] ? 0 : midDist < overlay.bounds[1] ? 1 : 2;
    const colour = overlay.colours[sectorIdx] ?? TRACK_COLOUR;
    const [ax, ay] = proj.toScreen(a[0], a[1]);
    const [bx, by] = proj.toScreen(b[0], b[1]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.strokeStyle = colour;
    ctx.stroke();
  }
}

/** Resolve which selected driver was fastest in each sector for the given
 *  lap, and produce a SectorOverlay with their team colours and the v1
 *  equal-third sector boundaries on the centreline. */
function computeSectorOverlay(
  raceData: RaceData,
  selected: readonly number[],
  lap: number,
): SectorOverlay | null {
  const driverByNum = new Map(raceData.drivers.map((d) => [d.number, d]));
  const lapRecords: LapRecord[] = [];
  for (const lr of raceData.laps) {
    if (lr.lap === lap && selected.includes(lr.driver)) lapRecords.push(lr);
  }
  if (lapRecords.length === 0) return null;

  const pick = (sector: 1 | 2 | 3): string | null => {
    let best: { num: number; t: number } | null = null;
    for (const lr of lapRecords) {
      const t =
        sector === 1 ? lr.sector_1_s : sector === 2 ? lr.sector_2_s : lr.sector_3_s;
      if (t == null || t <= 0) continue;
      if (!best || t < best.t) best = { num: lr.driver, t };
    }
    if (!best) return null;
    const info = driverByNum.get(best.num);
    return info?.team_colour ? `#${info.team_colour}` : FALLBACK_DRIVER_COLOUR;
  };

  const trackLen =
    raceData.circuit.track_length_m ||
    raceData.circuit.cumulative_distance[raceData.circuit.cumulative_distance.length - 1] ||
    0;
  // v1 equal-thirds. Real sector boundaries land here in P6.
  const bounds: [number, number] = [trackLen / 3, (2 * trackLen) / 3];

  return { colours: [pick(1), pick(2), pick(3)], bounds };
}

/** Draw a perpendicular tick at the start of the centreline polyline.
 *  FastF1's fastest-lap trail starts at the start/finish line, so this is
 *  visually close enough for P1; P2 will replace with a calibrated marker. */
function drawStartLine(ctx: CanvasRenderingContext2D, data: RaceData, proj: Projection) {
  const pts = data.circuit.centreline;
  if (pts.length < 2) return;
  const [p0, p1] = [pts[0] as [number, number], pts[1] as [number, number]];
  const [x0, y0] = proj.toScreen(p0[0], p0[1]);
  const [x1, y1] = proj.toScreen(p1[0], p1[1]);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const half = 10;
  ctx.beginPath();
  ctx.moveTo(x0 + nx * half, y0 + ny * half);
  ctx.lineTo(x0 - nx * half, y0 - ny * half);
  ctx.strokeStyle = START_LINE_COLOUR;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawDrivers(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  proj: Projection,
  drivers: Map<number, DriverInfo>,
  selected: ReadonlySet<number>,
  reference: number | null,
) {
  // Render in three z-order passes so reference > selected > others.
  // (Selected dots overlap mid-pack drivers visually; the reference should
  // always be on top so the user can track it through traffic.)
  const entries = Object.entries(frame.p);
  const anySelected = selected.size > 0;
  const passOf = (num: number) => (num === reference ? 2 : selected.has(num) ? 1 : 0);

  for (const pass of [0, 1, 2] as const) {
    for (const [numStr, sample] of entries) {
      const num = Number(numStr);
      if (passOf(num) !== pass) continue;
      if (sample.st === "out") continue;

      const info = drivers.get(num);
      const [sx, sy] = proj.toScreen(sample.x, sample.y);
      const colour = info?.team_colour ? `#${info.team_colour}` : FALLBACK_DRIVER_COLOUR;
      const isReference = num === reference;
      const isSelected = selected.has(num);

      let alpha = 1.0;
      if (sample.st === "pit") alpha = 0.4;
      // Dim non-selected drivers when at least one driver is selected.
      if (anySelected && !isSelected) alpha *= 0.35;

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(sx, sy, FOCUS_HALO_RADIUS, 0, Math.PI * 2);
        ctx.strokeStyle = colour;
        ctx.globalAlpha = isReference ? 0.9 : 0.55;
        ctx.lineWidth = isReference ? 3 : 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(sx, sy, DOT_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 1.0;

      if (info) {
        ctx.fillStyle = "rgba(0,0,0,0.85)";
        ctx.font = "bold 9px ui-sans-serif, system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.globalAlpha = alpha;
        ctx.fillText(info.code, sx, sy);
        ctx.globalAlpha = 1.0;
      }
    }
  }
}
