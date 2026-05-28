"use client";

/**
 * Decorative looping track render for the left side of the landing page.
 *
 * Intentionally lightweight: a stylised SVG circuit silhouette (Monaco-inspired
 * curves) with a single light marker travelling around it via SVG
 * `<animateMotion>`. No data dependency, no Canvas/WebGL — survives SSR and
 * costs nothing on idle. Swap to a real recorded clip later.
 */

import { useEffect, useState } from "react";

const TRACK_PATH =
  "M 80 320 C 80 200, 160 160, 280 160 L 480 160 C 560 160, 600 200, 600 260 " +
  "C 600 320, 560 360, 480 360 L 360 360 C 320 360, 300 380, 300 420 " +
  "C 300 460, 320 480, 360 480 L 520 480 C 600 480, 640 460, 660 420 " +
  "L 700 320 C 720 240, 680 160, 620 100 " +
  "C 540 40, 380 40, 240 60 C 120 80, 60 160, 80 320 Z";

export function AnimatedTrackPreview() {
  // Mount gate: `<animateMotion>` paints inconsistently between SSR and
  // hydration in some browsers; defer to client paint to avoid the flash.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Radial wash anchored top-right — same vibe as the inspo hero. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 75% 20%, rgba(255,30,0,0.35), transparent 55%), " +
            "radial-gradient(circle at 20% 80%, rgba(31,61,240,0.18), transparent 55%)",
        }}
      />

      {/* Soft drifting grid for depth. */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage:
            "linear-gradient(to right, #ffffff 1px, transparent 1px), " +
            "linear-gradient(to bottom, #ffffff 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      <svg
        viewBox="0 0 800 600"
        className="relative h-full w-full"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden
      >
        <defs>
          <linearGradient id="track-stroke" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ff1e00" stopOpacity="0.95" />
            <stop offset="60%" stopColor="#ff5a1f" stopOpacity="0.8" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.65" />
          </linearGradient>
          <filter id="track-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Track outline — thick muted stroke for the silhouette. */}
        <path
          d={TRACK_PATH}
          fill="none"
          stroke="rgba(255,255,255,0.16)"
          strokeWidth="34"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Coloured racing-line overlay. */}
        <path
          d={TRACK_PATH}
          fill="none"
          stroke="url(#track-stroke)"
          strokeWidth="10"
          strokeLinejoin="round"
          strokeLinecap="round"
          filter="url(#track-glow)"
          strokeDasharray="14 18"
        />

        {/* Moving marker — uses the same path. */}
        {mounted && (
          <g>
            <circle r="11" fill="#ffffff" filter="url(#track-glow)">
              <animateMotion dur="12s" repeatCount="indefinite" path={TRACK_PATH} />
            </circle>
            <circle r="6" fill="#ff1e00">
              <animateMotion dur="12s" repeatCount="indefinite" path={TRACK_PATH} />
            </circle>
          </g>
        )}

        {/* Trailing ghost marker, offset along the path for depth. */}
        {mounted && (
          <circle r="4" fill="rgba(255,255,255,0.45)">
            <animateMotion
              dur="12s"
              repeatCount="indefinite"
              path={TRACK_PATH}
              begin="-0.8s"
            />
          </circle>
        )}
      </svg>

      {/* Bottom-left brand mark. */}
      <div className="absolute bottom-8 left-8 flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.5em] text-white/50">
          F1Overwatch
        </span>
        <span className="text-3xl font-black tracking-tight text-white">
          See every lap.
        </span>
        <span className="text-3xl font-black tracking-tight text-white/60">
          Replay every move.
        </span>
      </div>
    </div>
  );
}
