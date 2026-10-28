/**
 * The hero head as a cloud of halftone dots, shared by the build-time SVG generator
 * (scripts/hero/draw-head-dots.mjs) and the spinning canvas (head-spin.ts), so the static
 * picture is exactly the canvas's first frame.
 *
 * Head frame: x right, y up, z toward the face; the head turns about the y axis. The dots lie
 * on horizontal rings around that axis, so a cloud is stored per ring:
 *   Float32 minY, maxY, maxR | Uint16 rings, then the dot count of each ring |
 *   Uint16 angle step from the previous dot (the ring's first is absolute) | Uint16 radius |
 *   Int8 ×2 octahedral normal | Uint8 ambient occlusion (high 5 bits) and sense (low 3 bits).
 * Plain erasable TypeScript, so Node can run it directly.
 */

export const SIZE = 400; // square viewBox of the stage
export const YAW = -0.35; // the static picture's turn
export const PITCH = 0.1;
const LIGHT = rotate(normalize([-0.5, 0.55, 0.7]), YAW, PITCH); // fixed in view space

export const SENSE_NAMES = ["eyes", "ears", "mouth", "crown"] as const;
export type SenseName = (typeof SENSE_NAMES)[number];
/** Sense regions in head-frame units, mirrored in x; the crown is the top of the head. */
export const SENSES = {
  eyes: { centre: [0.118, 0.165, 0.25], radius: 0.055 },
  ears: { centre: [0.27, 0.12, -0.05], radius: 0.075 },
  mouth: { centre: [0, -0.045, 0.3], radius: 0.06 },
} as const;
export const CROWN_SHARE = 0.05; // of the head's height

export interface HeadCloud {
  count: number;
  rings: number;
  minY: number;
  maxY: number;
  position: Float32Array; // xyz
  normal: Float32Array; // xyz
  occlusion: Float32Array; // 1 open … 0 buried
  sense: Uint8Array; // 0 none, else 1 + index in SENSE_NAMES
}

type Vec = [number, number, number];

export function normalize(v: readonly number[]): Vec {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Head frame to view: turn about y, then tilt about x. The camera looks down -z. */
export function rotate(p: readonly number[], yaw: number, pitch = PITCH): Vec {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const u = cy * p[0] + sy * p[2];
  const z1 = -sy * p[0] + cy * p[2];
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [u, cp * p[1] - sp * z1, sp * p[1] + cp * z1];
}

// ---------- storage ----------

const OCT = 127;
function octEncode([x, y, z]: readonly number[]): [number, number] {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l1;
  let v = y / l1;
  if (z < 0)
    [u, v] = [(1 - Math.abs(v)) * Math.sign(u || 1), (1 - Math.abs(u)) * Math.sign(v || 1)];
  return [Math.round(u * OCT), Math.round(v * OCT)];
}
function octDecode(a: number, b: number): Vec {
  let u = a / OCT;
  let v = b / OCT;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0)
    [u, v] = [(1 - Math.abs(v)) * Math.sign(u || 1), (1 - Math.abs(u)) * Math.sign(v || 1)];
  return normalize([u, v, z]);
}

export interface CloudRing {
  y: number;
  dots: {
    angle: number;
    radius: number;
    normal: readonly number[];
    occlusion: number;
    sense: number;
  }[];
}

export function encodeCloud(rings: CloudRing[], minY: number, maxY: number): Uint8Array {
  const maxR = Math.max(...rings.flatMap((ring) => ring.dots.map((d) => d.radius)));
  const count = rings.reduce((n, ring) => n + ring.dots.length, 0);
  const head = new Float32Array([minY, maxY, maxR]);
  const counts = new Uint16Array([rings.length, ...rings.map((ring) => ring.dots.length)]);
  const angles = new Uint16Array(count);
  const radii = new Uint16Array(count);
  const normals = new Int8Array(count * 2);
  const extra = new Uint8Array(count);
  let k = 0;
  for (const ring of rings) {
    let previous = 0;
    for (const [i, d] of ring.dots.entries()) {
      const a = Math.round(((d.angle + Math.PI) / (2 * Math.PI)) * 65535);
      angles[k] = i ? a - previous : a;
      previous = a;
      radii[k] = Math.round((d.radius / maxR) * 65535);
      normals.set(octEncode(d.normal), k * 2);
      extra[k] = (Math.round(Math.min(1, Math.max(0, d.occlusion)) * 31) << 3) | d.sense;
      k++;
    }
  }
  const parts = [head, counts, angles, radii, normals, extra].map(
    (a) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
  );
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function decodeCloud(buffer: ArrayBuffer): HeadCloud {
  let at = 0;
  const take = <T>(make: (b: ArrayBuffer) => T, bytes: number) => {
    const part = make(buffer.slice(at, at + bytes));
    at += bytes;
    return part;
  };
  const [minY, maxY, maxR] = take((b) => new Float32Array(b), 12);
  const rings = take((b) => new Uint16Array(b), 2)[0];
  const counts = take((b) => new Uint16Array(b), rings * 2);
  const count = counts.reduce((n, c) => n + c, 0);
  const angles = take((b) => new Uint16Array(b), count * 2);
  const radii = take((b) => new Uint16Array(b), count * 2);
  const normals = take((b) => new Int8Array(b), count * 2);
  const extra = take((b) => new Uint8Array(b), count);

  const cloud: HeadCloud = {
    count,
    rings,
    minY,
    maxY,
    position: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    occlusion: new Float32Array(count),
    sense: new Uint8Array(count),
  };
  const gap = (maxY - minY) / rings;
  let k = 0;
  for (let ring = 0; ring < rings; ring++) {
    const y = maxY - gap * (ring + 0.5);
    let a = 0;
    for (let i = 0; i < counts[ring]; i++, k++) {
      a = i ? a + angles[k] : angles[k];
      const angle = (a / 65535) * 2 * Math.PI - Math.PI;
      const r = (radii[k] / 65535) * maxR;
      cloud.position.set([Math.sin(angle) * r, y, Math.cos(angle) * r], k * 3);
      cloud.normal.set(octDecode(normals[k * 2], normals[k * 2 + 1]), k * 3);
      cloud.occlusion[k] = (extra[k] >> 3) / 31;
      cloud.sense[k] = extra[k] & 7;
    }
  }
  return cloud;
}

// ---------- one frame ----------

export interface Frame {
  visible: number; // dots[0 … visible)
  index: Uint32Array; // which cloud dot
  x: Float32Array; // stage units
  y: Float32Array;
  light: Float32Array; // 0 … 1, drives the dot size
}

export function createFrame(cloud: HeadCloud): Frame {
  return {
    visible: 0,
    index: new Uint32Array(cloud.count),
    x: new Float32Array(cloud.count),
    y: new Float32Array(cloud.count),
    light: new Float32Array(cloud.count),
  };
}

/** Stage units per head-frame unit; the bust fills 92% of the stage's height. */
export const scaleOf = (cloud: HeadCloud) => (SIZE * 0.92) / (cloud.maxY - cloud.minY);

/** A head-frame point on the stage, with its depth toward the camera. */
export function toStage(cloud: HeadCloud, p: readonly number[], yaw: number): Vec {
  const v = rotate(p, yaw);
  const s = scaleOf(cloud);
  return [SIZE / 2 + v[0] * s, SIZE * 0.5 - (v[1] - (cloud.maxY + cloud.minY) / 2) * s, v[2]];
}

const GRID = 100; // coarse depth buffer for hidden dots, cells across the stage
const depth = new Float32Array(GRID * GRID);
let scratch = new Float32Array(0);

/** Projects, hides and lights every dot for the head turned by `yaw`. */
export function project(cloud: HeadCloud, yaw: number, frame: Frame): Frame {
  const { count, position, normal, occlusion } = cloud;
  if (scratch.length < count * 4) scratch = new Float32Array(count * 4);
  const s = scaleOf(cloud);
  const midY = (cloud.maxY + cloud.minY) / 2;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(PITCH);
  const sp = Math.sin(PITCH);
  const cell = SIZE / GRID;
  // A dot is hidden when something in its cell is this much nearer, in head units.
  const tolerance = (cell * 1.6) / s;
  depth.fill(Number.NEGATIVE_INFINITY);

  for (let i = 0; i < count; i++) {
    const nx = normal[i * 3];
    const nz = normal[i * 3 + 2];
    const nz1 = -sy * nx + cy * nz;
    const nzView = sp * normal[i * 3 + 1] + cp * nz1;
    scratch[i * 4 + 3] = nzView;
    if (nzView < 0.02) continue;
    const px = position[i * 3];
    const py = position[i * 3 + 1];
    const pz = position[i * 3 + 2];
    const z1 = -sy * px + cy * pz;
    const x = SIZE / 2 + (cy * px + sy * pz) * s;
    const y = SIZE * 0.5 - (cp * py - sp * z1 - midY) * s;
    const z = sp * py + cp * z1;
    scratch[i * 4] = x;
    scratch[i * 4 + 1] = y;
    scratch[i * 4 + 2] = z;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) continue;
    const k = gy * GRID + gx;
    if (z > depth[k]) depth[k] = z;
  }

  let n = 0;
  const fadeHeight = (cloud.maxY - cloud.minY) * 0.12;
  for (let i = 0; i < count; i++) {
    const nzView = scratch[i * 4 + 3];
    if (nzView < 0.02) continue;
    const x = scratch[i * 4];
    const y = scratch[i * 4 + 1];
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    if (gx < 0 || gy < 0 || gx >= GRID || gy >= GRID) continue;
    if (depth[gy * GRID + gx] - scratch[i * 4 + 2] > tolerance) continue;
    // The normal turned by yaw and pitch, inline: this runs for every dot on every frame.
    const nx = normal[i * 3];
    const ny = normal[i * 3 + 1];
    const nz = normal[i * 3 + 2];
    const nz1 = -sy * nx + cy * nz;
    const lambert = Math.max(
      0,
      (cy * nx + sy * nz) * LIGHT[0] + (cp * ny - sp * nz1) * LIGHT[1] + nzView * LIGHT[2],
    );
    const rim = (1 - nzView) ** 4 * 0.45;
    const lit = (0.06 + 0.98 * lambert ** 1.5) * (0.25 + 0.75 * occlusion[i] ** 1.5) + rim;
    // The neck fades out toward its cut.
    const fade = Math.min(1, Math.max(0, (position[i * 3 + 1] - cloud.minY) / fadeHeight));
    const light = Math.min(1, lit) * fade;
    if (light < 0.04) continue;
    frame.index[n] = i;
    frame.x[n] = x;
    frame.y[n] = y;
    frame.light[n] = light;
    n++;
  }
  frame.visible = n;
  return frame;
}

/** Dot diameter in stage units for a light level; `cell` is the ring spacing on the stage. */
export const dotSize = (cell: number, light: number) => cell * 0.95 * (0.16 + 0.84 * light);
export const cellOf = (cloud: HeadCloud) =>
  ((cloud.maxY - cloud.minY) / cloud.rings) * scaleOf(cloud);

// ---------- senses on the stage ----------

export interface SenseMarks {
  eyes: [number, number][]; // eyes facing the camera
  ear: { at: [number, number]; out: number } | null; // the ear turned toward the camera
  mouth: { at: [number, number]; out: number } | null;
  crown: [number, number];
  /** Label centres, null while that sense faces away. */
  labels: Record<"eyes" | "ears" | "mouth" | "create", [number, number] | null>;
}

/** Where the senses are for the head turned by `yaw`; `out` is an on-screen angle. */
export function senseMarks(cloud: HeadCloud, yaw: number): SenseMarks {
  const at = (p: readonly number[]) => {
    const v = toStage(cloud, p, yaw);
    return [v[0], v[1]] as [number, number];
  };
  const heading = (p: readonly number[], d: readonly number[]) => {
    const [a, b] = [at(p), at(p.map((c, i) => c + d[i] * 0.1))];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  };
  const facing = (d: readonly number[]) => rotate(d, yaw)[2];
  const face = facing([0, 0, 1]);
  const { eyes, ears, mouth } = SENSES;

  const eyeMarks = [1, -1]
    .filter((side) => facing(normalize([side * 0.35, 0, 1])) > 0.12)
    .map((side) => at([side * eyes.centre[0], eyes.centre[1], eyes.centre[2] + 0.02]));
  const earSide = facing([1, 0, 0]) > 0 ? 1 : -1;
  const earPoint = [earSide * ears.centre[0], ears.centre[1], ears.centre[2]];
  const ear =
    facing([earSide, 0, 0]) > -0.05
      ? { at: at(earPoint), out: heading(earPoint, [earSide, 0, 0]) }
      : null;
  const mouthPoint = [0, mouth.centre[1], mouth.centre[2] + 0.02];
  const mouthMark =
    face > 0.15 ? { at: at(mouthPoint), out: heading(mouthPoint, [0, -0.25, 1]) } : null;
  const crown = at([0, cloud.maxY, 0]);

  const toward = (p: [number, number], angle: number, d: number, dy: number): [number, number] => [
    p[0] + Math.cos(angle) * d,
    p[1] + Math.sin(angle) * d + dy,
  ];
  const faceOut = heading([0, eyes.centre[1], eyes.centre[2]], [0, 0, 1]);
  const nearEye = eyeMarks.length
    ? eyeMarks.reduce((a, b) => (Math.cos(faceOut) * (b[0] - a[0]) > 0 ? b : a))
    : null;
  return {
    eyes: eyeMarks,
    ear,
    mouth: mouthMark,
    crown,
    labels: {
      eyes: nearEye && face > 0.3 ? toward(nearEye, faceOut, 66, -34) : null,
      ears: ear ? toward(ear.at, ear.out, 52, -36) : null,
      mouth: mouthMark && face > 0.3 ? toward(mouthMark.at, faceOut, 86, 22) : null,
      create: [crown[0] - 64, crown[1] + 4],
    },
  };
}

/** Crown sparks: offset and arm length, in stage units, around the top of the head. */
export const SPARKS: [number, number, number][] = [
  [-34, -4, 5],
  [-14, -16, 3.5],
  [10, -22, 6],
  [32, -10, 4],
  [48, 6, 3],
];
/** The sound arcs at the ear and the mouth: radii and half-spread in radians. */
export const WAVES = {
  ears: { radii: [18, 27, 36], spread: 0.62 },
  mouth: { radii: [16, 25, 34], spread: 0.55 },
} as const;
