import { useEffect } from "react";
import { usePlaybackStore } from "./playback-store";

/** Drives the playback store with a requestAnimationFrame tick.
 *  We *always* run the rAF loop while the component is mounted; the store
 *  decides whether to advance time. Skipping the loop when paused would mean
 *  the very next play() has to wait a frame for catch-up. */
export function usePlaybackClock() {
  const tick = usePlaybackStore((s) => s.tick);

  useEffect(() => {
    let raf = 0;
    let prev = performance.now();
    const loop = (now: number) => {
      const dt = (now - prev) / 1000;
      prev = now;
      // Cap dt so tab-switch resumes don't fast-forward seconds at once.
      tick(Math.min(dt, 0.1));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [tick]);
}

/** Spacebar = play/pause, ←/→ = step 1 frame, Shift+←/→ = 1 second. */
export function usePlaybackKeybindings() {
  const togglePlay = usePlaybackStore((s) => s.togglePlay);
  const stepFrames = usePlaybackStore((s) => s.stepFrames);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        stepFrames(e.shiftKey ? -10 : -1);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        stepFrames(e.shiftKey ? 10 : 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, stepFrames]);
}
