/**
 * The spinning hero head. Loaded after the page, it fetches the baked dot cloud and draws it on a
 * canvas over the static SVG, whose first frame it matches, then turns the head slowly all the way
 * round. Drag turns it by hand; a button pauses it. The pointer swells the dots under it, and when
 * the senses unlock their dots swell in turn (eyes, ears, mouth, crown) with their ornaments.
 * The SVG stays in place: it is the picture without JS, under reduced motion, or if this fails.
 */

import {
  type HeadCloud,
  SENSE_NAMES,
  SIZE,
  SPARKS,
  WAVES,
  YAW,
  cellOf,
  createFrame,
  decodeCloud,
  dotSize,
  project,
  senseMarks,
} from "./head-cloud";

const TURN_SECONDS = 40; // one full turn when left alone
const PAD = 0.08; // the canvas overhangs the stage so crown sparks are not clipped
const SPOT_RADIUS = 70; // stage units
const SENSE_DELAY = 0.45; // seconds between senses lighting up
const SENSE_FADE = 0.6;
const SQUARE_BELOW = 1.4; // device pixels of radius

export async function startHeadSpin(stage: HTMLElement): Promise<void> {
  const art = stage.querySelector<HTMLElement>(".mx-head-art");
  const spinButton = stage.querySelector<HTMLButtonElement>("#mx-spin");
  if (!art) return;
  const response = await fetch("/hero/head-cloud.bin"); // the site has no base path
  if (!response.ok) return;
  const cloud: HeadCloud = decodeCloud(await response.arrayBuffer());
  const frame = createFrame(cloud);
  const cell = cellOf(cloud);

  const canvas = document.createElement("canvas");
  canvas.className = "mx-head-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("2d");
  if (!context) return;
  const ctx = context;
  art.append(canvas);

  const coarse = matchMedia("(pointer: coarse)").matches;
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)").matches;
  const labels = [...stage.querySelectorAll<HTMLElement>(".mx-sense")];

  let ink = "";
  let scale = 1;
  let yaw = YAW;
  let inertia = 0; // extra turn speed left by a fling, rad/s
  let playing = true;
  let onScreen = true;
  let pointer: [number, number] | null = null;
  let clock = 0; // seconds of motion; frozen while paused
  let unlockedAt = Number.NEGATIVE_INFINITY;
  const levels = SENSE_NAMES.map(() => 0); // 0 … 1 per sense

  const readInk = () => {
    ink = getComputedStyle(canvas).color;
  };
  const resize = () => {
    const box = art.getBoundingClientRect();
    const ratio = Math.min(2, devicePixelRatio || 1);
    const side = Math.round(box.width * (1 + 2 * PAD) * ratio);
    canvas.width = side;
    canvas.height = side;
    scale = side / (SIZE * (1 + 2 * PAD));
  };

  /** A pointer event in stage units. */
  const toStage = (event: PointerEvent): [number, number] => {
    const box = art.getBoundingClientRect();
    return [
      ((event.clientX - box.left) / box.width) * SIZE,
      ((event.clientY - box.top) / box.height) * SIZE,
    ];
  };

  const pulse = (period: number, i: number) =>
    0.15 + 0.85 * (0.5 - 0.5 * Math.cos(((clock - i * 0.3) / period) * 2 * Math.PI));

  function draw() {
    ctx.setTransform(scale, 0, 0, scale, PAD * SIZE * scale, PAD * SIZE * scale);
    ctx.clearRect(-PAD * SIZE, -PAD * SIZE, SIZE * (1 + 2 * PAD), SIZE * (1 + 2 * PAD));
    ctx.fillStyle = ink;
    ctx.strokeStyle = ink;
    project(cloud, yaw, frame);

    const spotRadius = SPOT_RADIUS * (1 + 0.12 * Math.sin((clock / 2.4) * 2 * Math.PI));
    const rest = new Path2D();
    const lit = new Path2D();
    for (let n = 0; n < frame.visible; n++) {
      const x = frame.x[n];
      const y = frame.y[n];
      let grow = 1;
      let bright = false;
      const sense = cloud.sense[frame.index[n]];
      if (sense && levels[sense - 1] > 0) {
        grow += 0.4 * levels[sense - 1];
        bright = levels[sense - 1] > 0.5;
      }
      if (pointer) {
        const d2 = (x - pointer[0]) ** 2 + (y - pointer[1]) ** 2;
        const near = 1 - d2 / (spotRadius * spotRadius);
        if (near > 0) {
          grow += 0.5 * near;
          bright ||= near > 0.15;
        }
      }
      const r = (dotSize(cell, frame.light[n]) * grow) / 2;
      const path = bright ? lit : rest;
      if (r * scale < SQUARE_BELOW) {
        // A dot this small looks the same as a square of equal area, which is far cheaper to fill.
        const half = r * 0.886;
        path.rect(x - half, y - half, 2 * half, 2 * half);
      } else {
        path.moveTo(x + r, y);
        path.arc(x, y, r, 0, 2 * Math.PI);
      }
    }
    ctx.globalAlpha = 0.82;
    ctx.fill(rest);
    ctx.globalAlpha = 1;
    ctx.fill(lit);

    const marks = senseMarks(cloud, yaw);
    if (levels.some((level) => level > 0)) drawOrnaments(marks);
    placeLabels(marks.labels);
  }

  function drawOrnaments(marks: ReturnType<typeof senseMarks>) {
    const [eyes, ears, mouth, crown] = levels;
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.globalAlpha = eyes;
    for (const [x, y] of marks.eyes) {
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, 2 * Math.PI);
      ctx.fill();
    }
    const arcs = (
      mark: typeof marks.ear,
      wave: { radii: readonly number[]; spread: number },
      level: number,
    ) => {
      if (!mark || !level) return;
      for (const [i, r] of wave.radii.entries()) {
        ctx.globalAlpha = level * pulse(1.8, i);
        ctx.beginPath();
        ctx.arc(mark.at[0], mark.at[1], r, mark.out - wave.spread, mark.out + wave.spread);
        ctx.stroke();
      }
    };
    arcs(marks.ear, WAVES.ears, ears);
    arcs(marks.mouth, WAVES.mouth, mouth);
    if (crown) {
      for (const [i, [dx, dy, r]] of SPARKS.entries()) {
        const x = marks.crown[0] + dx;
        const y = marks.crown[1] + dy;
        ctx.globalAlpha = crown * pulse(2.6, i);
        ctx.beginPath();
        ctx.moveTo(x, y - r);
        ctx.lineTo(x, y + r);
        ctx.moveTo(x - r, y);
        ctx.lineTo(x + r, y);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  function placeLabels(at: ReturnType<typeof senseMarks>["labels"]) {
    if (!stage.classList.contains("is-unlocked")) return;
    // Half of each label's width, in percent of the stage, read before any write this frame.
    const stageWidth = stage.clientWidth || 1;
    const halves = labels.map((label) => (label.offsetWidth / 2 / stageWidth) * 100);
    for (const [i, label] of labels.entries()) {
      const point = at[label.dataset.sense as keyof typeof at];
      label.classList.toggle("is-away", !point);
      if (!point) continue;
      // Keep the label inside the stage so it never widens the page.
      const left = Math.min(100 - halves[i], Math.max(halves[i], (point[0] / SIZE) * 100));
      label.style.left = `${left.toFixed(2)}%`;
      label.style.top = `${((point[1] / SIZE) * 100).toFixed(2)}%`;
    }
  }

  // ---------- the loop: runs only while something moves ----------

  let raf = 0;
  let last = 0;
  let lastDraw = 0;
  let dragging = false;

  const moving = () => {
    const target = stage.classList.contains("is-unlocked") ? 1 : 0;
    return (
      onScreen &&
      (dragging ||
        Math.abs(inertia) > 0.002 ||
        levels.some((level) => level !== target) ||
        (playing && document.visibilityState === "visible"))
    );
  };

  function tick(now: number) {
    raf = 0;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    if (playing) clock += dt;
    if (!dragging) {
      yaw += ((playing ? (2 * Math.PI) / TURN_SECONDS : 0) + inertia) * dt;
      inertia *= Math.exp(-dt * 3);
    }
    const on = stage.classList.contains("is-unlocked");
    const since = now / 1000 - unlockedAt;
    for (let i = 0; i < levels.length; i++) {
      const target = on && since > i * SENSE_DELAY ? 1 : 0;
      const step = dt / SENSE_FADE;
      levels[i] = target ? Math.min(1, levels[i] + step) : Math.max(0, levels[i] - step);
    }
    // Phones draw at 30 fps.
    if (!coarse || now - lastDraw > 30) {
      lastDraw = now;
      draw();
    }
    if (moving()) raf = requestAnimationFrame(tick);
    else last = 0;
  }
  const wake = () => {
    if (!raf && onScreen) raf = requestAnimationFrame(tick);
  };

  // ---------- input ----------

  let startX = 0;
  let lastX = 0;
  let lastMove = 0;
  let dragged = false;
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    dragging = true;
    dragged = false;
    startX = lastX = event.clientX;
    lastMove = event.timeStamp;
    inertia = 0;
    canvas.setPointerCapture(event.pointerId);
    wake();
  });
  canvas.addEventListener("pointermove", (event) => {
    if (finePointer) pointer = toStage(event);
    if (dragging) {
      const turn = ((event.clientX - lastX) / art.getBoundingClientRect().width) * Math.PI * 1.2;
      const dt = Math.max(1, event.timeStamp - lastMove) / 1000;
      yaw += turn;
      inertia = Math.max(-6, Math.min(6, turn / dt));
      lastX = event.clientX;
      lastMove = event.timeStamp;
      if (Math.abs(event.clientX - startX) > 4) dragged = true;
    }
    wake();
  });
  const release = (event: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    // A pause before letting go means no fling.
    if (event.timeStamp - lastMove > 80) inertia = 0;
    wake();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("pointerleave", () => {
    pointer = null;
    wake();
  });
  // A drag is not a click: keep it from toggling the senses.
  canvas.addEventListener("click", (event) => {
    if (dragged) event.stopPropagation();
    dragged = false;
  });

  if (spinButton) {
    const setLabel = () => {
      const text = (playing ? spinButton.dataset.pause : spinButton.dataset.spin) ?? "";
      spinButton.setAttribute("aria-label", text);
      spinButton.title = text;
      spinButton.dataset.state = playing ? "playing" : "paused";
    };
    spinButton.addEventListener("click", () => {
      playing = !playing;
      setLabel();
      wake();
    });
    setLabel();
    spinButton.hidden = false;
  }

  new MutationObserver(() => {
    if (stage.classList.contains("is-unlocked")) unlockedAt = performance.now() / 1000;
    wake();
  }).observe(stage, { attributes: true, attributeFilter: ["class"] });
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    wake();
  }).observe(stage);
  document.addEventListener("visibilitychange", wake);
  new ResizeObserver(() => {
    resize();
    draw();
  }).observe(art);
  addEventListener("mx-themechange", () => {
    readInk();
    draw();
  });

  // Let the decode's task end before the first frame is drawn.
  await new Promise(requestAnimationFrame);
  readInk();
  resize();
  draw();
  // The first frame matches the SVG, so swapping them shows no jump.
  stage.classList.add("has-canvas");
  wake();
}
