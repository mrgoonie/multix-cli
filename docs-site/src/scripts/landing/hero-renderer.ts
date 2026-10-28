/**
 * The landing hero: a dot-grid head drawn with plain WebGL (gl.POINTS).
 * It turns toward the pointer, ripples under it, and a click or the unlock
 * button lights eyes → ears → mouth → crown, pinning a DOM label to each.
 *
 * Points come from /hero/head-points.bin; the format is documented in
 * generate-head-points.mjs. Sound waves (region 4) and creation sparks
 * (region 6) are generated here. Rendering pauses offscreen and in hidden tabs.
 */

interface Manifest {
  format: string;
  version: number;
  count: number;
  anchors: { eyes: number[]; ears: number[]; mouth: number[] };
}

const FLOATS_PER_POINT = 5; // x, y, z, region, seed

const vertexShader = `
attribute vec3 aPos; attribute float aRegion; attribute float aSeed;
uniform float uYaw, uPitch, uTime, uAspect, uDpr, uSize, uMouseOn, uPulse, uCreate;
uniform vec2 uMouse; uniform vec3 uUnlock;
uniform vec3 uBase, uHot, cImage, cVideo, cVoice, cMusic, cSpeak;
varying vec3 vColor; varying float vAlpha;
mat3 rotY(float a){float c=cos(a),s=sin(a);return mat3(c,0.,-s, 0.,1.,0., s,0.,c);}
mat3 rotX(float a){float c=cos(a),s=sin(a);return mat3(1.,0.,0., 0.,c,s, 0.,-s,c);}
bool is(float r){return abs(aRegion-r)<0.5;}
void main(){
  vec3 p = aPos; float wave = -1.0;
  if (is(4.0)) {
    float t = fract(uTime*0.55 + aPos.y/3.0);
    float r = 0.12 + t*0.95;
    p = vec3(sin(aPos.x)*r, -0.52 + cos(aPos.x)*r*0.15, 0.92 + cos(aPos.x)*r*0.9);
    wave = t;
  }
  float spark = -1.0;
  if (is(6.0)) {
    float t = fract(uTime*0.22 + aPos.y);
    float r = 0.08 + t*0.55 + aPos.z*0.12;
    float ang = aPos.x + t*5.0;
    p = vec3(cos(ang)*r, 1.08 + t*0.5, -0.05 + sin(ang)*r*0.7);
    spark = t;
  }
  vec3 dir = normalize(p - vec3(0.0,-0.2,-0.05) + 1e-4);
  p += dir*sin(uTime*1.2 + aPos.y*3.0)*0.006;
  if (is(3.0)) p += dir*uUnlock.z*0.045*sin(uTime*16.0 + aSeed*6.28);
  if (is(2.0)) p += dir*uUnlock.y*0.035*sin(uTime*7.0 - aPos.y*14.0);
  if (is(1.0)) p += dir*uUnlock.x*0.02*(0.5+0.5*sin(uTime*3.0));
  p = rotX(uPitch)*(rotY(uYaw)*p);
  float dist = 4.3 - p.z;
  vec2 ndc = vec2(p.x*2.45/dist/uAspect, (p.y+0.2)*2.45/dist);

  vec2 dm = ndc - uMouse; dm.x *= uAspect;
  float md = length(dm);
  float field = exp(-md*md*16.0)*uMouseOn;
  float ripple = 0.5 + 0.5*sin(md*46.0 - uTime*8.0);
  vec2 push = normalize(dm + 1e-5)*field*0.06*(0.55 + 0.45*ripple);
  ndc += vec2(push.x/uAspect, push.y);

  float sweepY = 1.25 - uPulse*1.5;
  float sweep = (wave < 0.0 && spark < 0.0) ? exp(-pow((aPos.y - sweepY)*7.0, 2.0)) : 0.0;

  float depth = clamp((p.z + 1.0)*0.5, 0.0, 1.0);
  vec3 col = uBase;
  float a = mix(0.10, 0.85, depth*depth);
  float size = uSize*(0.6 + 0.7*depth);
  float flick = 0.5 + 0.5*sin(uTime*2.0 + aSeed*12.0);
  if (is(1.0)) { col = mix(col, mix(cImage, cVideo, flick), uUnlock.x); size *= 1.0 + uUnlock.x*0.9; a = mix(a, 1.0, uUnlock.x); }
  if (is(2.0)) { col = mix(col, mix(cVoice, cMusic, flick), uUnlock.y); size *= 1.0 + uUnlock.y*0.8; a = mix(a, 1.0, uUnlock.y); }
  if (is(3.0)) { col = mix(col, cSpeak, uUnlock.z); size *= 1.0 + uUnlock.z*0.8; a = mix(a, 1.0, uUnlock.z); }
  if (is(5.0)) { float fire = step(0.72, fract(aSeed*7.0 + uTime*0.9)); col = mix(col, uHot, uCreate*(0.35 + 0.65*fire)); size *= 1.0 + uCreate*(0.3 + 0.9*fire); a = mix(a, 1.0, uCreate*(0.4 + 0.6*fire)); }
  col = mix(col, uHot, field*0.9); size *= 1.0 + field*1.4; a = max(a, field*0.95);
  col = mix(col, uHot, sweep*0.8); size *= 1.0 + sweep*1.2; a = max(a, sweep);
  a *= 0.8 + 0.2*sin(uTime*1.7 + aSeed*31.0);
  a *= (wave >= 0.0 || spark >= 0.0) ? 1.0 : smoothstep(-1.7, -1.15, aPos.y);
  if (wave >= 0.0) { col = cSpeak; a = uUnlock.z*(1.0 - wave)*0.9; size = uSize*(1.6 - wave); }
  if (spark >= 0.0) { col = mix(uHot, cMusic, aSeed*0.6); a = uCreate*sin(spark*3.14159)*0.95; size = uSize*(0.8 + 1.4*aSeed); }
  vColor = col; vAlpha = clamp(a, 0.0, 1.0);
  gl_PointSize = size*uDpr*(4.3/dist);
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

const fragmentShader = `
precision mediump float; varying vec3 vColor; varying float vAlpha;
void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.12, d)*vAlpha; if (a < 0.01) discard; gl_FragColor = vec4(vColor*a, a); }`;

const UNIFORMS = [
  "uYaw",
  "uPitch",
  "uTime",
  "uAspect",
  "uDpr",
  "uSize",
  "uMouseOn",
  "uPulse",
  "uCreate",
  "uMouse",
  "uUnlock",
  "uBase",
  "uHot",
  "cImage",
  "cVideo",
  "cVoice",
  "cMusic",
  "cSpeak",
] as const;

/** Deterministic per-point noise in [0, 1). */
const seedOf = (i: number) => {
  const s = Math.sin(i * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

/** Interleave the file's points with generated wave and spark particles. */
function buildVertices(bin: ArrayBuffer, count: number, stride: number): Float32Array {
  const view = new DataView(bin);
  const kept = Math.ceil(count / stride);
  const waves = 3 * 90;
  const sparks = 320;
  const out = new Float32Array((kept + waves + sparks) * FLOATS_PER_POINT);
  let o = 0;
  for (let i = 0; i < count; i += stride) {
    out[o++] = view.getFloat32(i * 12, true);
    out[o++] = view.getFloat32(i * 12 + 4, true);
    out[o++] = view.getFloat32(i * 12 + 8, true);
    out[o++] = view.getUint8(count * 12 + i);
    out[o++] = seedOf(i);
  }
  // Sound waves in front of the mouth: x = angle, y = ring index.
  for (let ring = 0; ring < 3; ring++) {
    for (let j = 0; j < 90; j++) {
      out.set([-1.1 + (j / 89) * 2.2, ring, 0, 4, seedOf(count + ring * 90 + j)], o);
      o += FLOATS_PER_POINT;
    }
  }
  // Creation sparks rising from the crown: x = angle, y = phase, z = radius jitter.
  for (let j = 0; j < sparks; j++) {
    const k = count + waves + j * 3;
    out.set([seedOf(k) * Math.PI * 2, seedOf(k + 1), seedOf(k + 2), 6, seedOf(k + 3)], o);
    o += FLOATS_PER_POINT;
  }
  return out;
}

/** Parse a #rgb / #rrggbb token into 0–1 floats. */
function hexToRgb(value: string, fallback: [number, number, number]): number[] {
  const hex = value.trim().replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return fallback;
  const n = Number.parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ease = (v: number) => v * v * (3 - 2 * v);

/**
 * Start the hero in `stage`. Resolves to false (leaving the poster in place)
 * when WebGL or the point data is unavailable.
 */
export async function startHero(stage: HTMLElement): Promise<boolean> {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("webgl", {
    premultipliedAlpha: true,
    antialias: false,
    alpha: true,
    powerPreference: "low-power",
    // No GPU (software rendering) would cost more main-thread time than the poster is worth.
    failIfMajorPerformanceCaveat: true,
  });
  if (!context) return false;
  const gl: WebGLRenderingContext = context;

  const binUrl = stage.dataset.points ?? "/hero/head-points.bin";
  const manifestUrl = binUrl.replace(/\.bin$/, ".json");
  let manifest: Manifest;
  let bin: ArrayBuffer;
  try {
    const [m, b] = await Promise.all([fetch(manifestUrl), fetch(binUrl)]);
    if (!m.ok || !b.ok) return false;
    manifest = (await m.json()) as Manifest;
    bin = await b.arrayBuffer();
  } catch {
    return false;
  }
  if (manifest.format !== "multix-head-points" || bin.byteLength < manifest.count * 13)
    return false;

  const small = matchMedia("(max-width: 860px)").matches;
  const data = buildVertices(bin, manifest.count, small ? 2 : 1);
  const count = data.length / FLOATS_PER_POINT;

  const compile = (type: number, src: string) => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error("shader");
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
    }
    return shader;
  };
  const prog = gl.createProgram();
  try {
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vertexShader));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragmentShader));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
  } catch {
    return false;
  }
  gl.useProgram(prog);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const attr = (name: string, size: number, offset: number) => {
    const loc = gl.getAttribLocation(prog, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, FLOATS_PER_POINT * 4, offset);
  };
  attr("aPos", 3, 0);
  attr("aRegion", 1, 12);
  attr("aSeed", 1, 16);
  const U = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(prog, n)])) as Record<
    (typeof UNIFORMS)[number],
    WebGLUniformLocation | null
  >;
  gl.enable(gl.BLEND);

  /* ---------- colours from the design tokens ---------- */
  const root = document.documentElement;
  function readPalette() {
    const cs = getComputedStyle(root);
    const v = (name: string, fallback: [number, number, number]) =>
      hexToRgb(cs.getPropertyValue(name), fallback);
    const dark = root.dataset.theme
      ? root.dataset.theme !== "light"
      : !matchMedia("(prefers-color-scheme: light)").matches;
    gl.useProgram(prog);
    gl.uniform3fv(U.uBase, v("--mx-dot", [0.49, 0.53, 0.6]));
    gl.uniform3fv(U.uHot, v("--mx-accent", [1, 1, 1]));
    gl.uniform3fv(U.cImage, v("--mx-sense-see", [1, 1, 1]));
    gl.uniform3fv(U.cVideo, v("--mx-sense-create", [0.89, 0.91, 0.96]));
    gl.uniform3fv(U.cVoice, v("--mx-sense-hear", [0.79, 0.82, 0.89]));
    gl.uniform3fv(U.cMusic, v("--mx-text-muted", [0.56, 0.59, 0.64]));
    gl.uniform3fv(U.cSpeak, v("--mx-sense-speak", [1, 1, 1]));
    // Additive light on dark paper; ordinary "ink" blending on light paper.
    if (dark) gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  addEventListener("mx-themechange", readPalette);

  /* ---------- interaction ---------- */
  const labels = [...stage.querySelectorAll<HTMLElement>(".mx-sense")];
  const labelWidths = labels.map(() => 0);
  let labelsShown = false;
  const button = stage.querySelector<HTMLButtonElement>("#mx-unlock");
  const buttonLabel = button?.querySelector("span");
  let yaw = 0;
  let pitch = 0;
  let targetYaw = 0;
  let targetPitch = 0;
  let mouse = [9, 9];
  let mouseOn = 0;
  let targetMouseOn = 0;
  let unlockedAt = -1;
  let lockedAt = -1;
  let unlocked = false;
  const unlock = [0, 0, 0, 0];

  canvas.addEventListener("pointermove", (event) => {
    const r = canvas.getBoundingClientRect();
    const nx = ((event.clientX - r.left) / r.width) * 2 - 1;
    const ny = -(((event.clientY - r.top) / r.height) * 2 - 1);
    mouse = [nx, ny];
    targetMouseOn = 1;
    targetYaw = nx * 0.55;
    targetPitch = -ny * 0.22;
  });
  canvas.addEventListener("pointerleave", () => {
    targetMouseOn = 0;
    targetYaw = 0;
    targetPitch = 0;
  });

  function toggle() {
    const now = performance.now() / 1000;
    unlocked = !unlocked;
    if (unlocked) unlockedAt = now;
    else lockedAt = now;
    if (button) {
      button.setAttribute("aria-pressed", String(unlocked));
      if (buttonLabel) {
        buttonLabel.textContent = (unlocked ? button.dataset.lock : button.dataset.unlock) ?? "";
      }
    }
    wake();
  }
  canvas.addEventListener("click", toggle);
  button?.addEventListener("click", toggle);

  /* ---------- projection, mirrored from the shader to pin the labels ---------- */
  const { eyes, ears, mouth } = manifest.anchors;
  const anchors: Record<string, number[]> = {
    eyes: [eyes[0] + 0.32, eyes[1] + 0.18, eyes[2]],
    ears: [-ears[0] - 0.12, ears[1] + 0.32, ears[2]],
    mouth: [mouth[0] + 0.5, mouth[1] - 0.12, mouth[2]],
    create: [-0.55, 1.05, 0.3],
  };
  function project(x: number, y: number, z: number) {
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const px = cy * x + sy * z;
    const pz = -sy * x + cy * z;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const ry = cp * y - sp * pz;
    const rz = sp * y + cp * pz;
    const dist = 4.3 - rz;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const aspect = w / h;
    return [
      (((px * 2.45) / dist / aspect + 1) / 2) * w,
      (1 - (((ry + 0.2) * 2.45) / dist + 1) / 2) * h,
    ];
  }

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform1f(U.uDpr, dpr);
    gl.uniform1f(U.uAspect, canvas.clientWidth / canvas.clientHeight || 1);
    gl.uniform1f(U.uSize, small ? 2.6 : 2.2);
    labelWidths.fill(0);
    labelsShown = true;
  }

  function draw(ms: number) {
    const t = ms / 1000;
    yaw += (targetYaw + Math.sin(t * 0.35) * 0.18 - yaw) * 0.06;
    pitch += (targetPitch - pitch) * 0.06;
    mouseOn += (targetMouseOn - mouseOn) * 0.08;
    if (unlocked) {
      const e = t - unlockedAt;
      unlock[0] = ease(clamp01(e / 0.6));
      unlock[1] = ease(clamp01((e - 0.45) / 0.6));
      unlock[2] = ease(clamp01((e - 0.9) / 0.6));
      unlock[3] = ease(clamp01((e - 1.35) / 0.7));
    } else if (lockedAt > 0) {
      const k = 1 - clamp01((t - lockedAt) / 0.5);
      for (let i = 0; i < 4; i++) unlock[i] = Math.min(unlock[i], k);
    }
    gl.uniform1f(U.uTime, t);
    gl.uniform1f(U.uYaw, yaw);
    gl.uniform1f(U.uPitch, pitch);
    gl.uniform2fv(U.uMouse, mouse);
    gl.uniform1f(U.uMouseOn, mouseOn);
    gl.uniform3fv(U.uUnlock, unlock.slice(0, 3));
    gl.uniform1f(U.uCreate, unlock[3]);
    gl.uniform1f(U.uPulse, unlocked ? t - unlockedAt : 99);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, count);

    // Labels move only while a sense is (partly) unlocked; transforms avoid layout.
    if (unlock[0] === 0 && !labelsShown) return;
    labelsShown = unlock[0] > 0;
    const w = canvas.clientWidth;
    labels.forEach((el, i) => {
      const anchor = anchors[el.dataset.sense ?? ""];
      if (!anchor) return;
      const [x, y] = project(anchor[0], anchor[1], anchor[2]);
      // Keep labels inside the stage on narrow screens.
      labelWidths[i] ||= el.offsetWidth;
      const half = labelWidths[i] / 2 + 4;
      const left = Math.min(Math.max(x, half), w - half);
      el.style.transform = `translate(${left.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
      el.classList.toggle("is-on", unlock[i] > 0.6);
    });
  }

  /* ---------- loop: runs only while the stage is visible and the tab is shown ---------- */
  let onScreen = true;
  let raf = 0;
  const running = () => onScreen && document.visibilityState === "visible";
  function loop(ms: number) {
    if (!running()) {
      raf = 0;
      return;
    }
    draw(ms);
    raf = requestAnimationFrame(loop);
  }
  function wake() {
    if (!raf && running()) raf = requestAnimationFrame(loop);
  }
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    wake();
  }).observe(stage);
  document.addEventListener("visibilitychange", wake);
  new ResizeObserver(resize).observe(canvas);

  stage.prepend(canvas);
  resize();
  readPalette();
  wake();
  stage.classList.add("is-live");
  if (button) button.hidden = false;
  return true;
}
