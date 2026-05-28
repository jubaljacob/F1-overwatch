"use client";

import { usePlaybackStore } from "@/lib/replay-engine/playback-store";
import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import type {
  DriverInfo,
  Frame,
  QualiSegment,
  RaceData,
  TrackStatus,
  TrackStatusEvent,
} from "@traceline/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

type CameraPreset = "default" | "side";

interface Props {
  raceData: RaceData;
  frame: Frame | null;
  /** When set, racing-line extraction picks each driver's fastest lap
   *  whose `quali_segment` matches this value, rather than their fastest
   *  lap across the whole session. Null on non-quali sessions. */
  qualiSegment?: QualiSegment | null;
}

/** P6 viewer.
 *
 *  The white centreline polyline is the ground projection (Y=0). The
 *  elevation curtain rises above it from a Y=0 floor (anchored at the
 *  track's lowest point) up to the real elevation profile, coloured
 *  topo-map style (blue → green → yellow → red) by absolute altitude.
 *  A vertical white bar at the first centreline vertex marks where the
 *  start line sits on the curtain — high for circuits like Spa, near
 *  the floor for ones like Hungary.
 *
 *  Drivers ride the **top** of the curtain via centreline-elevation
 *  interpolation at their lap-distance, so they sit on the elevation
 *  contour rather than the ground shadow.
 *
 *  Vertical exaggeration is auto-derived per circuit so the curtain peak
 *  is ≤ MAX_CURTAIN_HEIGHT_RATIO of the track radius — capped on both
 *  ends so flat circuits still show *some* relief and hilly ones don't
 *  tower over their own width.
 *
 *  Coordinate mapping: FastF1 X → world X, FastF1 Y → world −Z (flipped
 *  so the on-screen orientation matches the 2D version when looking
 *  straight down). World Y is reserved for the elevation curtain only —
 *  drivers and centreline ride Y=0.
 */
export function TrackCanvas3D({ raceData, frame, qualiSegment = null }: Props) {
  const selected = usePlaybackStore((s) => s.selectedDrivers);
  const reference = usePlaybackStore((s) => s.referenceDriver);
  const toggleSelected = usePlaybackStore((s) => s.toggleSelectedDriver);
  const clearSelection = usePlaybackStore((s) => s.clearSelection);
  const followedDriver = usePlaybackStore((s) => s.followedDriver);
  const toggleFollowed = usePlaybackStore((s) => s.toggleFollowedDriver);
  const setFollowedDriver = usePlaybackStore((s) => s.setFollowedDriver);
  const effectiveReference = reference ?? selected[0] ?? null;
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const followedDriverCode =
    followedDriver != null
      ? raceData.drivers.find((d) => d.number === followedDriver)?.code ?? null
      : null;

  // Esc releases the chase cam. window listener — canvas keyboard events
  // only fire when the canvas itself has focus, which it usually doesn't.
  useEffect(() => {
    if (followedDriver == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFollowedDriver(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [followedDriver, setFollowedDriver]);

  const driverLookup = useMemo<Map<number, DriverInfo>>(
    () => new Map(raceData.drivers.map((d) => [d.number, d])),
    [raceData],
  );

  const geometry = useMemo(() => buildCentrelineGeometry(raceData), [raceData]);
  const pitLanePoints = useMemo(
    () => extractPitLanePath(raceData, geometry.centroid),
    [raceData, geometry.centroid],
  );
  const speedHeatmap = useMemo(
    () => buildSpeedHeatmap(raceData, geometry.centrelinePoints.length),
    [raceData, geometry.centrelinePoints.length],
  );
  const racingLines = useMemo(
    () =>
      extractRacingLines(raceData, geometry.centroid, geometry.centrelinePoints, qualiSegment),
    [raceData, geometry.centroid, geometry.centrelinePoints, qualiSegment],
  );
  // Cross-track markers where the pit lane meets the main circuit.
  // Derived from the endpoints of the extracted pit-lane path, projected
  // onto the centreline and extended perpendicular across the surface.
  const pitMarkers = useMemo(
    () => extractPitMarkers(pitLanePoints, geometry.centrelinePoints),
    [pitLanePoints, geometry.centrelinePoints],
  );

  const trackStatus = useMemo<TrackStatus>(
    () => resolveTrackStatus(raceData.meta.track_status ?? [], frame?.t ?? 0),
    [raceData.meta.track_status, frame?.t],
  );

  const cameraDistance = Math.max(60, geometry.trackRadius * 1.8);
  const [preset, setPreset] = useState<CameraPreset>("default");
  const [showCurtain, setShowCurtain] = useState(true);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [showRacingLines, setShowRacingLines] = useState(false);

  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{
          fov: 45,
          near: 0.1,
          far: cameraDistance * 10,
          position: [cameraDistance * 0.05, cameraDistance, cameraDistance * 0.55],
        }}
        dpr={[1, 2]}
        onPointerMissed={() => {
          if (selected.length > 0) clearSelection();
        }}
      >
        <color attach="background" args={["#11131a"]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[20, 80, 20]} intensity={0.7} castShadow={false} />

        <TrackSurface
          mesh={geometry.trackMesh}
          showHeatmap={showHeatmap}
          heatmapColors={speedHeatmap.vertexColors}
          statusTint={STATUS_TRACK_TINTS[trackStatus]}
        />
        <Kerbs polylines={geometry.kerbs} />
        <Centreline points={geometry.centrelinePoints} />
        <PitLane points={pitLanePoints} />
        {pitMarkers && <PitMarkers data={pitMarkers} />}
        <StartFinishLine centreline={geometry.centrelinePoints} />
        {showCurtain && geometry.elevationCurtain && (
          <ElevationCurtain data={geometry.elevationCurtain} />
        )}
        {showRacingLines &&
          selected.map((num, i) => {
            const points = racingLines.get(num);
            if (!points || points.length < 2) return null;
            const info = driverLookup.get(num);
            const colour = info?.team_colour ? `#${info.team_colour}` : "#888888";
            // Lines sit just above the track surface; lateral deviation
            // from the centreline is amplified inside extractRacingLines
            // so each driver's line is distinguishable in XZ rather than
            // needing a vertical stack to tell them apart.
            return (
              <RacingLine
                key={num}
                points={points}
                colour={colour}
                yOffset={0.15 + i * 0.05}
              />
            );
          })}

        {frame &&
          Object.entries(frame.p).map(([numStr, sample]) => {
            if (sample.st === "out") return null;
            const num = Number(numStr);
            const info = driverLookup.get(num);
            const colour = info?.team_colour ? `#${info.team_colour}` : "#888888";
            const isSelected = selectedSet.has(num);
            const isReference = num === effectiveReference;
            const anySelected = selected.length > 0;
            const dim = anySelected && !isSelected;
            // Drivers ride the elevation curtain only while it's visible —
            // otherwise they sit on the flat track surface so they don't
            // appear to float above nothing when the curtain is hidden.
            const surfaceY = showCurtain ? geometry.elevationAt(sample.d) : 0;
            return (
              <DriverMarker
                key={num}
                position={[
                  (sample.x - geometry.centroid[0]) * COORD_SCALE,
                  surfaceY + 0.5,
                  -(sample.y - geometry.centroid[1]) * COORD_SCALE,
                ]}
                headingY={geometry.headingAt(sample.d)}
                colour={colour}
                code={info?.code ?? ""}
                isSelected={isSelected}
                isReference={isReference}
                dim={dim}
                inPit={sample.st === "pit"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSelected(num);
                }}
              />
            );
          })}

        <OrbitControls
          makeDefault
          enableDamping={true}
          dampingFactor={0.12}
          minDistance={20}
          maxDistance={cameraDistance * 4}
          maxPolarAngle={preset === "side" ? Math.PI * 0.55 : Math.PI * 0.49}
        />
        <ViewPresetController preset={preset} cameraDistance={cameraDistance} />
        <FollowCameraController
          followedDriver={followedDriver}
          frame={frame}
          centroid={geometry.centroid}
          elevationAt={geometry.elevationAt}
        />
      </Canvas>
      <RaceStatusBanner status={trackStatus} />
      <div className="absolute right-3 top-3 flex flex-col items-end gap-2">
        <div className="flex gap-1">
          <PresetButton
            active={preset === "default"}
            onClick={() => setPreset("default")}
            label="Top"
            title="Default oblique top-down view"
          />
          <PresetButton
            active={preset === "side"}
            onClick={() => setPreset("side")}
            label="Side"
            title="Side-on view — elevation profile silhouette"
          />
        </div>
        {geometry.elevationCurtain && (
          <PresetButton
            active={showCurtain}
            onClick={() => setShowCurtain((v) => !v)}
            label="Elev"
            title="Toggle the elevation curtain"
          />
        )}
        {speedHeatmap.hasData && (
          <PresetButton
            active={showHeatmap}
            onClick={() => setShowHeatmap((v) => !v)}
            label="Heat"
            title="Colour the centreline by average speed (blue = slow, red = fast)"
          />
        )}
        {selected.length > 0 && racingLines.size > 0 && (
          <PresetButton
            active={showRacingLines}
            onClick={() => setShowRacingLines((v) => !v)}
            label="Lines"
            title="Overlay each selected driver's racing line on their fastest lap"
          />
        )}
        {effectiveReference != null && (
          <PresetButton
            active={followedDriver != null}
            onClick={() => toggleFollowed(effectiveReference)}
            label={
              followedDriver != null
                ? `Following ${followedDriverCode ?? effectiveReference} · Esc`
                : `Follow ${
                    raceData.drivers.find((d) => d.number === effectiveReference)?.code ??
                    effectiveReference
                  }`
            }
            title={
              followedDriver != null
                ? "Release the chase camera (Esc)"
                : "Lock the camera to the reference driver"
            }
          />
        )}
      </div>
    </div>
  );
}

const COORD_SCALE = 1 / 100;
/** Real-world F1 track width (metres). Most circuits sit in a 10–15 m
 *  band; 12 m is a representative mean used to derive the rendered
 *  width so the track scales proportionally to circuit geometry instead
 *  of being a free-floating magic constant. */
const REAL_TRACK_WIDTH_M = 12;
/** Visual exaggeration applied to the real-world width. At COORD_SCALE
 *  = 1/100 a true-to-life 12 m road would render as 0.12 world units —
 *  invisible against a ~50-unit track radius. ×37.5 lifts it to ~4.5
 *  units, which reads clearly at default camera distance. Every consumer
 *  (kerbs, racing lines, pit cross-bars, start/finish line) derives off
 *  TRACK_WIDTH, so changing this scales the whole track-decoration
 *  layer consistently. */
const TRACK_WIDTH_VISUAL_SCALE = 37.5;
const TRACK_WIDTH = REAL_TRACK_WIDTH_M * COORD_SCALE * TRACK_WIDTH_VISUAL_SCALE;
/** Kerb width as a multiplier of TRACK_WIDTH. 0.12 ≈ a kerb that's about
 *  15 % of the track surface — visually obvious but proportional. */
const KERB_WIDTH = TRACK_WIDTH * 0.12;
/** Curvature threshold (radians per segment) above which a centreline
 *  vertex counts as a corner. Tuned empirically: catches every named F1
 *  corner without false-positiving on straights with mild bends. */
const CORNER_CURVATURE_THRESHOLD = 0.04;
/** Maximum curtain height as a fraction of the track's bounding radius —
 *  the per-circuit exaggeration factor is auto-derived so the elevation
 *  span fills this ratio. Without the cap, Spa's ~100 m gain at a fixed
 *  5× exaggeration ends up taller than the track is wide; capping at 30%
 *  gives a dramatic but readable profile regardless of circuit. */
const MAX_CURTAIN_HEIGHT_RATIO = 0.3;
/** Floor + ceiling on the auto-derived exaggeration so flat circuits
 *  (Bahrain, Hungary, ~10 m change) don't end up showing zero elevation
 *  and very hilly circuits don't go too dramatic. */
const MIN_EXAGGERATION = 2;
const MAX_EXAGGERATION = 8;
const DOT_RADIUS = 0.9;
const HALO_RADIUS = 1.6;

/** Walk the (sorted-by-t) timeline and return whichever status is active
 *  at session-time `t`. Defaults to "green" when the timeline is empty
 *  or `t` precedes the first event. */
function resolveTrackStatus(timeline: ReadonlyArray<TrackStatusEvent>, t: number): TrackStatus {
  let active: TrackStatus = "green";
  for (const ev of timeline) {
    if (ev.t > t) break;
    active = ev.status;
  }
  return active;
}

/** Per-status base colour for the track surface (linear-space rgb in
 *  [0, 1], because the mesh material is meshStandardMaterial and the
 *  vertex colours feed straight into its base colour term). Green
 *  reuses the original dark grey so a normal race looks unchanged. */
const STATUS_TRACK_TINTS: Record<TrackStatus, [number, number, number]> = {
  green: [0.18, 0.18, 0.21],
  yellow: [0.45, 0.4, 0.15],
  sc: [0.5, 0.32, 0.1],
  vsc: [0.5, 0.32, 0.1],
  red: [0.55, 0.18, 0.18],
};

const STATUS_LABELS: Record<TrackStatus, { text: string; chipBg: string; chipText: string }> = {
  green: {
    text: "RACING",
    chipBg: "bg-emerald-500/25",
    chipText: "text-emerald-200",
  },
  yellow: {
    text: "YELLOW FLAG",
    chipBg: "bg-amber-400/30",
    chipText: "text-amber-100",
  },
  sc: {
    text: "SAFETY CAR",
    chipBg: "bg-orange-500/35",
    chipText: "text-orange-100",
  },
  vsc: {
    text: "VIRTUAL SC",
    chipBg: "bg-orange-500/35",
    chipText: "text-orange-100",
  },
  red: {
    text: "RED FLAG",
    chipBg: "bg-red-500/40",
    chipText: "text-red-100",
  },
};

function RaceStatusBanner({ status }: { status: TrackStatus }) {
  const label = STATUS_LABELS[status];
  return (
    <div className="absolute left-3 top-3 z-10 flex items-center gap-2">
      <span
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest ${label.chipBg} ${label.chipText}`}
      >
        {status === "green" && (
          <span
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"
            aria-hidden
          />
        )}
        {status === "red" && (
          <span
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-400"
            aria-hidden
          />
        )}
        {label.text}
      </span>
    </div>
  );
}

function PresetButton({
  active,
  onClick,
  label,
  title,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded border px-2 py-1 text-[10px] uppercase tracking-widest transition-colors ${
        active
          ? "border-amber-400/60 bg-amber-400/15 text-amber-200"
          : "border-foreground/20 bg-background/70 text-foreground/70 hover:bg-foreground/10"
      }`}
    >
      {label}
    </button>
  );
}

function ViewPresetController({
  preset,
  cameraDistance,
}: {
  preset: CameraPreset;
  cameraDistance: number;
}) {
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as
    | { target: { set: (x: number, y: number, z: number) => void }; update: () => void }
    | null;

  useEffect(() => {
    if (preset === "side") {
      camera.position.set(0, cameraDistance * 0.12, cameraDistance * 1.6);
    } else {
      camera.position.set(
        cameraDistance * 0.05,
        cameraDistance,
        cameraDistance * 0.55,
      );
    }
    if (controls) {
      controls.target.set(0, 0, 0);
      controls.update();
    }
    camera.lookAt(0, 0, 0);
  }, [preset, cameraDistance, camera, controls]);
  return null;
}

/** Locks the OrbitControls target to the followed driver each render
 *  frame, with a smooth lerp so the camera glides rather than teleports
 *  when the user re-targets mid-race. The user keeps full orbit/zoom
 *  around the new target — only the lookat point follows the car.
 *
 *  When `followedDriver` is null this is a no-op; we still mount it so
 *  the engagement edge doesn't need component remount logic. */
function FollowCameraController({
  followedDriver,
  frame,
  centroid,
  elevationAt,
}: {
  followedDriver: number | null;
  frame: Frame | null;
  centroid: [number, number];
  elevationAt: (lapDistance: number) => number;
}) {
  const controls = useThree((s) => s.controls) as
    | {
        target: THREE.Vector3;
        update: () => void;
      }
    | null;
  const tempVec = useRef(new THREE.Vector3());
  // Track whether we just engaged — first frame snaps so the chase
  // doesn't slowly creep in from across the circuit.
  const lastFollowed = useRef<number | null>(null);

  useFrame(() => {
    if (followedDriver == null || !frame || !controls) {
      lastFollowed.current = null;
      return;
    }
    const sample = frame.p[followedDriver];
    if (!sample) return;
    const tx = (sample.x - centroid[0]) * COORD_SCALE;
    const ty = elevationAt(sample.d) + 0.5;
    const tz = -(sample.y - centroid[1]) * COORD_SCALE;
    tempVec.current.set(tx, ty, tz);

    if (lastFollowed.current !== followedDriver) {
      // First frame on this target — snap so the user sees the chase
      // start tight on the car, not after a long slide-in.
      controls.target.copy(tempVec.current);
      lastFollowed.current = followedDriver;
    } else {
      // ~15% per frame at 60Hz is ~0.6s to converge — smooth without
      // feeling laggy.
      controls.target.lerp(tempVec.current, 0.15);
    }
    controls.update();
  });
  return null;
}

function Centreline({ points }: { points: ReadonlyArray<[number, number, number]> }) {
  if (points.length < 2) return null;
  // Thin midline marker on top of the track surface; mostly cosmetic but
  // helps the eye see where the racing-ideal sits.
  return (
    <Line
      points={points as [number, number, number][]}
      color="#ffffff"
      lineWidth={0.8}
      transparent
      opacity={0.25}
      dashed
      dashSize={0.6}
      gapSize={0.6}
    />
  );
}

function TrackSurface({
  mesh,
  showHeatmap,
  heatmapColors,
  statusTint,
}: {
  mesh: TrackMeshData;
  showHeatmap: boolean;
  heatmapColors: ReadonlyArray<[number, number, number]>;
  /** Per-vertex base colour applied when the heatmap is off. When the
   *  race is green this is the default grey; under yellow / SC / VSC /
   *  red it shifts so the surface reads at a glance. */
  statusTint: [number, number, number];
}) {
  // Priority order: heatmap (manual toggle) > statusTint (auto). The
  // mesh stays mounted; only the colour buffer swaps.
  useEffect(() => {
    if (showHeatmap && heatmapColors.length > 0) {
      mesh.setHeatmapColors(heatmapColors);
    } else {
      mesh.setSolidColor(statusTint);
    }
  }, [mesh, showHeatmap, heatmapColors, statusTint]);

  return (
    <mesh geometry={mesh.geometry}>
      <meshStandardMaterial
        vertexColors
        roughness={0.85}
        metalness={0.05}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function Kerbs({
  polylines,
}: {
  polylines: ReadonlyArray<ReadonlyArray<[number, number, number]>>;
}) {
  if (polylines.length === 0) return null;
  return (
    <>
      {polylines.map((pts, i) => (
        <Line
          key={i}
          points={pts as [number, number, number][]}
          color="#ef4444"
          lineWidth={4}
          transparent
          opacity={0.95}
        />
      ))}
    </>
  );
}

function RacingLine({
  points,
  colour,
  yOffset,
}: {
  points: ReadonlyArray<[number, number, number]>;
  colour: string;
  yOffset: number;
}) {
  // Lift the polyline to the requested layer Y. The underlying extracted
  // points come at Y≈0 (per extractRacingLines) so adding the stack
  // offset places each driver's line on its own clear horizon.
  const lifted = useMemo<[number, number, number][]>(
    () => points.map(([x, y, z]) => [x, y + yOffset, z]),
    [points, yOffset],
  );
  return (
    <Line
      points={lifted}
      color={colour}
      lineWidth={2.5}
      transparent
      opacity={0.9}
    />
  );
}

/** Always-visible start/finish cross-line at centreline[0]. Drawn on
 *  the ground plane regardless of session type (Race / Q / SQ / S) and
 *  independent of the elevation curtain toggle so the user always has a
 *  spatial reference for lap_distance = 0. */
function StartFinishLine({
  centreline,
}: {
  centreline: ReadonlyArray<[number, number, number]>;
}) {
  if (centreline.length < 2) return null;
  const a = centreline[0]!;
  const b = centreline[1]!;
  const tx = b[0] - a[0];
  const tz = b[2] - a[2];
  const tlen = Math.hypot(tx, tz) || 1;
  // Perpendicular unit vector (rotate tangent 90°), same convention as
  // projectToCentreline. Span = full track width × 1.2 so the line
  // visibly overhangs both kerbs and reads as a finish line.
  const nx = tz / tlen;
  const nz = -tx / tlen;
  const halfSpan = TRACK_WIDTH * 0.6;
  const yLift = 0.2;
  const p1: [number, number, number] = [a[0] - nx * halfSpan, yLift, a[2] - nz * halfSpan];
  const p2: [number, number, number] = [a[0] + nx * halfSpan, yLift, a[2] + nz * halfSpan];
  return (
    <Line points={[p1, p2]} color="#ffffff" lineWidth={4} transparent opacity={0.95} />
  );
}

interface PitMarkersData {
  entry: { line: [[number, number, number], [number, number, number]]; label: [number, number, number] };
  exit: { line: [[number, number, number], [number, number, number]]; label: [number, number, number] };
}

function PitMarkers({ data }: { data: PitMarkersData }) {
  return (
    <>
      <Line
        points={data.entry.line}
        color="#60a5fa"
        lineWidth={3}
        transparent
        opacity={0.95}
      />
      <Line
        points={data.exit.line}
        color="#34d399"
        lineWidth={3}
        transparent
        opacity={0.95}
      />
    </>
  );
}

/** Take the endpoints of the extracted pit-lane path and project each
 *  onto the centreline, then return short perpendicular line segments
 *  that visually mark where cars enter (blue) and exit (green) the pit
 *  lane. Returns null when the pit-lane path is too short to be useful. */
function extractPitMarkers(
  pitLanePoints: ReadonlyArray<[number, number, number]>,
  centreline: ReadonlyArray<[number, number, number]>,
): PitMarkersData | null {
  if (pitLanePoints.length < 2 || centreline.length < 2) return null;
  const first = pitLanePoints[0]!;
  const last = pitLanePoints[pitLanePoints.length - 1]!;
  const a = projectToCentreline(first[0], first[2], centreline);
  const b = projectToCentreline(last[0], last[2], centreline);
  if (!a || !b) return null;
  // Cross-line span: track half-width × 1.6 so the marker visibly
  // overhangs the track surface on both sides. Lifted just above ground.
  const halfSpan = TRACK_WIDTH * 0.8;
  const yLift = 0.18;
  const seg = (
    p: { cx: number; cz: number; nx: number; nz: number },
  ): [[number, number, number], [number, number, number]] => [
    [p.cx - p.nx * halfSpan, yLift, p.cz - p.nz * halfSpan],
    [p.cx + p.nx * halfSpan, yLift, p.cz + p.nz * halfSpan],
  ];
  // We can't always tell which endpoint is entry vs exit from path
  // direction alone — F1 pit lanes are unidirectional but the captured
  // run could begin on either side. Heuristic: the endpoint closer to
  // the previous pit-lane sample's tangent direction is the exit, the
  // other is the entry. Cheap proxy: first sample = entry (driver was
  // just on track), last sample = exit (driver about to rejoin). Holds
  // for the typical pit-status run captured by extractPitLanePath.
  return {
    entry: { line: seg(a), label: [a.cx, yLift, a.cz] },
    exit: { line: seg(b), label: [b.cx, yLift, b.cz] },
  };
}

function PitLane({ points }: { points: ReadonlyArray<[number, number, number]> }) {
  if (points.length < 2) return null;
  return (
    <Line
      points={points as [number, number, number][]}
      color="#f5c842"
      lineWidth={1.5}
      transparent
      opacity={0.75}
      dashed
      dashSize={0.6}
      gapSize={0.4}
    />
  );
}

interface CurtainData {
  /** Triangle-mesh geometry for the LEFT side wall — paired (left edge,
   *  Y=0) + (left edge, Y=elev[i]) vertices indexed as a strip. */
  leftWall: THREE.BufferGeometry;
  /** Triangle-mesh geometry for the RIGHT side wall — same shape as
   *  leftWall but on the opposite edge of the track. */
  rightWall: THREE.BufferGeometry;
  /** Triangle-mesh geometry for the TOP plane — paired (left edge, elev)
   *  + (right edge, elev) vertices, closing the volume above the road. */
  topPlane: THREE.BufferGeometry;
  /** Polyline at the centreline's elevation profile — drawn separately
   *  so the elevation ridge reads as a crisp line over the translucent
   *  walls. */
  topEdgePoints: ReadonlyArray<[number, number, number]>;
  /** Vertical bar at the start/finish vertex — climbs from track surface
   *  to elevation at that vertex. */
  startMarker: {
    base: [number, number, number];
    top: [number, number, number];
  } | null;
}

function ElevationCurtain({ data }: { data: CurtainData }) {
  return (
    <>
      {/* Two translucent side walls — the boundaries you'd see if the
          track were a sliced cross-section of the terrain. */}
      <mesh geometry={data.leftWall}>
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={0.32}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh geometry={data.rightWall}>
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={0.32}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      {/* Top plane — translucent ceiling following the elevation profile,
          letting the user see both walls AND the ridge from above. */}
      <mesh geometry={data.topPlane}>
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={0.22}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <Line
        points={data.topEdgePoints as [number, number, number][]}
        color="#ffe066"
        lineWidth={1.5}
        transparent
        opacity={0.95}
      />
      {data.startMarker && (
        <Line
          points={[data.startMarker.base, data.startMarker.top]}
          color="#ffffff"
          lineWidth={2.5}
          transparent
          opacity={0.9}
        />
      )}
    </>
  );
}

interface DriverMarkerProps {
  position: [number, number, number];
  /** Heading around the world Y axis (radians) so the car icon's nose
   *  points in the direction of travel. Derived from the centreline
   *  tangent at the driver's lap distance. */
  headingY: number;
  colour: string;
  code: string;
  isSelected: boolean;
  isReference: boolean;
  dim: boolean;
  inPit: boolean;
  onClick: (e: ThreeEvent<MouseEvent>) => void;
}

const CAR_LENGTH = 2.4;
const CAR_BODY_WIDTH = 0.8;
const CAR_FRONT_WING_WIDTH = 1.25;
const CAR_REAR_WING_WIDTH = 1.05;
const CAR_WING_THICKNESS = 0.18;
const CAR_TYRE_WIDTH = 0.22;
const CAR_TYRE_LENGTH = 0.55;
const CAR_TYRE_X = CAR_LENGTH * 0.32;
const CAR_TYRE_Z = CAR_BODY_WIDTH / 2 + CAR_TYRE_WIDTH / 2 - 0.06;

/** Top-down F1-car silhouette built from flat planes lying on the XZ
 *  plane. The car's local +X is the nose direction; the parent group's
 *  Y-rotation aligns +X with the centreline tangent at the driver's
 *  lap-distance. Tyres are dark, body is team-coloured, wings have a
 *  slightly darker tint to read as separate parts. Click target stays
 *  the same size as before (DOT_RADIUS sphere, fully transparent) so
 *  the picking surface is forgiving on small markers. */
function DriverMarker({
  position,
  headingY,
  colour,
  isSelected,
  isReference,
  dim,
  inPit,
  onClick,
}: DriverMarkerProps) {
  const opacity = inPit ? 0.35 : dim ? 0.4 : 1;
  const haloOpacity = isReference ? 0.9 : 0.5;
  const haloThickness = isReference ? 0.18 : 0.1;
  // Lift the car a hair above the ground plane so it doesn't z-fight
  // with the track surface; halo sits below the car at ground level so
  // it stays visible as a ring around the silhouette.
  const carLift = 0.12;
  return (
    <group position={position} rotation={[0, headingY, 0]}>
      {isSelected && (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[HALO_RADIUS, haloThickness, 8, 32]} />
          <meshBasicMaterial color={colour} transparent opacity={haloOpacity} />
        </mesh>
      )}
      <group position={[0, carLift, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        {/* meshes are authored in local XY (since rotation -π/2 around X
            puts the local XY plane onto world XZ). Local +X = nose. */}
        {/* Body */}
        <mesh>
          <planeGeometry args={[CAR_LENGTH, CAR_BODY_WIDTH]} />
          <meshBasicMaterial
            color={colour}
            transparent={opacity < 1}
            opacity={opacity}
          />
        </mesh>
        {/* Front wing — wider than the body, near the nose */}
        <mesh position={[CAR_LENGTH * 0.45, 0, 0.001]}>
          <planeGeometry args={[CAR_WING_THICKNESS, CAR_FRONT_WING_WIDTH]} />
          <meshBasicMaterial
            color="#1a1a1a"
            transparent={opacity < 1}
            opacity={opacity}
          />
        </mesh>
        {/* Rear wing */}
        <mesh position={[-CAR_LENGTH * 0.46, 0, 0.001]}>
          <planeGeometry args={[CAR_WING_THICKNESS, CAR_REAR_WING_WIDTH]} />
          <meshBasicMaterial
            color="#1a1a1a"
            transparent={opacity < 1}
            opacity={opacity}
          />
        </mesh>
        {/* Four tyres — one per corner. Drawn slightly above the body
            so they read as separate from the chassis. */}
        {([
          [CAR_TYRE_X, CAR_TYRE_Z],
          [CAR_TYRE_X, -CAR_TYRE_Z],
          [-CAR_TYRE_X, CAR_TYRE_Z],
          [-CAR_TYRE_X, -CAR_TYRE_Z],
        ] as const).map(([x, y], i) => (
          <mesh key={i} position={[x, y, 0.002]}>
            <planeGeometry args={[CAR_TYRE_LENGTH, CAR_TYRE_WIDTH]} />
            <meshBasicMaterial
              color="#0a0a0a"
              transparent={opacity < 1}
              opacity={opacity}
            />
          </mesh>
        ))}
      </group>
      {/* Invisible click target sized to the old dot so picking still
          works for users who can't precisely hit the slim silhouette. */}
      <mesh onClick={onClick}>
        <sphereGeometry args={[DOT_RADIUS, 8, 6]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

interface SpeedHeatmap {
  vertexColors: ReadonlyArray<[number, number, number]>;
  hasData: boolean;
}

/** Compute average speed per centreline vertex by bucketing every
 *  on-track sample by its lap-distance. Returns one colour per vertex so
 *  drei's `<Line vertexColors>` can interpolate the gradient between them
 *  for free. Slow corners come out cool (blue/teal), fast straights warm
 *  (yellow/red). Vertices with no samples in their bucket inherit the
 *  neighbour's colour visually via Line's segment interpolation. */
function buildSpeedHeatmap(raceData: RaceData, n: number): SpeedHeatmap {
  const cumDist = raceData.circuit.cumulative_distance ?? [];
  const trackLength = raceData.circuit.track_length_m || 1;
  if (n === 0 || cumDist.length !== n || raceData.frames.length === 0) {
    return { vertexColors: [], hasData: false };
  }

  const sums = new Float32Array(n);
  const counts = new Uint32Array(n);

  for (const frame of raceData.frames) {
    for (const sample of Object.values(frame.p)) {
      if (sample.st !== "on_track") continue;
      if (sample.spd <= 0) continue;
      const d = ((sample.d % trackLength) + trackLength) % trackLength;
      // Binary search for the vertex whose cum_dist is just <= d.
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if ((cumDist[mid] ?? 0) < d) lo = mid + 1;
        else hi = mid;
      }
      const idx = lo === 0 ? 0 : lo - 1;
      sums[idx]! += sample.spd;
      counts[idx]! += 1;
    }
  }

  let minSpeed = Number.POSITIVE_INFINITY;
  let maxSpeed = Number.NEGATIVE_INFINITY;
  const avg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if ((counts[i] ?? 0) > 0) {
      const v = sums[i]! / counts[i]!;
      avg[i] = v;
      if (v < minSpeed) minSpeed = v;
      if (v > maxSpeed) maxSpeed = v;
    }
  }
  if (!Number.isFinite(minSpeed) || !Number.isFinite(maxSpeed)) {
    return { vertexColors: [], hasData: false };
  }
  const span = maxSpeed - minSpeed || 1;

  // Forward-fill empty buckets so colour bands don't collapse to black on
  // vertices that happened to fall between samples.
  let lastT = 0.5;
  const vertexColors: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (counts[i] ?? 0) > 0 ? (avg[i]! - minSpeed) / span : lastT;
    lastT = t;
    vertexColors.push(topoColour(t));
  }
  return { vertexColors, hasData: true };
}

/** Per-driver fastest-clean-lap trajectories. Walk the frames once,
 *  bucket each on-track sample by (driver, lap), and for each driver
 *  pick the lap with the shortest duration that isn't a pit-in / pit-out
 *  lap (those are slow for non-racing reasons). Return as world-space
 *  polylines ready to feed straight into drei's `<Line>`. */
/** Half-window for the moving-average smoother applied to the offset
 *  series. At 10 Hz a half-window of 12 = 2.4 s of context per output
 *  sample. Heavier than feels necessary on paper, but the subsequent
 *  per-driver normalization pushes whatever's left to the full track
 *  width — so any noise that survives smoothing gets amplified hard.
 *  Better to over-smooth the offset slightly (losing tiny apex-timing
 *  nuance) than to amplify GPS jitter into a sawtooth. */
const RACING_LINE_SMOOTH_WINDOW = 15;
/** Half-window for the second smoothing pass, applied to the final XZ
 *  polyline after normalization. Larger than the offset pass because
 *  centreline normals rotate fast at corners — even a clean offset gets
 *  translated into rapid XZ motion through a hairpin, so post-smoothing
 *  the actual rendered geometry is where corner glide really gets fixed. */
const RACING_LINE_POLY_SMOOTH_WINDOW = 8;
/** Fraction of the track half-width that the largest (smoothed)
 *  lateral excursion of a driver's fastest lap maps to. 0.92 means the
 *  driver's biggest deviation visually grazes the track edge — i.e.
 *  the eye reads it as a kerb-hug, with smaller deviations scaling
 *  proportionally. Below 1.0 so the line never crosses the visible
 *  edge even after smoothing/normalization rounding. */
const RACING_LINE_EDGE_FILL = 0.92;
/** Percentile of |offset| used as the "max" reference when normalising.
 *  Using P95 rather than the true max makes the scaling robust to a
 *  single noisy outlier sample dragging the entire line back toward
 *  the centreline. */
const RACING_LINE_NORM_PERCENTILE = 0.95;

function percentileAbs(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const abs = values.map((v) => Math.abs(v)).sort((a, b) => a - b);
  const idx = Math.min(abs.length - 1, Math.floor(p * (abs.length - 1)));
  return abs[idx] ?? 0;
}

function smoothSeries(values: readonly number[], halfWindow: number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  if (n === 0 || halfWindow <= 0) {
    for (let i = 0; i < n; i++) out[i] = values[i] ?? 0;
    return out;
  }
  // Prefix sums for O(1) window average.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + (values[i] ?? 0);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(n, i + halfWindow + 1);
    out[i] = (prefix[hi]! - prefix[lo]!) / (hi - lo);
  }
  return out;
}

function extractRacingLines(
  raceData: RaceData,
  centroid: [number, number],
  centreline: ReadonlyArray<[number, number, number]>,
  qualiSegment: QualiSegment | null,
): Map<number, [number, number, number][]> {
  const skipLaps = new Set<string>(); // `${driver}:${lap}`
  // Allowlist of (driver, lap) pairs from the requested quali segment.
  // Null when not in quali — in that case every non-pit lap is eligible.
  const allowLaps: Set<string> | null = qualiSegment ? new Set() : null;
  for (const lr of raceData.laps) {
    if (lr.pit_in || lr.pit_out) skipLaps.add(`${lr.driver}:${lr.lap}`);
    if (allowLaps && lr.quali_segment === qualiSegment) {
      allowLaps.add(`${lr.driver}:${lr.lap}`);
    }
  }

  // driver -> lap -> samples (kept in time order)
  const buckets = new Map<number, Map<number, { t: number; x: number; y: number }[]>>();
  for (const frame of raceData.frames) {
    for (const [numStr, sample] of Object.entries(frame.p)) {
      if (sample.st !== "on_track") continue;
      const num = Number(numStr);
      let perDriver = buckets.get(num);
      if (!perDriver) {
        perDriver = new Map();
        buckets.set(num, perDriver);
      }
      let lap = perDriver.get(sample.lap);
      if (!lap) {
        lap = [];
        perDriver.set(sample.lap, lap);
      }
      lap.push({ t: frame.t, x: sample.x, y: sample.y });
    }
  }

  const out = new Map<number, [number, number, number][]>();
  for (const [driver, perDriver] of buckets) {
    let bestLap: { t: number; x: number; y: number }[] | null = null;
    let bestDuration = Number.POSITIVE_INFINITY;
    for (const [lapNum, points] of perDriver) {
      if (skipLaps.has(`${driver}:${lapNum}`)) continue;
      if (allowLaps && !allowLaps.has(`${driver}:${lapNum}`)) continue;
      if (points.length < 30) continue; // too few samples — likely partial lap
      const duration = points[points.length - 1]!.t - points[0]!.t;
      // Sanity bound: F1 lap times are always >50s; anything shorter is
      // a data quirk (lap counter glitch, etc.).
      if (duration > 50 && duration < bestDuration) {
        bestDuration = duration;
        bestLap = points;
      }
    }
    if (bestLap) {
      // Project samples onto the centreline. Raw per-sample offset is
      // noisy (~0.5 m GPS jitter) so we smooth the signed offset series
      // first with a centred moving average. Then we normalise: the
      // 95th-percentile |offset| across the lap maps to EDGE_FILL of the
      // track half-width, so each driver's largest deviation visually
      // grazes the kerb rather than barely budging off the centreline.
      // This makes kerb-hug vs late-apex choices obvious between two
      // drivers without needing to know absolute GPS scale.
      const projected = bestLap.map((p) => {
        const wx = (p.x - centroid[0]) * COORD_SCALE;
        const wz = -(p.y - centroid[1]) * COORD_SCALE;
        return projectToCentreline(wx, wz, centreline);
      });
      const offsets = projected.map((pr) => (pr ? pr.offset : 0));
      // Two passes ≈ triangular kernel ≈ near-Gaussian roll-off, kills
      // residual jitter much better than one box of equivalent length.
      const smoothed = smoothSeries(
        smoothSeries(offsets, RACING_LINE_SMOOTH_WINDOW),
        RACING_LINE_SMOOTH_WINDOW,
      );
      const refOffset = percentileAbs(smoothed, RACING_LINE_NORM_PERCENTILE);
      const halfTrack = TRACK_WIDTH / 2;
      const scale = refOffset > 0 ? (halfTrack * RACING_LINE_EDGE_FILL) / refOffset : 0;
      const maxOffset = halfTrack * 0.98;
      const raw: [number, number, number][] = projected.map((pr, idx) => {
        if (!pr) return [0, 0, 0] as [number, number, number];
        const amped = Math.max(
          -maxOffset,
          Math.min(maxOffset, smoothed[idx]! * scale),
        );
        return [pr.cx + pr.nx * amped, 0, pr.cz + pr.nz * amped];
      });
      // Final polyline smoothing: average each XZ vertex with its
      // neighbours so the rendered line glides through the corners
      // instead of zig-zagging on any residual jitter.
      const xs = raw.map((p) => p[0]);
      const zs = raw.map((p) => p[2]);
      const xsS = smoothSeries(
        smoothSeries(xs, RACING_LINE_POLY_SMOOTH_WINDOW),
        RACING_LINE_POLY_SMOOTH_WINDOW,
      );
      const zsS = smoothSeries(
        smoothSeries(zs, RACING_LINE_POLY_SMOOTH_WINDOW),
        RACING_LINE_POLY_SMOOTH_WINDOW,
      );
      out.set(
        driver,
        raw.map((_, i) => [xsS[i]!, 0, zsS[i]!] as [number, number, number]),
      );
    }
  }
  return out;
}

/** Project a world-space point onto the centreline polyline. Returns the
 *  closest centreline point (cx, cz), the perpendicular unit normal at
 *  that point, and the signed offset along that normal from centreline
 *  to the original point. Sign convention matches `tangentNormal`. */
function projectToCentreline(
  px: number,
  pz: number,
  centreline: ReadonlyArray<[number, number, number]>,
): { cx: number; cz: number; nx: number; nz: number; offset: number } | null {
  const n = centreline.length;
  if (n < 2) return null;
  let bestDist2 = Number.POSITIVE_INFINITY;
  let bestCx = 0;
  let bestCz = 0;
  let bestTx = 0;
  let bestTz = 0;
  for (let i = 0; i < n; i++) {
    const a = centreline[i]!;
    const b = centreline[(i + 1) % n]!;
    const ax = a[0];
    const az = a[2];
    const bx = b[0];
    const bz = b[2];
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 === 0) continue;
    let t = ((px - ax) * dx + (pz - az) * dz) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = ax + dx * t;
    const cz = az + dz * t;
    const ex = px - cx;
    const ez = pz - cz;
    const d2 = ex * ex + ez * ez;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestCx = cx;
      bestCz = cz;
      bestTx = dx;
      bestTz = dz;
    }
  }
  const tlen = Math.hypot(bestTx, bestTz) || 1;
  // Perpendicular: rotate tangent (x,z) → (z, −x), matching tangentNormal.
  const nx = bestTz / tlen;
  const nz = -bestTx / tlen;
  // Signed offset = dot(point − centrePoint, normal)
  const offset = (px - bestCx) * nx + (pz - bestCz) * nz;
  return { cx: bestCx, cz: bestCz, nx, nz, offset };
}

/** Walk the frames once and capture the first sufficiently-long contiguous
 *  pit-status run from any driver — that trajectory traces the actual pit
 *  lane in the same coordinate frame as the centreline. */
function extractPitLanePath(
  raceData: RaceData,
  centroid: [number, number],
): ReadonlyArray<[number, number, number]> {
  const MIN_RUN_LENGTH = 50; // ~5 s at 10 Hz
  const inProgress = new Map<number, [number, number][]>();
  for (const frame of raceData.frames) {
    for (const [numStr, sample] of Object.entries(frame.p)) {
      const num = Number(numStr);
      if (sample.st === "pit") {
        let run = inProgress.get(num);
        if (!run) {
          run = [];
          inProgress.set(num, run);
        }
        run.push([sample.x, sample.y]);
      } else if (inProgress.has(num)) {
        const run = inProgress.get(num)!;
        if (run.length >= MIN_RUN_LENGTH) return toGroundPoints(run, centroid);
        inProgress.delete(num);
      }
    }
  }
  for (const run of inProgress.values()) {
    if (run.length >= MIN_RUN_LENGTH) return toGroundPoints(run, centroid);
  }
  return [];
}

function toGroundPoints(
  xy: ReadonlyArray<[number, number]>,
  centroid: [number, number],
): [number, number, number][] {
  // Lifted a hair above the centreline so the pit line stays visually
  // clear of it rather than z-fighting where the pit road parallels the
  // start/finish straight.
  const Y_OFFSET = 0.15;
  return xy.map(([x, y]) => [
    (x - centroid[0]) * COORD_SCALE,
    Y_OFFSET,
    -(y - centroid[1]) * COORD_SCALE,
  ]);
}

interface CentrelineGeometry {
  centrelinePoints: ReadonlyArray<[number, number, number]>;
  centroid: [number, number];
  trackRadius: number;
  elevationCurtain: CurtainData | null;
  /** Elevation lookup for the driver markers — returns the curtain
   *  surface Y at a given lap-distance, or 0 when no elevation data. */
  elevationAt: (lapDistance: number) => number;
  /** Heading lookup (radians around Y axis) so the F1-car icon points
   *  the way the car is actually travelling along the centreline. */
  headingAt: (lapDistance: number) => number;
  /** The wider track surface — a triangle mesh with one vertex on each
   *  edge per centreline point. */
  trackMesh: TrackMeshData;
  /** Red kerb polylines on the outside edges of detected corners. */
  kerbs: ReadonlyArray<ReadonlyArray<[number, number, number]>>;
}

interface TrackMeshData {
  geometry: THREE.BufferGeometry;
  /** Per-vertex avg-speed colour, applied when the heatmap toggle is on. */
  setHeatmapColors: (colors: ReadonlyArray<[number, number, number]>) => void;
  /** Repaint every vertex to a single colour — used to apply the race-
   *  status tint when the heatmap is off. */
  setSolidColor: (color: readonly [number, number, number]) => void;
  clearHeatmapColors: () => void;
}

/** Build the flat centreline (Y=0 always) plus the elevation curtain mesh
 *  whose top edge follows the real elevation profile, baselined at the
 *  lowest point. Auto-derives an exaggeration factor so the curtain's
 *  peak height fills `MAX_CURTAIN_HEIGHT_RATIO` of the track radius. */
function buildCentrelineGeometry(raceData: RaceData): CentrelineGeometry {
  const pts = raceData.circuit.centreline;
  const elev = raceData.circuit.elevation ?? [];
  const cumDist = raceData.circuit.cumulative_distance ?? [];
  const trackLength = raceData.circuit.track_length_m || 1;

  if (pts.length === 0) {
    return {
      centrelinePoints: [],
      centroid: [0, 0],
      trackRadius: 60,
      elevationCurtain: null,
      elevationAt: () => 0,
      headingAt: () => 0,
      trackMesh: buildTrackMesh([], TRACK_WIDTH),
      kerbs: [],
    };
  }

  let sumX = 0;
  let sumY = 0;
  for (const [x, y] of pts) {
    sumX += x;
    sumY += y;
  }
  const cx = sumX / pts.length;
  const cy = sumY / pts.length;

  let maxR = 0;
  const centreline: [number, number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    const wx = (x - cx) * COORD_SCALE;
    const wz = -(y - cy) * COORD_SCALE;
    centreline.push([wx, 0, wz]);
    const r = Math.hypot(wx, wz);
    if (r > maxR) maxR = r;
  }

  const hasElev = elev.length === pts.length && elev.length > 0;
  let minElev = 0;
  let elevSpan = 0;
  let exaggeration = MIN_EXAGGERATION;
  if (hasElev) {
    minElev = Number.POSITIVE_INFINITY;
    let maxElev = Number.NEGATIVE_INFINITY;
    for (const e of elev) {
      if (e < minElev) minElev = e;
      if (e > maxElev) maxElev = e;
    }
    elevSpan = maxElev - minElev;
    if (elevSpan > 0 && maxR > 0) {
      // Auto-scale: pick the exaggeration that makes the curtain peak
      // equal to MAX_CURTAIN_HEIGHT_RATIO × trackRadius. Bounded so flat
      // tracks still show *some* relief and hilly ones don't go alpine.
      const target = (maxR * MAX_CURTAIN_HEIGHT_RATIO) / (elevSpan * COORD_SCALE);
      exaggeration = Math.max(MIN_EXAGGERATION, Math.min(MAX_EXAGGERATION, target));
    }
  }

  const elevationCurtain = hasElev
    ? buildCurtainGeometry(centreline, elev, minElev, exaggeration)
    : null;

  const elevationAt = hasElev
    ? makeElevationLookup(elev, cumDist, minElev, exaggeration, trackLength)
    : () => 0;

  const headingAt = makeHeadingLookup(centreline, cumDist, trackLength);

  const trackMesh = buildTrackMesh(centreline, TRACK_WIDTH);
  const kerbs = buildKerbs(centreline, TRACK_WIDTH);

  return {
    centrelinePoints: centreline,
    centroid: [cx, cy],
    trackRadius: maxR,
    elevationCurtain,
    elevationAt,
    headingAt,
    trackMesh,
    kerbs,
  };
}

/** Build a lap-distance → heading-radians lookup using each centreline
 *  segment's tangent direction. The atan2 convention here is matched to
 *  Three.js's Y-up coordinate system: a heading of 0 rad points along
 *  +X, positive rotation runs counter-clockwise when viewed from above.
 *  Returns the heading at the segment containing the requested distance,
 *  with cyclic wrap-around at the start/finish line. */
function makeHeadingLookup(
  centreline: ReadonlyArray<[number, number, number]>,
  cumDist: ReadonlyArray<number>,
  trackLength: number,
): (lapDistance: number) => number {
  const n = centreline.length;
  if (n < 2 || trackLength <= 0) return () => 0;
  const headings = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = centreline[i]!;
    const b = centreline[(i + 1) % n]!;
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    // The marker is rotated around Y; rotation 0 leaves +X facing right.
    // We want the car's local +X axis (nose) to align with the tangent,
    // so heading = -atan2(dz, dx) because rotating +Y by θ rotates +X
    // by -θ in the XZ plane (Three.js right-handed convention).
    headings[i] = -Math.atan2(dz, dx);
  }
  const usableCumDist = cumDist.length === n;
  return (lapDistance: number): number => {
    if (!usableCumDist) {
      const idx = Math.min(n - 1, Math.max(0, Math.floor((lapDistance / trackLength) * n)));
      return headings[idx]!;
    }
    const d = ((lapDistance % trackLength) + trackLength) % trackLength;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumDist[mid] ?? 0) < d) lo = mid + 1;
      else hi = mid;
    }
    return headings[lo === 0 ? 0 : lo - 1]!;
  };
}

/** Build the road surface as a triangle mesh by offsetting each centreline
 *  vertex perpendicular to its local tangent. Two vertices per centreline
 *  point (left edge + right edge), triangles between consecutive pairs.
 *  The mesh closes around the start/finish line so the strip is a proper
 *  loop without a gap. Per-vertex colour buffer is pre-allocated so the
 *  heatmap toggle can paint speeds directly without re-creating geometry. */
function buildTrackMesh(
  centreline: ReadonlyArray<[number, number, number]>,
  width: number,
): TrackMeshData {
  const n = centreline.length;
  const halfW = width / 2;
  const positions = new Float32Array(n * 2 * 3);
  // Default light-grey road colour; heatmap mode overwrites per-vertex.
  const defaultColour: [number, number, number] = [0.18, 0.18, 0.21];
  const colors = new Float32Array(n * 2 * 3);
  for (let k = 0; k < n * 2; k++) {
    colors[k * 3 + 0] = defaultColour[0];
    colors[k * 3 + 1] = defaultColour[1];
    colors[k * 3 + 2] = defaultColour[2];
  }

  for (let i = 0; i < n; i++) {
    const p = centreline[i]!;
    const [nx, nz] = tangentNormal(centreline, i);
    // Left edge = +perp, right edge = -perp (chirality matches the
    // perpendicular convention used by the kerb builder so the two stay
    // in agreement about which side is "outside").
    const leftX = p[0] + nx * halfW;
    const leftZ = p[2] + nz * halfW;
    const rightX = p[0] - nx * halfW;
    const rightZ = p[2] - nz * halfW;
    positions[i * 6 + 0] = leftX;
    positions[i * 6 + 1] = p[1];
    positions[i * 6 + 2] = leftZ;
    positions[i * 6 + 3] = rightX;
    positions[i * 6 + 4] = p[1];
    positions[i * 6 + 5] = rightZ;
  }

  const indices: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = i * 2 + 1;
    const c = (i + 1) * 2;
    const d = (i + 1) * 2 + 1;
    indices.push(a, b, c);
    indices.push(b, d, c);
  }
  // Close the loop. Skipped when the centreline didn't include the
  // duplicate closing vertex (only matters for non-race sessions).
  if (n > 1) {
    indices.push((n - 1) * 2, (n - 1) * 2 + 1, 0);
    indices.push((n - 1) * 2 + 1, 1, 0);
  }

  const geom = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const colAttr = new THREE.BufferAttribute(colors, 3);
  geom.setAttribute("position", posAttr);
  geom.setAttribute("color", colAttr);
  geom.setIndex(indices);
  geom.computeVertexNormals();

  const setHeatmapColors = (vc: ReadonlyArray<[number, number, number]>) => {
    if (vc.length !== n) return;
    for (let i = 0; i < n; i++) {
      const [r, g, b] = vc[i]!;
      colors[i * 6 + 0] = r;
      colors[i * 6 + 1] = g;
      colors[i * 6 + 2] = b;
      colors[i * 6 + 3] = r;
      colors[i * 6 + 4] = g;
      colors[i * 6 + 5] = b;
    }
    colAttr.needsUpdate = true;
  };
  const clearHeatmapColors = () => {
    for (let k = 0; k < n * 2; k++) {
      colors[k * 3 + 0] = defaultColour[0];
      colors[k * 3 + 1] = defaultColour[1];
      colors[k * 3 + 2] = defaultColour[2];
    }
    colAttr.needsUpdate = true;
  };
  const setSolidColor = (color: readonly [number, number, number]) => {
    for (let k = 0; k < n * 2; k++) {
      colors[k * 3 + 0] = color[0];
      colors[k * 3 + 1] = color[1];
      colors[k * 3 + 2] = color[2];
    }
    colAttr.needsUpdate = true;
  };

  return { geometry: geom, setHeatmapColors, setSolidColor, clearHeatmapColors };
}

/** Detect corner vertices by walking the centreline and computing the
 *  turning angle between incoming and outgoing tangents. Groups
 *  consecutive flagged vertices (same turn direction) into one corner
 *  segment, then emits a kerb polyline along the OUTSIDE edge of each
 *  segment — i.e. opposite the turn direction, just beyond the track
 *  edge. F1 kerbs are always on the outside of turns. */
function buildKerbs(
  centreline: ReadonlyArray<[number, number, number]>,
  trackWidth: number,
): [number, number, number][][] {
  const n = centreline.length;
  if (n < 3) return [];

  // Per-vertex turn classification: 0 = straight, 1 = left, -1 = right
  const turns = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const prev = centreline[(i - 1 + n) % n]!;
    const curr = centreline[i]!;
    const next = centreline[(i + 1) % n]!;
    const dx1 = curr[0] - prev[0];
    const dz1 = curr[2] - prev[2];
    const dx2 = next[0] - curr[0];
    const dz2 = next[2] - curr[2];
    const len1 = Math.hypot(dx1, dz1);
    const len2 = Math.hypot(dx2, dz2);
    if (len1 === 0 || len2 === 0) continue;
    const dot = (dx1 * dx2 + dz1 * dz2) / (len1 * len2);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    if (angle < CORNER_CURVATURE_THRESHOLD) continue;
    const cross = dx1 * dz2 - dz1 * dx2;
    turns[i] = cross > 0 ? 1 : -1;
  }

  // Group consecutive same-direction turns. Allow a small gap of straight
  // vertices inside a corner (real-world corners have momentary
  // straightening at the apex) so we don't fragment one corner into many.
  const GAP_TOLERANCE = 2;
  const sections: { dir: 1 | -1; indices: number[] }[] = [];
  let current: { dir: 1 | -1; indices: number[] } | null = null;
  let gap = 0;
  for (let i = 0; i < n; i++) {
    const t = turns[i] as 0 | 1 | -1;
    if (t !== 0) {
      if (current && current.dir === t) {
        current.indices.push(i);
        gap = 0;
      } else {
        if (current) sections.push(current);
        current = { dir: t, indices: [i] };
        gap = 0;
      }
    } else if (current) {
      gap++;
      if (gap > GAP_TOLERANCE) {
        sections.push(current);
        current = null;
        gap = 0;
      } else {
        current.indices.push(i);
      }
    }
  }
  if (current) sections.push(current);

  // Build a polyline along the outside edge of each section.
  const halfW = trackWidth / 2;
  const kerbOffset = halfW + KERB_WIDTH * 0.6; // sit just outside the track edge
  const kerbs: [number, number, number][][] = [];
  for (const section of sections) {
    // OUTSIDE of left turn = right side (perpendicular −); OUTSIDE of
    // right turn = left side (perpendicular +). Sign convention matches
    // buildTrackMesh's left/right offset above.
    const sign = section.dir === 1 ? -1 : 1;
    const polyline: [number, number, number][] = [];
    for (const i of section.indices) {
      const p = centreline[i]!;
      const [nx, nz] = tangentNormal(centreline, i);
      polyline.push([
        p[0] + nx * kerbOffset * sign,
        p[1] + 0.05, // tiny lift to avoid z-fighting with the track surface
        p[2] + nz * kerbOffset * sign,
      ]);
    }
    if (polyline.length >= 2) kerbs.push(polyline);
  }
  return kerbs;
}

/** XZ-plane perpendicular (unit vector) at centreline vertex `i`.
 *  Computed from the average of the incoming and outgoing tangent so
 *  sharp corners get a well-defined normal rather than ringing. */
function tangentNormal(
  centreline: ReadonlyArray<[number, number, number]>,
  i: number,
): [number, number] {
  const n = centreline.length;
  const prev = centreline[(i - 1 + n) % n]!;
  const next = centreline[(i + 1) % n]!;
  const tx = next[0] - prev[0];
  const tz = next[2] - prev[2];
  const len = Math.hypot(tx, tz) || 1;
  // Rotate tangent 90° (x,z) → (z, −x). Convention: left = +perp,
  // right = −perp.
  return [tz / len, -tx / len];
}

/** Returns a function that maps a driver's lap-distance to the curtain
 *  surface Y at that point, so the driver marker rides the top of the
 *  curtain. Uses linear interpolation between the centreline vertices
 *  nearest the requested distance, with binary search for the index. */
function makeElevationLookup(
  elev: readonly number[],
  cumDist: readonly number[],
  minElev: number,
  exaggeration: number,
  trackLength: number,
): (lapDistance: number) => number {
  const n = Math.min(elev.length, cumDist.length);
  if (n === 0) return () => 0;
  return (lapDistance: number): number => {
    // Wrap to [0, trackLength) — lapDistance can come in past one wrap
    // depending on the centreline's own length.
    const wrapped = ((lapDistance % trackLength) + trackLength) % trackLength;
    // Binary search for the first index with cumDist[i] >= wrapped.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((cumDist[mid] ?? 0) < wrapped) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) {
      return ((elev[0] ?? minElev) - minElev) * COORD_SCALE * exaggeration;
    }
    const j = lo;
    const i = lo - 1;
    const span = (cumDist[j] ?? 0) - (cumDist[i] ?? 0);
    const e = elev[i] ?? minElev;
    const eNext = elev[j] ?? e;
    const interp =
      span > 0 ? e + ((eNext - e) * (wrapped - (cumDist[i] ?? 0))) / span : e;
    return (interp - minElev) * COORD_SCALE * exaggeration;
  };
}

/** Build the curtain mesh. We use the **actual elevation profile** with
 *  the curtain floor (Y=0) anchored at the track's lowest point and the
 *  top edge tracing the real altitude at each centreline vertex. The
 *  start line is just one point on the curtain — for circuits like Spa
 *  where the start is well above the lowest point, the start-line marker
 *  sits high on the curtain, exactly as it should. A separate vertical
 *  white bar marks where the start line is so it stays visually distinct.
 *
 *  Vertex colours blend cool (blue) at the lowest point to warm (red) at
 *  the highest — topo-map style — so the elevation profile reads even
 *  from a strict top-down view. */
function buildCurtainGeometry(
  centreline: ReadonlyArray<[number, number, number]>,
  elev: readonly number[],
  minElev: number,
  exaggeration: number,
): CurtainData {
  const n = centreline.length;
  let maxElev = Number.NEGATIVE_INFINITY;
  for (const e of elev) if (e > maxElev) maxElev = e;
  const elevSpan = maxElev - minElev || 1;

  // Pre-compute the left/right edge XZ + per-vertex elevation height +
  // topo colour. We share these across the three meshes so the walls
  // and the top plane stay perfectly aligned at every vertex.
  const halfW = TRACK_WIDTH / 2;
  const leftX = new Float32Array(n);
  const leftZ = new Float32Array(n);
  const rightX = new Float32Array(n);
  const rightZ = new Float32Array(n);
  const heights = new Float32Array(n);
  const cR = new Float32Array(n);
  const cG = new Float32Array(n);
  const cB = new Float32Array(n);
  const topEdgePoints: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const [wx, , wz] = centreline[i]!;
    const [nx, nz] = tangentNormal(centreline, i);
    leftX[i] = wx + nx * halfW;
    leftZ[i] = wz + nz * halfW;
    rightX[i] = wx - nx * halfW;
    rightZ[i] = wz - nz * halfW;
    const rawElev = elev[i] ?? minElev;
    heights[i] = (rawElev - minElev) * COORD_SCALE * exaggeration;
    const t = (rawElev - minElev) / elevSpan;
    const [r, g, b] = topoColour(t);
    cR[i] = r;
    cG[i] = g;
    cB[i] = b;
    topEdgePoints.push([wx, heights[i]!, wz]);
  }

  // Helper: build a paired-vertex strip mesh given two XZ tracks (a, b)
  // and per-vertex y values for each. Top and bottom of a wall, or left
  // and right of the ceiling.
  const buildStrip = (
    aX: Float32Array,
    aZ: Float32Array,
    aY: Float32Array,
    bX: Float32Array,
    bZ: Float32Array,
    bY: Float32Array,
  ): THREE.BufferGeometry => {
    const positions = new Float32Array(n * 2 * 3);
    const colors = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 6 + 0] = aX[i]!;
      positions[i * 6 + 1] = aY[i]!;
      positions[i * 6 + 2] = aZ[i]!;
      positions[i * 6 + 3] = bX[i]!;
      positions[i * 6 + 4] = bY[i]!;
      positions[i * 6 + 5] = bZ[i]!;
      const r = cR[i]!;
      const g = cG[i]!;
      const b = cB[i]!;
      colors[i * 6 + 0] = r;
      colors[i * 6 + 1] = g;
      colors[i * 6 + 2] = b;
      colors[i * 6 + 3] = r;
      colors[i * 6 + 4] = g;
      colors[i * 6 + 5] = b;
    }
    const indices: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const aIdx = i * 2;
      const bIdx = i * 2 + 1;
      const cIdx = (i + 1) * 2;
      const dIdx = (i + 1) * 2 + 1;
      indices.push(aIdx, bIdx, cIdx);
      indices.push(bIdx, dIdx, cIdx);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    g.setIndex(indices);
    g.computeVertexNormals();
    return g;
  };

  const zerosY = new Float32Array(n); // ground level for the wall bases
  // Left wall: (leftEdge, Y=0) → (leftEdge, Y=height)
  const leftWall = buildStrip(leftX, leftZ, zerosY, leftX, leftZ, heights);
  // Right wall: (rightEdge, Y=0) → (rightEdge, Y=height)
  const rightWall = buildStrip(rightX, rightZ, zerosY, rightX, rightZ, heights);
  // Top plane: (leftEdge, Y=height) → (rightEdge, Y=height)
  const topPlane = buildStrip(leftX, leftZ, heights, rightX, rightZ, heights);

  // Start-line marker at the centreline's first vertex.
  const startVertex = centreline[0]!;
  const startHeight = heights[0]!;
  const startMarker = {
    base: [startVertex[0], 0, startVertex[2]] as [number, number, number],
    top: [startVertex[0], startHeight, startVertex[2]] as [number, number, number],
  };

  return { leftWall, rightWall, topPlane, topEdgePoints, startMarker };
}

/** Topo-map gradient: blue at the lowest, green-yellow in the middle,
 *  red at the highest. Input is normalised height in [0, 1]. */
function topoColour(t: number): [number, number, number] {
  // 4-stop linear blend: 0 = deep blue, 0.33 = cyan-green, 0.66 = yellow,
  // 1 = red. Mimics standard topographic shading without needing a
  // library colour ramp.
  const clamped = Math.max(0, Math.min(1, t));
  const stops: Array<[number, [number, number, number]]> = [
    [0.0, [0.18, 0.45, 0.95]], // blue
    [0.33, [0.25, 0.85, 0.7]], // teal
    [0.66, [0.95, 0.85, 0.25]], // yellow
    [1.0, [0.95, 0.3, 0.2]], // red
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]!;
    const [t1, c1] = stops[i + 1]!;
    if (clamped <= t1) {
      const span = t1 - t0 || 1;
      const k = (clamped - t0) / span;
      return [
        c0[0] + (c1[0] - c0[0]) * k,
        c0[1] + (c1[1] - c0[1]) * k,
        c0[2] + (c1[2] - c0[2]) * k,
      ];
    }
  }
  return stops[stops.length - 1]![1];
}
