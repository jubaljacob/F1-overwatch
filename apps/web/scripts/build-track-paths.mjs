/**
 * Build accurate SVG track-sketch paths for every 2026 GP.
 *
 * Source: bacinger/f1-circuits (MIT) — a community-maintained GeoJSON
 * dataset of every F1 circuit, traced from satellite imagery.
 *
 * For each circuit we:
 *   1. Fetch the GeoJSON `LineString` of the track centreline.
 *   2. Project [lon, lat] → flat metres using equirectangular at the
 *      circuit's centroid latitude. Good enough at circuit scales (<10 km).
 *   3. Fit into a 200×120 viewBox while preserving aspect ratio.
 *   4. Emit an SVG path string (M x y L x y …).
 *
 * Output: apps/web/lib/track-paths.ts — a typed `Record<circuitKey,string>`.
 *
 * Run with: node apps/web/scripts/build-track-paths.mjs
 */

import { writeFileSync } from "node:fs";

const BASE =
  "https://raw.githubusercontent.com/bacinger/f1-circuits/master/circuits/";

// Mapping from our internal circuitKey (used in season-data.ts) → bacinger
// file slug. Keep in sync with SCHEDULE_2026.
const CIRCUITS = {
  bahrain: "bh-2002",
  jeddah: "sa-2021",
  melbourne: "au-1953",
  suzuka: "jp-1962",
  miami: "us-2022",
  monaco: "mc-1929",
  barcelona: "es-1991",
  redbullring: "at-1969",
  silverstone: "gb-1948",
  hungaroring: "hu-1986",
  spa: "be-1925",
  zandvoort: "nl-1948",
  monza: "it-1922",
  baku: "az-2016",
  singapore: "sg-2008",
  austin: "us-2012",
  mexico: "mx-1962",
  interlagos: "br-1940",
  lasvegas: "us-2023",
  lusail: "qa-2004",
  yasmarina: "ae-2009",
};

const VIEW_W = 200;
const VIEW_H = 120;
const PADDING = 10; // px inside the viewBox

/** Project a list of [lon, lat] points to flat metres via equirectangular.
 *  At circuit scales the distortion vs. UTM is negligible (<0.1%). */
function projectToMetres(coords) {
  const latMean =
    coords.reduce((s, [, lat]) => s + lat, 0) / coords.length;
  const cosLat = Math.cos((latMean * Math.PI) / 180);
  const R = 6_378_137; // WGS84 equatorial radius (m)
  return coords.map(([lon, lat]) => [
    ((lon * Math.PI) / 180) * R * cosLat,
    // SVG y increases downward, so flip latitude.
    -((lat * Math.PI) / 180) * R,
  ]);
}

function fitToViewBox(points) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const availW = VIEW_W - PADDING * 2;
  const availH = VIEW_H - PADDING * 2;
  const scale = Math.min(availW / w, availH / h);
  // Centre within the viewBox.
  const offsetX = (VIEW_W - w * scale) / 2 - minX * scale;
  const offsetY = (VIEW_H - h * scale) / 2 - minY * scale;
  return points.map(([x, y]) => [
    x * scale + offsetX,
    y * scale + offsetY,
  ]);
}

/** Round to 1 decimal to keep the emitted path compact. */
function fmt(n) {
  // toFixed(1) then strip trailing ".0" for terseness ("12" not "12.0").
  const s = n.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function toSvgPath(points) {
  if (points.length === 0) return "";
  const head = `M ${fmt(points[0][0])} ${fmt(points[0][1])}`;
  const rest = points
    .slice(1)
    .map(([x, y]) => `L ${fmt(x)} ${fmt(y)}`)
    .join(" ");
  // bacinger linestrings end at the start point already; appending Z just
  // closes any tiny gap from coordinate rounding.
  return `${head} ${rest} Z`;
}

async function fetchOne(slug) {
  const url = `${BASE}${slug}.geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${slug}: HTTP ${res.status}`);
  const geo = await res.json();
  const feat = geo.features?.[0];
  if (!feat) throw new Error(`${slug}: no features`);
  const geom = feat.geometry;
  let coords;
  if (geom.type === "LineString") coords = geom.coordinates;
  else if (geom.type === "MultiLineString") {
    // Pick the longest segment — usually the main loop, with pit-lane spurs
    // discarded.
    coords = geom.coordinates.reduce((best, c) =>
      c.length > best.length ? c : best,
    );
  } else if (geom.type === "Polygon") {
    coords = geom.coordinates[0];
  } else {
    throw new Error(`${slug}: unsupported geometry ${geom.type}`);
  }
  return coords;
}

async function main() {
  const out = {};
  for (const [key, slug] of Object.entries(CIRCUITS)) {
    process.stdout.write(`  ${key.padEnd(14)} ← ${slug} ... `);
    try {
      const coords = await fetchOne(slug);
      const projected = projectToMetres(coords);
      const fitted = fitToViewBox(projected);
      out[key] = toSvgPath(fitted);
      console.log(`${coords.length} pts`);
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
  }

  const banner = `/**
 * AUTO-GENERATED — do not edit by hand.
 * Source: bacinger/f1-circuits (MIT). Regenerate via
 *   node apps/web/scripts/build-track-paths.mjs
 * The script fetches the latest GeoJSON, projects each circuit's
 * LineString to a 200×120 SVG viewBox with 10 px padding, and emits the
 * "d" attribute below. Aspect ratio is preserved per-circuit.
 */
`;
  const body = `export const TRACK_PATHS: Record<string, string> = ${JSON.stringify(
    out,
    null,
    2,
  )};\n`;
  writeFileSync("apps/web/lib/track-paths.ts", banner + "\n" + body);
  console.log(`\nWrote ${Object.keys(out).length} paths to apps/web/lib/track-paths.ts`);
}

main();
