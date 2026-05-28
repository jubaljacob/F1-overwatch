import type { Frame, RaceData } from "@traceline/shared-types";
import { create } from "zustand";

// Playback runs on a wall-clock tick (rAF) that advances `currentTime` by
// `dt * speed`. Frame lookup is a binary search over the frames array; we
// don't index into a 10Hz grid because RaceData may end up sparse (drivers
// drop out, race starts late) and we want to be robust to that.

export type PlaybackSpeed = 0.5 | 1 | 2 | 4;
export const SPEED_OPTIONS: readonly PlaybackSpeed[] = [0.5, 1, 2, 4];

/** Hard cap on the analytics multi-select. >6 lines on a delta chart turns
 *  into spaghetti; the original tool's framing also tops out around here. */
export const MAX_SELECTED_DRIVERS = 6;

interface PlaybackState {
  raceData: RaceData | null;
  currentTime: number;
  isPlaying: boolean;
  speed: PlaybackSpeed;
  /** Drivers currently shown in the analytics charts AND highlighted on the
   *  track. Insertion-ordered. The reference baseline for relative views is
   *  `referenceDriver` (or `selectedDrivers[0]` when that's null). */
  selectedDrivers: number[];
  /** Reference for relative views and the eventual P6 follow-camera target.
   *  Must be a member of `selectedDrivers` or `null`. */
  referenceDriver: number | null;
  /** Driver the 3D viewer's follow-camera is locked to. `null` = free
   *  orbit. Settable independently of `selectedDrivers` so the user can
   *  follow anyone without disturbing the analytics selection. */
  followedDriver: number | null;
  setRaceData: (data: RaceData) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  setSpeed: (s: PlaybackSpeed) => void;
  seek: (t: number) => void;
  stepFrames: (n: number) => void;
  jumpToLap: (lap: number) => void;
  toggleSelectedDriver: (n: number) => void;
  setReferenceDriver: (n: number) => void;
  clearSelection: () => void;
  setFollowedDriver: (n: number | null) => void;
  toggleFollowedDriver: (n: number) => void;
  reset: () => void;
  tick: (dtSeconds: number) => void;
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  raceData: null,
  currentTime: 0,
  isPlaying: false,
  speed: 1,
  selectedDrivers: [],
  referenceDriver: null,
  followedDriver: null,

  setRaceData: (data) =>
    set({
      raceData: data,
      currentTime: data.meta.t_start,
      isPlaying: false,
      selectedDrivers: [],
      referenceDriver: null,
      followedDriver: null,
    }),

  play: () => {
    const { raceData, currentTime } = get();
    if (!raceData) return;
    // Snap to start if we're parked at the end after the chequered flag.
    if (currentTime >= raceData.meta.t_end - 0.001) {
      set({ currentTime: raceData.meta.t_start, isPlaying: true });
    } else {
      set({ isPlaying: true });
    }
  },
  pause: () => set({ isPlaying: false }),
  togglePlay: () => (get().isPlaying ? get().pause() : get().play()),

  setSpeed: (s) => set({ speed: s }),

  seek: (t) => {
    const { raceData } = get();
    if (!raceData) return;
    const clamped = Math.max(raceData.meta.t_start, Math.min(raceData.meta.t_end, t));
    set({ currentTime: clamped });
  },

  stepFrames: (n) => {
    const { raceData, currentTime } = get();
    if (!raceData) return;
    const dt = n / raceData.meta.frame_hz;
    get().seek(currentTime + dt);
  },

  jumpToLap: (lap) => {
    const { raceData } = get();
    if (!raceData) return;
    // Find the earliest frame where any driver has reached the requested lap.
    // We accept whatever t the leader hits first; cleaner than averaging.
    const target = Math.max(1, lap);
    for (const f of raceData.frames) {
      for (const s of Object.values(f.p)) {
        if (s.lap >= target) {
          get().seek(f.t);
          return;
        }
      }
    }
    get().seek(raceData.meta.t_end);
  },

  toggleSelectedDriver: (n) =>
    set((s) => {
      const i = s.selectedDrivers.indexOf(n);
      if (i >= 0) {
        // Remove. If we dropped the reference, fall back to first remaining.
        const next = [...s.selectedDrivers.slice(0, i), ...s.selectedDrivers.slice(i + 1)];
        const nextRef =
          s.referenceDriver === n ? (next[0] ?? null) : (s.referenceDriver ?? null);
        return { selectedDrivers: next, referenceDriver: nextRef };
      }
      // Add. Drop the oldest if we're at the cap — keeps the most recent
      // selections visible without forcing the user to manually deselect.
      const dropped =
        s.selectedDrivers.length >= MAX_SELECTED_DRIVERS ? s.selectedDrivers[0] : undefined;
      const next =
        s.selectedDrivers.length >= MAX_SELECTED_DRIVERS
          ? [...s.selectedDrivers.slice(1), n]
          : [...s.selectedDrivers, n];
      const ref =
        s.referenceDriver === dropped ? (next[0] ?? null) : (s.referenceDriver ?? n);
      return { selectedDrivers: next, referenceDriver: ref };
    }),

  setReferenceDriver: (n) =>
    set((s) => (s.selectedDrivers.includes(n) ? { referenceDriver: n } : {})),

  clearSelection: () => set({ selectedDrivers: [], referenceDriver: null }),

  setFollowedDriver: (n) => set({ followedDriver: n }),
  toggleFollowedDriver: (n) =>
    set((s) => ({ followedDriver: s.followedDriver === n ? null : n })),

  reset: () => {
    const { raceData } = get();
    if (!raceData) return;
    set({ currentTime: raceData.meta.t_start, isPlaying: false });
  },

  tick: (dt) => {
    const { raceData, isPlaying, currentTime, speed } = get();
    if (!raceData || !isPlaying) return;
    const next = currentTime + dt * speed;
    if (next >= raceData.meta.t_end) {
      set({ currentTime: raceData.meta.t_end, isPlaying: false });
    } else {
      set({ currentTime: next });
    }
  },
}));

// Pure helpers ------------------------------------------------------------

/** Binary search for the largest frame index with t <= target. */
export function findFrameIndex(frames: readonly Frame[], target: number): number {
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  if (target <= (frames[0] as Frame).t) return 0;
  if (target >= (frames[hi] as Frame).t) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if ((frames[mid] as Frame).t <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function currentFrame(data: RaceData | null, t: number): Frame | null {
  if (!data || data.frames.length === 0) return null;
  const idx = findFrameIndex(data.frames, t);
  return idx >= 0 ? (data.frames[idx] ?? null) : null;
}

/** Linearly interpolate (x, y) positions between adjacent frames for smoother
 *  rendering at <1x speed. Other fields (lap, status, speed) are taken from
 *  the floor frame — they are categorical or change too slowly to matter at
 *  visual scale. Returns the floor frame untouched if no neighbour exists. */
export function interpolatedFrame(data: RaceData | null, t: number): Frame | null {
  if (!data || data.frames.length === 0) return null;
  const idx = findFrameIndex(data.frames, t);
  if (idx < 0) return null;
  const a = data.frames[idx]!;
  const b = data.frames[idx + 1];
  if (!b) return a;
  const span = b.t - a.t;
  if (span <= 0) return a;
  const alpha = Math.max(0, Math.min(1, (t - a.t) / span));
  if (alpha === 0) return a;

  const p: Frame["p"] = {};
  for (const [num, sa] of Object.entries(a.p)) {
    const sb = b.p[num];
    if (!sb || sa.lap !== sb.lap) {
      // Lap rollover would interpolate across the start/finish — skip.
      p[num] = sa;
      continue;
    }
    p[num] = { ...sa, x: sa.x + (sb.x - sa.x) * alpha, y: sa.y + (sb.y - sa.y) * alpha };
  }
  return { t, p };
}
