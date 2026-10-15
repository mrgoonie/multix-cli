/**
 * Runway commands driven through commander with the env-based client (global
 * fetch stubbed with the fake Runway API): flag validation before any request,
 * submit/resume handles, wait + download, image inputs, status and cancel.
 * No network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { RunwayTaskError } from "../../../../src/providers/runway/client.js";
import { registerRunwayCommands } from "../../../../src/providers/runway/commands/index.js";
import {
  BASE,
  IMAGE_URL,
  MP4,
  OUTPUT_URL,
  PNG,
  SECRET,
  TASK_ID,
  createFakeRunway,
  task,
} from "./fake-runway.js";

let tmp: string;
let outDir: string;
let output: string[];
/** console.log only: what a script reading --json sees. */
let stdout: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-runway-cmd-"));
  outDir = path.join(tmp, "out");
  vi.stubEnv("MULTIX_OUTPUT_DIR", outDir);
  vi.stubEnv("RUNWAYML_API_SECRET", SECRET);
  vi.stubEnv("RUNWAY_BASE_URL", BASE);
  vi.stubEnv("RUNWAY_VIDEO_MODEL", "");
  vi.stubEnv("RUNWAY_IMAGE_MODEL", "");
  vi.stubEnv("MULTIX_IMAGE_FORMAT", "original");
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  output = [];
  stdout = [];
  const capture = (...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    capture(...args);
    stdout.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stub(routes: Parameters<typeof createFakeRunway>[0]) {
  const fake = createFakeRunway(routes);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => output.push(s), writeOut: (s) => output.push(s) });
  registerRunwayCommands(program);
  await program.parseAsync(["node", "multix", "runway", ...args]);
}

const text = () => output.join("\n");
const created = { json: { id: TASK_ID, estimatedCost: { credits: 50 } } };
const succeeded = (url = OUTPUT_URL) => ({
  json: task("SUCCEEDED", { output: [url], cost: { credits: 50 } }),
});
const savedFiles = () => (fs.existsSync(outDir) ? fs.readdirSync(outDir) : []);

describe("runway video", () => {
  it("submits text-to-video and prints a resumable handle without waiting", async () => {
    const fake = stub({ "POST /v1/text_to_video": [created] });
    await run("video", "a cat surfing", "--duration", "8", "--ratio", "720:1280", "--seed", "7");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.body).toEqual({
      model: "gen4.5",
      promptText: "a cat surfing",
      ratio: "720:1280",
      duration: 8,
      seed: 7,
    });
    const out = text();
    expect(out).toContain(`Task submitted: ${TASK_ID}`);
    expect(out).toContain("50 credits (≈ $0.50)");
    expect(out).toContain(`multix runway status ${TASK_ID} --wait --download`);
    expect(out).toContain(`multix runway cancel ${TASK_ID}`);
    expect(out).not.toContain(SECRET);
    expect(savedFiles()).toEqual([]);
  });

  it("prints the handle as JSON", async () => {
    stub({ "POST /v1/text_to_video": [created] });
    await run("video", "a cat", "--json");
    const json = JSON.parse(stdout.join("\n"));
    expect(json).toMatchObject({ id: TASK_ID, status: "SUBMITTED", estimatedCredits: 50 });
  });

  it("validates flags before any request", async () => {
    const fake = stub({});
    await expect(run("video", "a cat", "--duration", "12")).rejects.toThrow(/2 to 10/);
    await expect(run("video", "a cat", "--ratio", "960:960")).rejects.toThrow(/text-to-video/);
    await expect(run("video", "a cat", "-m", "gen4_turbo")).rejects.toThrow(/image-to-video only/);
    await expect(run("video", "a cat", "-m", "veo3")).rejects.toThrow(
      /Unsupported Runway video model/,
    );
    await expect(run("video", "")).rejects.toThrow(/Prompt must not be empty/);
    await expect(run("video", "a cat", "--image", "http://example.com/a.png")).rejects.toThrow(
      /https/,
    );
    await expect(run("video", "a cat", "--image", "https://10.0.0.1/a.png")).rejects.toThrow(
      /public domain/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("waits, downloads the video and reports the charge", async () => {
    const fake = stub({
      "POST /v1/text_to_video": [created],
      [`GET /v1/tasks/${TASK_ID}`]: [succeeded()],
      [`GET ${OUTPUT_URL}`]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    });
    await run("video", "a cat", "--wait");
    expect(savedFiles()).toEqual(["runway-17f20503-01.mp4"]);
    expect(fs.readFileSync(path.join(outDir, "runway-17f20503-01.mp4"))).toEqual(Buffer.from(MP4));
    expect(text()).toContain("Charged: 50 credits");
    expect(text()).not.toContain("SIGNEDsecret");
    expect(fake.calls[2]?.headers.authorization).toBeUndefined();
  });

  it("--no-download prints the signed URLs instead", async () => {
    stub({ "POST /v1/text_to_video": [created], [`GET /v1/tasks/${TASK_ID}`]: [succeeded()] });
    await run("video", "a cat", "--wait", "--no-download");
    expect(text()).toContain(OUTPUT_URL);
    expect(savedFiles()).toEqual([]);
  });

  it("fails loudly when the task fails", async () => {
    stub({
      "POST /v1/text_to_video": [created],
      [`GET /v1/tasks/${TASK_ID}`]: [
        {
          json: task("FAILED", { failure: "Content moderated", failureCode: "SAFETY.INPUT.TEXT" }),
        },
      ],
    });
    const err = await run("video", "a cat", "--wait").catch((e) => e);
    expect(err).toBeInstanceOf(RunwayTaskError);
    expect(err.message).toMatch(/failed \[SAFETY.INPUT.TEXT\]/);
    expect(savedFiles()).toEqual([]);
  });

  it("inlines a small local image as a data URI for image-to-video", async () => {
    const img = path.join(tmp, "frame.png");
    fs.writeFileSync(img, PNG);
    const fake = stub({ "POST /v1/image_to_video": [created] });
    await run("video", "-m", "gen4_turbo", "--image", img, "--ratio", "960:960");
    const body = fake.calls[0]?.body as Record<string, unknown>;
    expect(body.model).toBe("gen4_turbo");
    expect(body.promptText).toBeUndefined();
    expect(body.promptImage).toEqual([
      { uri: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`, position: "first" },
    ]);
  });

  it("uploads a large local image and sends its runway:// URI", async () => {
    const img = path.join(tmp, "big.png");
    const big = new Uint8Array(4 * 1024 * 1024);
    big.set(PNG);
    fs.writeFileSync(img, big);
    const fake = stub({
      "POST /v1/uploads": [
        {
          json: {
            uploadUrl: "https://storage.runway.test/up",
            fields: { key: "k" },
            runwayUri: "runway://ephemeral/big",
          },
        },
      ],
      "POST https://storage.runway.test/up": [{ status: 204, text: "" }],
      "POST /v1/image_to_video": [created],
    });
    await run("video", "the cat jumps", "--image", img);
    const body = fake.calls[2]?.body as Record<string, unknown>;
    expect(body.promptImage).toEqual([{ uri: "runway://ephemeral/big", position: "first" }]);
    expect(body.promptText).toBe("the cat jumps");
  });

  it("rejects a local file that is not a JPEG, PNG or WebP image", async () => {
    const gif = path.join(tmp, "a.gif");
    fs.writeFileSync(gif, "GIF89a....");
    const fake = stub({});
    await expect(run("video", "x", "--image", gif)).rejects.toThrow(/not a JPEG, PNG or WebP/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("runway image", () => {
  it("sends tagged references, waits and downloads by default", async () => {
    const ref = path.join(tmp, "hero.png");
    fs.writeFileSync(ref, PNG);
    const fake = stub({
      "POST /v1/text_to_image": [created],
      [`GET /v1/tasks/${TASK_ID}`]: [succeeded(IMAGE_URL)],
      [`GET ${IMAGE_URL}`]: [{ bytes: PNG, headers: { "content-type": "image/png" } }],
    });
    await run(
      "image",
      "@hero on a beach",
      "--ref",
      `hero=${ref}`,
      "--ref",
      "https://images.example.com/bg.webp",
      "--ratio",
      "1920:1080",
    );
    const body = fake.calls[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gen4_image",
      promptText: "@hero on a beach",
      ratio: "1920:1080",
    });
    expect(body.referenceImages).toEqual([
      { uri: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`, tag: "hero" },
      { uri: "https://images.example.com/bg.webp" },
    ]);
    expect(savedFiles()).toEqual(["runway-17f20503-01.png"]);
  });

  it("--async submits and prints the handle", async () => {
    const fake = stub({ "POST /v1/text_to_image": [created] });
    await run("image", "a cube", "--async");
    expect(fake.calls).toHaveLength(1);
    expect(text()).toContain(`Task submitted: ${TASK_ID}`);
  });

  it("enforces the reference count and tag rules per model", async () => {
    const fake = stub({});
    await expect(run("image", "x", "-m", "gen4_image_turbo")).rejects.toThrow(/1 to 3 --ref/);
    const refs = ["a", "b", "c", "d"].flatMap((r) => [
      "--ref",
      `https://images.example.com/${r}.png`,
    ]);
    await expect(run("image", "x", ...refs)).rejects.toThrow(/at most 3/);
    await expect(
      run(
        "image",
        "x",
        "--ref",
        "hero=https://i.example.com/a.png",
        "--ref",
        "hero=https://i.example.com/b.png",
      ),
    ).rejects.toThrow(/Duplicate --ref tag/);
    await expect(run("image", "x", "--ratio", "16:9")).rejects.toThrow(/not supported/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("downloads", () => {
  it("refuses an output URL that points at a private address", async () => {
    stub({
      [`GET /v1/tasks/${TASK_ID}`]: [succeeded("https://127.0.0.1/steal.mp4")],
    });
    await expect(run("status", TASK_ID, "--download")).rejects.toThrow(/could be downloaded/);
    expect(savedFiles()).toEqual([]);
  });

  it("refuses an HTML error page and explains expired URLs", async () => {
    stub({
      [`GET /v1/tasks/${TASK_ID}`]: [succeeded()],
      [`GET ${OUTPUT_URL}`]: [
        { text: "<html>denied</html>", headers: { "content-type": "text/html" } },
      ],
    });
    await expect(run("status", TASK_ID, "--download")).rejects.toThrow(
      /multix runway status .* --download/,
    );
    expect(text()).toMatch(/not a media file/);

    output = [];
    stub({
      [`GET /v1/tasks/${TASK_ID}`]: [succeeded()],
      [`GET ${OUTPUT_URL}`]: [{ status: 403, text: "AccessDenied" }],
    });
    await expect(run("status", TASK_ID, "--download")).rejects.toThrow(/could be downloaded/);
    expect(text()).toMatch(/may have expired/);
    expect(text()).not.toContain("SIGNEDsecret");
    expect(savedFiles()).toEqual([]);
  });
});

describe("runway status", () => {
  it("prints a redacted summary and the resume command while running", async () => {
    stub({ [`GET /v1/tasks/${TASK_ID}`]: [{ json: task("RUNNING", { progress: 0.4 }) }] });
    await run("status", TASK_ID);
    expect(text()).toContain('"status": "RUNNING"');
    expect(text()).toContain(`multix runway status ${TASK_ID} --wait --download`);
  });

  it("exits non-zero for a cancelled task", async () => {
    stub({ [`GET /v1/tasks/${TASK_ID}`]: [{ json: task("CANCELLED") }] });
    await expect(run("status", TASK_ID)).rejects.toBeInstanceOf(RunwayTaskError);
  });

  it("redacts output URLs in the summary of a succeeded task", async () => {
    stub({ [`GET /v1/tasks/${TASK_ID}`]: [succeeded()] });
    await run("status", TASK_ID);
    expect(text()).toContain("SUCCEEDED");
    expect(text()).not.toContain("SIGNEDsecret");
  });

  it("downloads with --wait --download", async () => {
    stub({
      [`GET /v1/tasks/${TASK_ID}`]: [succeeded()],
      [`GET ${OUTPUT_URL}`]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    });
    await run(
      "status",
      TASK_ID,
      "--wait",
      "--download",
      "--output",
      path.join(tmp, "clip"),
      "--json",
    );
    expect(fs.existsSync(path.join(tmp, "clip.mp4"))).toBe(true);
    const json = JSON.parse(stdout.join("\n"));
    expect(json.files).toEqual([path.join(tmp, "clip.mp4")]);
  });
});

describe("review hardening", () => {
  it("status --wait without --download keeps signed URLs out of stdout", async () => {
    stub({ [`GET /v1/tasks/${TASK_ID}`]: [succeeded()] });
    await run("status", TASK_ID, "--wait");
    expect(text()).toContain("SUCCEEDED");
    expect(text()).not.toContain("SIGNEDsecret");
    expect(text()).toContain(`multix runway status ${TASK_ID} --download`);

    output = [];
    await run("status", TASK_ID, "--wait", "--no-download");
    expect(text()).toContain(OUTPUT_URL);
  });

  it("names the task and the resume command when waiting fails after create", async () => {
    stub({
      "POST /v1/text_to_video": [created],
      [`GET /v1/tasks/${TASK_ID}`]: [{ status: 401, json: { error: "revoked" } }],
    });
    await expect(run("video", "a cat", "--wait")).rejects.toThrow(
      new RegExp(
        `Task ${TASK_ID} may still be running; resume with: multix runway status ${TASK_ID} --wait --download`,
      ),
    );
  });

  it("rejects an empty --image instead of falling back to text-to-video", async () => {
    const fake = stub({});
    await expect(run("video", "a cat", "--image", "")).rejects.toThrow(/must not be empty/);
    expect(fake.calls).toHaveLength(0);
  });

  it("help text does not depend on the model env", async () => {
    vi.stubEnv("RUNWAY_VIDEO_MODEL", "gen4_turbo");
    await expect(run("video", "--help")).rejects.toThrow();
    expect(text()).toContain("default model: gen4.5, or RUNWAY_VIDEO_MODEL");
  });
});

describe("runway cancel", () => {
  it("cancels a running task", async () => {
    const fake = stub({
      [`GET /v1/tasks/${TASK_ID}`]: [{ json: task("RUNNING") }],
      [`DELETE /v1/tasks/${TASK_ID}`]: [{ status: 204, text: "" }],
    });
    await run("cancel", TASK_ID);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(text()).toMatch(/Cancel sent for task .*if it finished meanwhile, Runway deleted it/);
  });

  it("does not delete a finished task without --delete", async () => {
    const fake = stub({
      [`GET /v1/tasks/${TASK_ID}`]: [succeeded()],
      [`DELETE /v1/tasks/${TASK_ID}`]: [{ status: 204, text: "" }],
    });
    await run("cancel", TASK_ID);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET"]);
    expect(text()).toMatch(/Pass --delete/);
    await run("cancel", TASK_ID, "--delete");
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "GET", "DELETE"]);
  });
});

describe("runway models", () => {
  it("lists models offline", async () => {
    vi.stubEnv("RUNWAYML_API_SECRET", "");
    const fake = stub({});
    await run("models", "--json");
    const json = JSON.parse(stdout.join("\n"));
    expect(json.video.map((m: { id: string }) => m.id)).toEqual(["gen4.5", "gen4_turbo"]);
    expect(fake.calls).toHaveLength(0);
  });
});
