import type { CircuitGeometry } from "@traceline/shared-types";

export interface Viewport {
  width: number;
  height: number;
  padding: number;
}

export interface Projection {
  toScreen: (x: number, y: number) => [number, number];
  width: number;
  height: number;
}

/** Fit-and-centre projection from circuit (x,y) into a CSS-pixel viewport.
 *  FastF1 Y axis points "up" in world coords; we flip it for canvas. */
export function makeProjection(circuit: CircuitGeometry, vp: Viewport): Projection {
  const pts = circuit.centreline;
  if (pts.length === 0) {
    return { toScreen: () => [vp.width / 2, vp.height / 2], width: vp.width, height: vp.height };
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const availW = vp.width - vp.padding * 2;
  const availH = vp.height - vp.padding * 2;
  const scale = Math.min(availW / w, availH / h);
  const drawW = w * scale;
  const drawH = h * scale;
  const offsetX = (vp.width - drawW) / 2 - minX * scale;
  const offsetY = (vp.height - drawH) / 2 + maxY * scale; // flipped

  return {
    width: vp.width,
    height: vp.height,
    toScreen: (x, y) => [x * scale + offsetX, -y * scale + offsetY],
  };
}
