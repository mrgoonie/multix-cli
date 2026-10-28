#!/usr/bin/env node
/**
 * Turns the head mesh generated with multix (`multix atlas image` → `multix atlas 3d --ref … --format GLB`)
 * into the landing hero's dot-grid point cloud and its no-WebGL posters.
 *
 * Usage (from docs-site/): node scripts/hero/sample-head-points.mjs <head.glb> [--points 20000]
 *
 * Writes to public/hero/:
 * - head-points.bin  little-endian Float32 [x, y, z, region] per point; longest axis in [-1, 1],
 *                    y up, face toward +z. Regions: 0 skin, 1 eyes, 2 ears, 3 mouth, 5 crown.
 * - head-points.json manifest with count, stride, region names and label/pulse anchors.
 * - head-poster-dark.png / head-poster-light.png  transparent front-quarter renders of the same points.
 *
 * Points lie on horizontal contour rings (plane slices of the mesh), which gives the dot-grid look.
 * Landmarks come from the reference image's proportions (bald bust, eyes open, ears visible).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const outDir = fileURLToPath(new URL("../../public/hero/", import.meta.url));

// ---------- GLB parsing (single mesh, uncompressed, node rotation applied) ----------

function readGlb(path) {
  const buf = readFileSync(path);
  const jsonLength = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLength).toString("utf8"));
  const binStart = 20 + jsonLength + 8;
  const view = (accessorIndex) => {
    const accessor = gltf.accessors[accessorIndex];
    const bufferView = gltf.bufferViews[accessor.bufferView];
    const offset = binStart + (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const components = { SCALAR: 1, VEC3: 3 }[accessor.type];
    const length = accessor.count * components;
    const bytes = buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + length * 4);
    if (accessor.componentType === 5126) return new Float32Array(bytes);
    if (accessor.componentType === 5125) return new Uint32Array(bytes);
    if (accessor.componentType === 5123) {
      return new Uint16Array(
        buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + offset + length * 2),
      );
    }
    throw new Error(`unsupported component type ${accessor.componentType}`);
  };
  const node = gltf.nodes.find((n) => n.mesh === 0) ?? {};
  const primitive = gltf.meshes[0].primitives[0];
  if (primitive.extensions && Object.keys(primitive.extensions).length > 0) {
    throw new Error("compressed primitives are not supported; export the GLB without Draco");
  }
  return {
    positions: view(primitive.attributes.POSITION),
    indices: view(primitive.indices),
    rotation: node.rotation,
  };
}

function rotate([qx, qy, qz, qw], [x, y, z]) {
  // v' = v + 2w(q×v) + 2(q×(q×v))
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [
    x + qw * tx + (qy * tz - qz * ty),
    y + qw * ty + (qz * tx - qx * tz),
    z + qw * tz + (qx * ty - qy * tx),
  ];
}

/** World-space vertices, centred, longest axis scaled to [-1, 1], face turned toward +z. */
function normalisedVertices({ positions, rotation }) {
  const count = positions.length / 3;
  const v = new Float32Array(positions.length);
  for (let i = 0; i < count; i++) {
    const p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    const r = rotation ? rotate(rotation, p) : p;
    v.set(r, i * 3);
  }
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < v.length; i++) {
    min[i % 3] = Math.min(min[i % 3], v[i]);
    max[i % 3] = Math.max(max[i % 3], v[i]);
  }
  const centre = min.map((m, a) => (m + max[a]) / 2);
  const scale = 2 / Math.max(...max.map((m, a) => m - min[a]));
  for (let i = 0; i < v.length; i++) v[i] = (v[i] - centre[i % 3]) * scale;
  // The neck sits behind the face: compare the neck's mean depth with the skull's to find the back.
  // (Forehead, nose and the back of the skull protrude about equally, so "most protruding" is unreliable.)
  const meanZ = (lo, hi) => {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const y = v[i * 3 + 1];
      if (y > lo && y < hi) {
        sum += v[i * 3 + 2];
        n++;
      }
    }
    return sum / Math.max(1, n);
  };
  const neckTowardPositiveZ = meanZ(-0.75, -0.5) > meanZ(0.1, 0.6);
  if (neckTowardPositiveZ)
    for (let i = 0; i < count; i++) {
      v[i * 3] = -v[i * 3];
      v[i * 3 + 2] = -v[i * 3 + 2];
    }
  return v;
}

// ---------- contour-ring sampling ----------

function sliceRings(v, indices, levels, spacing) {
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < v.length; i += 3) {
    yMin = Math.min(yMin, v[i]);
    yMax = Math.max(yMax, v[i]);
  }
  const points = [];
  const normals = [];
  const step = (yMax - yMin) / (levels + 1);
  for (let l = 1; l <= levels; l++) {
    const y = yMin + l * step;
    // Fractional dots carried across segments keep short segments (dense mesh areas) from losing dots.
    let carry = 0;
    for (let t = 0; t < indices.length; t += 3) {
      const corners = [indices[t], indices[t + 1], indices[t + 2]].map((k) => [
        v[k * 3],
        v[k * 3 + 1],
        v[k * 3 + 2],
      ]);
      const crossings = [];
      for (let e = 0; e < 3; e++) {
        const a = corners[e];
        const b = corners[(e + 1) % 3];
        if ((a[1] - y) * (b[1] - y) < 0) {
          const f = (y - a[1]) / (b[1] - a[1]);
          crossings.push([a[0] + f * (b[0] - a[0]), y, a[2] + f * (b[2] - a[2])]);
        }
      }
      if (crossings.length !== 2) continue;
      const [a, b] = crossings;
      const normal = outwardNormal(corners);
      // Dots sit at segment midpoints of an even split; endpoints are skipped so neighbours never double up.
      carry += Math.hypot(b[0] - a[0], b[2] - a[2]) / spacing;
      const n = Math.floor(carry);
      carry -= n;
      for (let k = 0; k < n; k++) {
        const c = (k + 0.5) / n;
        points.push([a[0] + c * (b[0] - a[0]), y, a[2] + c * (b[2] - a[2])]);
        normals.push(normal);
      }
    }
  }
  return { points, normals, yMin, yMax };
}

/** Triangle normal, flipped to point away from the vertical axis (used to shade the posters). */
function outwardNormal([p, q, r]) {
  const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
  let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const length = Math.hypot(...n) || 1;
  n = n.map((c) => c / length);
  return n[0] * p[0] + n[2] * p[2] < 0 ? n.map((c) => -c) : n;
}

// ---------- landmarks and regions ----------

/** Reference-image proportions, measured from the top of the skull down to the bust's cut. */
const PROPORTION = { eyes: 0.334, ears: 0.427, mouth: 0.563, crownBelow: 0.16, eyeX: 0.39 };

function surfaceFront(points, x, y, radius = 0.05) {
  let best = Number.NEGATIVE_INFINITY;
  for (const p of points)
    if (Math.abs(p[0] - x) < radius && Math.abs(p[1] - y) < radius) best = Math.max(best, p[2]);
  return best;
}

function anchorsFor(points, yMin, yMax) {
  const yAt = (t) => yMax - t * (yMax - yMin);
  let xMax = 0;
  for (const p of points)
    if (Math.abs(p[1] - yAt(PROPORTION.ears)) < 0.06) xMax = Math.max(xMax, p[0]);
  const eyeX = PROPORTION.eyeX * xMax;
  const eyes = [eyeX, yAt(PROPORTION.eyes), surfaceFront(points, eyeX, yAt(PROPORTION.eyes))];
  const mouth = [0, yAt(PROPORTION.mouth), surfaceFront(points, 0, yAt(PROPORTION.mouth))];
  const earY = yAt(PROPORTION.ears);
  const earPoints = points.filter((p) => p[0] > xMax * 0.88 && Math.abs(p[1] - earY) < 0.12);
  const earZ = earPoints.reduce((s, p) => s + p[2], 0) / Math.max(1, earPoints.length);
  const ears = [xMax, earY, earZ];
  const crown = [0, yMax - 0.04, 0];
  return { eyes, ears, mouth, crown, crownY: yAt(PROPORTION.crownBelow) };
}

function regionOf([x, y, z], a) {
  const near = (p, q, r) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < r;
  if (near([Math.abs(x), y, z], a.eyes, 0.11)) return 1;
  if (near([Math.abs(x), y, z], a.ears, 0.17)) return 2;
  if (near([x, y, z], a.mouth, 0.12)) return 3;
  if (y > a.crownY) return 5;
  return 0;
}

// ---------- poster rendering (transparent PNG, no dependencies) ----------

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(width, height, rgba) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Same camera as the hero at rest: slight turn and tilt, perspective from distance 4.3. */
/** `ink` posters (dark dots on a light page) put more ink where light falls away, like an engraving. */
function renderPoster(points, normals, [r, g, b], { ink = false } = {}, size = 900) {
  const light = [-0.45, 0.55, 0.7].map((c, _, l) => c / Math.hypot(...l));
  const alpha = new Float32Array(size * size);
  const yaw = -0.35;
  const pitch = 0.08;
  for (let i = 0; i < points.length; i++) {
    let [x, y, z] = points[i];
    const n = normals[i];
    const lambert = Math.max(0, n[0] * light[0] + n[1] * light[1] + n[2] * light[2]);
    [x, z] = [x * Math.cos(yaw) + z * Math.sin(yaw), -x * Math.sin(yaw) + z * Math.cos(yaw)];
    [y, z] = [y * Math.cos(pitch) - z * Math.sin(pitch), y * Math.sin(pitch) + z * Math.cos(pitch)];
    const w = 4.3 - z;
    // Framed so the bust fills about 90% of the poster height.
    const sx = (x / w) * 4.3 * 0.45 * size + size / 2;
    const sy = (-y / w) * 4.3 * 0.45 * size + size / 2;
    const depth = Math.min(1, Math.max(0, (z + 1) / 2));
    const shade = ink ? 1 - lambert * 0.85 : Math.min(1, 0.3 + 1.05 * lambert);
    const intensity = shade * (0.35 + 0.65 * depth);
    const radius = 1.3 + depth * 1.1;
    for (let py = Math.floor(sy - radius); py <= sy + radius; py++) {
      for (let px = Math.floor(sx - radius); px <= sx + radius; px++) {
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const d = Math.hypot(px + 0.5 - sx, py + 0.5 - sy);
        if (d < radius) alpha[py * size + px] += intensity * Math.min(1, radius - d);
      }
    }
  }
  const rgba = Buffer.alloc(size * size * 4);
  for (let i = 0; i < alpha.length; i++)
    rgba.set([r, g, b, Math.round(Math.min(1, alpha[i]) * 255)], i * 4);
  return png(size, size, rgba);
}

// ---------- main ----------

const [glbPath, ...rest] = process.argv.slice(2);
if (!glbPath) {
  console.error("usage: node scripts/hero/sample-head-points.mjs <head.glb> [--points 20000]");
  process.exit(1);
}
const target = Number(rest[rest.indexOf("--points") + 1]) || 20000;

const mesh = readGlb(glbPath);
const vertices = normalisedVertices(mesh);
const levels = 130;
let spacing = 0.02;
let sample = sliceRings(vertices, mesh.indices, levels, spacing);
// One correction pass: dot count scales with 1/spacing along the rings.
spacing *= sample.points.length / target;
sample = sliceRings(vertices, mesh.indices, levels, spacing);

const anchors = anchorsFor(sample.points, sample.yMin, sample.yMax);
const regions = sample.points.map((p) => regionOf(p, anchors));
const data = new Float32Array(sample.points.length * 4);
sample.points.forEach((p, i) => data.set([...p, regions[i]], i * 4));

const round = (p) => p.map((n) => Math.round(n * 1000) / 1000);
const manifest = {
  version: 1,
  count: sample.points.length,
  stride: 4,
  regions: { 0: "skin", 1: "eyes", 2: "ears", 3: "mouth", 5: "crown" },
  anchors: {
    eyes: round(anchors.eyes),
    ears: round(anchors.ears),
    mouth: round(anchors.mouth),
    crown: round(anchors.crown),
  },
  source:
    "multix atlas image → multix atlas 3d (tencent/hunyuan3d-rapid/image-to-3d), sampled by scripts/hero/sample-head-points.mjs",
};

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}head-points.bin`, Buffer.from(data.buffer));
// Short number arrays stay on one line, as Biome formats them, so a rerun leaves lint clean.
const manifestJson = JSON.stringify(manifest, null, 2).replace(
  /\[\s+([-\d.,\s]+?)\s+\]/g,
  (_, items) => `[${items.split(/,\s*/).join(", ")}]`,
);
writeFileSync(`${outDir}head-points.json`, `${manifestJson}\n`);
writeFileSync(
  `${outDir}head-poster-dark.png`,
  renderPoster(sample.points, sample.normals, [235, 240, 248]),
);
writeFileSync(
  `${outDir}head-poster-light.png`,
  renderPoster(sample.points, sample.normals, [18, 20, 26], { ink: true }),
);

const counts = {};
for (const r of regions) counts[r] = (counts[r] ?? 0) + 1;
console.log(
  `points ${sample.points.length}, regions ${JSON.stringify(counts)}, anchors ${JSON.stringify(manifest.anchors)}`,
);
