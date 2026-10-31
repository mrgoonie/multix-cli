#!/usr/bin/env node
/**
 * Bakes the landing hero from a head mesh: a cloud of halftone dots all around the head, and the
 * static SVG of its first frame. Dots sit on horizontal rings of the surface, evenly spaced along
 * each ring, so the grid wraps the form. Each dot keeps its surface normal and ambient occlusion;
 * src/scripts/landing/head-cloud.ts lights and hides them for any turn of the head, here for the
 * SVG and in the browser for the spinning canvas.
 *
 * Usage (from docs-site/): node scripts/hero/draw-head-dots.mjs --mesh <head.glb>
 * The mesh is not kept in the repository; its frame has the face toward +y and the crown toward -z.
 *
 * Writes:
 * - public/hero/head-cloud.bin, the dot cloud loaded by the canvas;
 * - src/components/landing/head-dots.svg (inlined by landing-hero.astro, shown without JS):
 *   #mx-dots holds one path per dot size (each dot is a round-capped `h0`; its size is `--w`, times
 *   `--k` when CSS swells it), then the same dots per sense in groups .mx-r-eyes / -ears / -mouth / -crown,
 *   shown when the senses unlock, then the sense ornaments (.mx-fx-*): eye glints, sound arcs at
 *   the ear and mouth, crown sparks;
 * - src/components/landing/head-anchors.json, where each sense's label sits, in percent.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CROWN_SHARE,
  SENSES,
  SENSE_NAMES,
  SIZE,
  SPARKS,
  WAVES,
  YAW,
  cellOf,
  createFrame,
  decodeCloud,
  dotSize,
  encodeCloud,
  normalize,
  project,
  senseMarks,
} from "../../src/scripts/landing/head-cloud.ts";
import { readGlb } from "./read-glb.mjs";

const { values: args } = parseArgs({ options: { mesh: { type: "string" } } });
if (!args.mesh) {
  console.error("usage: node scripts/hero/draw-head-dots.mjs --mesh <head.glb>");
  process.exit(1);
}
const site = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));

const RINGS = 100;
const SIZES = 8; // dot sizes in the SVG, one path each

// ---------- mesh in the head frame: x right, y up, z toward the face ----------

const { positions, indices } = readGlb(args.mesh);
const count = positions.length / 3;
const P = new Float64Array(count * 3);
for (let i = 0; i < count; i++) {
  P[i * 3] = positions[i * 3];
  P[i * 3 + 1] = -positions[i * 3 + 2];
  P[i * 3 + 2] = positions[i * 3 + 1];
}
const vertex = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];

// Smooth vertex normals, turned outward. Vertices split along a texture seam share a position;
// weld them so the normals blend across the seam instead of leaving a lit line on the head.
const weld = new Uint32Array(count);
const firstAt = new Map();
for (let i = 0; i < count; i++) {
  const key = [0, 1, 2].map((k) => Math.round(P[i * 3 + k] * 1e5)).join();
  if (!firstAt.has(key)) firstAt.set(key, i);
  weld[i] = firstAt.get(key);
}
const N = new Float64Array(count * 3);
for (let t = 0; t < indices.length; t += 3) {
  const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map(vertex);
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ];
  for (let q = t; q < t + 3; q++) for (let k = 0; k < 3; k++) N[weld[indices[q]] * 3 + k] += n[k];
}
for (let i = 0; i < count; i++) N.copyWithin(i * 3, weld[i] * 3, weld[i] * 3 + 3);
let outward = 0;
for (let i = 0; i < count; i++) {
  const n = normalize([N[i * 3], N[i * 3 + 1], N[i * 3 + 2]]);
  N.set(n, i * 3);
  outward += n[0] * P[i * 3] + n[2] * P[i * 3 + 2];
}
if (outward < 0) for (let i = 0; i < N.length; i++) N[i] = -N[i];

let minY = Number.POSITIVE_INFINITY;
let maxY = Number.NEGATIVE_INFINITY;
for (let i = 0; i < count; i++) {
  minY = Math.min(minY, P[i * 3 + 1]);
  maxY = Math.max(maxY, P[i * 3 + 1]);
}

// ---------- cylindrical unwrap: the outermost surface per (angle, height), with its normal ----------

const TURN = 2048;
const HEIGHT = 1024;
const radius = new Float64Array(TURN * HEIGHT).fill(-1);
const normalAt = new Float32Array(TURN * HEIGHT * 3);
const rowOf = (h) => ((maxY - h) / (maxY - minY)) * (HEIGHT - 1);
const cylinder = (i) => [
  Math.atan2(P[i * 3], P[i * 3 + 2]),
  P[i * 3 + 1],
  Math.hypot(P[i * 3], P[i * 3 + 2]),
];
for (let t = 0; t < indices.length; t += 3) {
  const ids = [indices[t], indices[t + 1], indices[t + 2]];
  const c = ids.map(cylinder);
  const angles = c.map((q) => q[0]);
  // A triangle across the seam at the back (angle ±π) is drawn twice, once at each edge.
  const seam = Math.max(...angles) - Math.min(...angles) > Math.PI;
  for (const shift of seam ? [0, -TURN] : [0]) {
    const unwrapped = c.map(([a, h, r]) => [seam && a < 0 ? a + 2 * Math.PI : a, h, r]);
    rasterize(ids, unwrapped, shift);
  }
}

/** Keeps the outermost surface of one triangle in the unwrap, with its interpolated normal. */
function rasterize(ids, c, shift) {
  const [[ax, ay], [bx, by], [cx, cy]] = c.map(([a, h]) => [
    ((a + Math.PI) / (2 * Math.PI)) * TURN + shift,
    rowOf(h),
  ]);
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-9) return;
  const y1 = Math.min(HEIGHT - 1, Math.ceil(Math.max(ay, by, cy)));
  const x1 = Math.min(TURN - 1, Math.ceil(Math.max(ax, bx, cx)));
  for (let y = Math.max(0, Math.floor(Math.min(ay, by, cy))); y <= y1; y++) {
    for (let x = Math.max(0, Math.floor(Math.min(ax, bx, cx))); x <= x1; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
      const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -0.01 || w1 < -0.01 || w2 < -0.01) continue;
      const r = w0 * c[0][2] + w1 * c[1][2] + w2 * c[2][2];
      const k = y * TURN + x;
      if (r <= radius[k]) continue;
      radius[k] = r;
      for (let q = 0; q < 3; q++) {
        normalAt[k * 3 + q] =
          w0 * N[ids[0] * 3 + q] + w1 * N[ids[1] * 3 + q] + w2 * N[ids[2] * 3 + q];
      }
    }
  }
}

/** Ambient occlusion from the unwrap: how far the neighbourhood stands proud of this point. */
const AO_REACH = 0.016; // head-frame units
function occlusion(row, col) {
  const r = radius[row * TURN + col];
  const reachRows = (AO_REACH / (maxY - minY)) * (HEIGHT - 1);
  const reachCols = (AO_REACH / Math.max(r, 0.05) / (2 * Math.PI)) * TURN;
  let occluded = 0;
  let samples = 0;
  for (let s = 0; s < 16; s++) {
    const angle = (s / 16) * Math.PI * 2;
    const reach = 0.4 + (0.6 * ((s * 7) % 16)) / 16;
    const rr = Math.round(row + Math.sin(angle) * reachRows * reach);
    const cc = (Math.round(col + Math.cos(angle) * reachCols * reach) + TURN) % TURN;
    if (rr < 0 || rr >= HEIGHT) continue;
    const neighbour = radius[rr * TURN + cc];
    if (neighbour < 0) continue;
    occluded += Math.max(0, Math.min(1, (neighbour - r) / AO_REACH));
    samples++;
  }
  return 1 - (samples ? occluded / samples : 0);
}

function senseOf([x, y, z]) {
  for (const [i, name] of ["eyes", "ears", "mouth"].entries()) {
    const { centre, radius: r } = SENSES[name];
    if (Math.hypot(Math.abs(x) - centre[0], y - centre[1], z - centre[2]) < r) return i + 1;
  }
  return y > maxY - (maxY - minY) * CROWN_SHARE ? SENSE_NAMES.indexOf("crown") + 1 : 0;
}

// ---------- the cloud: dots evenly spaced by arc length round each ring ----------

const gap = (maxY - minY) / RINGS;
const rings = [];
for (let ring = 0; ring < RINGS; ring++) {
  const y = maxY - gap * (ring + 0.5); // the height head-cloud.ts decodes
  const row = Math.round(rowOf(y));
  const pointAt = (col) => {
    const r = radius[row * TURN + col];
    const angle = ((col + 0.5) / TURN) * 2 * Math.PI - Math.PI;
    return r < 0 ? null : [Math.sin(angle) * r, y, Math.cos(angle) * r, angle, r];
  };
  const step = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : 0);
  // Arc length at each column, then the join back to the first: the ring is closed.
  const along = new Float64Array(TURN);
  for (let col = 1; col < TURN; col++)
    along[col] = along[col - 1] + step(pointAt(col - 1), pointAt(col));
  const length = along[TURN - 1] + step(pointAt(TURN - 1), pointAt(0));
  // A whole number of dots per ring, evenly spaced all the way round, so the back has no seam.
  const n = Math.max(1, Math.round(length / gap));
  const spacing = length / n;
  const dots = [];
  let col = 0;
  for (let i = 0; i < n; i++) {
    const s = (i + (ring % 2 ? 0.5 : 0)) * spacing; // odd rings sit half a gap round
    while (col < TURN - 1 && along[col + 1] <= s) col++;
    // Nearest surface column at or around this arc length.
    const next = Math.min(col + 1, TURN - 1);
    const pick = s - along[col] <= along[next] - s ? col : next;
    const p = pointAt(pick);
    if (!p) continue;
    const [, , , angle, r] = p;
    const k = (row * TURN + pick) * 3;
    dots.push({
      angle,
      radius: r,
      normal: normalize([normalAt[k], normalAt[k + 1], normalAt[k + 2]]),
      occlusion: occlusion(row, pick),
      sense: senseOf(p),
    });
  }
  rings.push({ y, dots });
}
const bin = encodeCloud(rings, minY, maxY);
writeFileSync(site("public/hero/head-cloud.bin"), bin);

// ---------- the static SVG: the decoded cloud's first frame ----------

const cloud = decodeCloud(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const frame = project(cloud, YAW, createFrame(cloud));
const fmt = (n) => Number(n.toFixed(1));
const cell = cellOf(cloud);
const widthOf = (size) => fmt(dotSize(cell, (size + 0.5) / SIZES));

/** Dots as one path: relative moves keep it small, `h0` with a round cap draws each dot. */
function dotPath(points) {
  let x = 0;
  let y = 0;
  return points
    .map(([px, py]) => {
      [px, py] = [fmt(px), fmt(py)];
      const step = `${x || y ? "m" : "M"}${fmt(x || y ? px - x : px)} ${fmt(x || y ? py - y : py)}h0`;
      [x, y] = [px, py];
      return step;
    })
    .join("")
    .replace(/ -/g, "-");
}

const bySize = Array.from({ length: SIZES }, () => []);
const bySense = SENSE_NAMES.map(() => Array.from({ length: SIZES }, () => []));
for (let n = 0; n < frame.visible; n++) {
  const size = Math.min(SIZES - 1, Math.floor(frame.light[n] * SIZES));
  const point = [frame.x[n], frame.y[n]];
  bySize[size].push(point);
  const sense = cloud.sense[frame.index[n]];
  if (sense) bySense[sense - 1][size].push(point);
}
const sizedPaths = (sizes) =>
  sizes
    .map((points, i) =>
      points.length
        ? `<path style="--w:${widthOf(i)};stroke-width:calc(var(--w)*var(--k,1))" d="${dotPath(points)}"/>`
        : "",
    )
    .join("");

const marks = senseMarks(cloud, YAW);
/** Three arcs around `c`, opening toward the angle `out`. */
function arcs({ at: c, out }, { radii, spread }) {
  return radii
    .map((r, i) => {
      const p0 = [c[0] + Math.cos(out - spread) * r, c[1] + Math.sin(out - spread) * r];
      const p1 = [c[0] + Math.cos(out + spread) * r, c[1] + Math.sin(out + spread) * r];
      return `<path class="mx-fx-wave" style="--i:${i}" d="M${fmt(p0[0])} ${fmt(p0[1])}A${r} ${r} 0 0 1 ${fmt(p1[0])} ${fmt(p1[1])}"/>`;
    })
    .join("");
}
const sparks = SPARKS.map(([dx, dy, r], i) => {
  const [x, y] = [fmt(marks.crown[0] + dx), fmt(marks.crown[1] + dy)];
  return `<path class="mx-fx-spark" style="--i:${i}" d="M${x} ${fmt(y - r)}V${fmt(y + r)}M${fmt(x - r)} ${y}H${fmt(x + r)}"/>`;
}).join("");

const svg = [
  `<svg class="mx-head" viewBox="0 0 ${SIZE} ${SIZE}" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true" focusable="false">`,
  `<g id="mx-dots">${sizedPaths(bySize)}${SENSE_NAMES.map((name, i) => `<g class="mx-r mx-r-${name}">${sizedPaths(bySense[i])}</g>`).join("")}</g>`,
  `<g class="mx-fx mx-fx-eyes">${marks.eyes.map(([x, y]) => `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="2.6"/>`).join("")}</g>`,
  `<g class="mx-fx mx-fx-ears">${marks.ear ? arcs(marks.ear, WAVES.ears) : ""}</g>`,
  `<g class="mx-fx mx-fx-mouth">${marks.mouth ? arcs(marks.mouth, WAVES.mouth) : ""}</g>`,
  `<g class="mx-fx mx-fx-crown">${sparks}</g>`,
  "</svg>",
].join("");
writeFileSync(site("src/components/landing/head-dots.svg"), `${svg}\n`);

// Labels, as a percentage of the stage, on one line the way Biome formats it.
const anchors = Object.entries(marks.labels)
  .map(([name, at]) => `"${name}": [${at.map((c) => fmt((c / SIZE) * 100)).join(", ")}]`)
  .join(", ");
writeFileSync(site("src/components/landing/head-anchors.json"), `{ ${anchors} }\n`);
console.log(
  `${cloud.count} dots in the cloud (${bin.length} bytes), ${frame.visible} in the SVG (${svg.length} bytes)`,
);
