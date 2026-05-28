"use client";

/**
 * Stylised track-shape SVG keyed by circuit. Path data is auto-generated
 * from real GPS centrelines (bacinger/f1-circuits, MIT) and projected into
 * a uniform 200×120 viewBox while preserving per-circuit aspect ratio. To
 * regenerate, run `node apps/web/scripts/build-track-paths.mjs`.
 *
 * Circuits not in the map fall back to a generic loop so the UI still
 * renders something — that should only happen if season-data.ts gains a
 * new circuitKey before the path map is rebuilt.
 */

import { TRACK_PATHS } from "@/lib/track-paths";

interface Props {
  circuitKey: string;
  variant?: "outline" | "filled";
  color?: string;
  className?: string;
}

const FALLBACK =
  "M 25 75 C 25 40, 70 30, 110 40 L 160 55 C 180 60, 185 85, 165 95 " +
  "L 110 105 L 60 100 C 30 95, 22 90, 25 75 Z";

export function TrackSketch({
  circuitKey,
  variant = "outline",
  color = "#ffffff",
  className,
}: Props) {
  const d = TRACK_PATHS[circuitKey] ?? FALLBACK;
  const isFilled = variant === "filled";
  return (
    <svg
      viewBox="0 0 200 120"
      className={className ?? "h-full w-full"}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden
    >
      {isFilled ? (
        // "Filled" mode produces the rounded extruded look from the inspo
        // (Monaco shot) by stacking a wide stroke over a slimmer fill of the
        // same color — cheap fake of an extruded 3D ribbon without WebGL.
        <>
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeWidth="22"
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity="0.85"
          />
          <path
            d={d}
            fill="none"
            stroke="#ffffff"
            strokeOpacity="0.15"
            strokeWidth="22"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      ) : (
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeWidth="3.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}
