/**
 * Runway commands driven through commander with the real env-based client
 * (global fetch stubbed with the fake Runway API): validation before any paid
 * request, create → status → download for video and image, status/cancel,
 * input resolution, safe downloads, the offline model list and JSON-only
 * stdout for status. No network or paid calls.
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
  IMAGE_MODELS,
  VIDEO_MODELS,
  listRunwayModels,
} from "../../../../src/providers/runway/models.js";
import { BASE, OUTPUT_URL, SECRET, TASK_ID, createFakeRunway, task } from "./fake-runway.js";

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const IMAGE_URL = "https://cdn.runway.test/out/image.png?sig=SIGNED_TOKEN_123";
const CREATED = { id: TASK_ID, estimatedCost: { credits: 60 } };
const TASK_PATH = `GET /v1/tasks/${TASK_ID}`;

let tmp: string;
let output: string[];
/** console.log only: what a pipe (`| jq`) would read. */
let stdout: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-runway-cmd-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("RUNWAYML_API_SECRET", SECRET);
  vi.stubEnv("RUNWAY_BASE_URL", BASE);
  vi.stubEnv("RUNWAY_VIDEO_MODEL", "");
  vi.stubEnv("RUNWAY_IMAGE_MODEL", "");
  vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "");
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

describe("validation before any request", () => {
  it.each([
    [
      ["video", "x", "-m", "gen5"],
      /Unsupported Runway video model "gen5". Supported: gen4\.5, gen4_turbo/,
    ],
    [
      ["video", "x", "--ratio", "1920:1080"],
      /--ratio 1920:1080 is not supported by gen4\.5 \(text-to-video\)/,
    ],
    [["video", "x", "--ratio", "960:960"], /not supported by gen4\.5 \(text-to-video\)/],
    [["video", "x", "--duration", "11"], /--duration must be a positive integer up to 10/],
    [["video", "x", "--duration", "1"], /--duration must be from 2 to 10/],
    [["video", "x", "--duration", "5.5"], /--duration must be a positive integer/],
    [["video", "x", "--seed", "-1"], /--seed must be an integer from 0 to 4294967295/],
    [["video", "x", "--seed", "4294967296"], /--seed must be an integer/],
    [["video"], /gen4\.5 needs a prompt/],
    [["video", "x", "-m", "gen4_turbo"], /gen4_turbo is image-to-video only: pass --image/],
    [["video", "a".repeat(1001)], /Prompt is 1001 characters; Runway accepts up to 1000/],
    [["video", "x", "--output", "a.mp4"], /--output and --download\/--no-download need --wait/],
    [["video", "x", "--image", " "], /--image must not be empty/],
    [["image", "x", "-m", "gen4_image_turbo"], /gen4_image_turbo needs at least 1 --reference/],
    [["image", "x", "-m", "dall-e"], /Unsupported Runway image model/],
    [["image", "x", "--ratio", "4096:4096"], /--ratio 4096:4096 is not supported by gen4_image/],
    [
      [
        "image",
        "x",
        "--reference",
        "a.png",
        "--reference",
        "b.png",
        "--reference",
        "c.png",
        "--reference",
        "d.png",
      ],
      /accepts at most 3 --reference images/,
    ],
    [["image", "x", "--reference-tag", "cat"], /Each --reference-tag needs a matching --reference/],
    [
      ["image", "x", "--reference", "a.png", "--reference-tag", "1cat"],
      /--reference-tag "1cat" must be 3-16/,
    ],
    [["image", " "], /Prompt must not be empty/],
    [["image", "x", "--async", "--output", "a.png"], /--async cannot be combined/],
    [["status", "not-a-uuid"], /Invalid Runway task id/],
    [["cancel", "../../v1/uploads"], /Invalid Runway task id/],
  ])("%j", async (args, re) => {
    const fake = stub({});
    await expect(run(...args)).rejects.toThrow(re);
    expect(fake.calls).toHaveLength(0);
  });

  it("fails clearly when RUNWAYML_API_SECRET is missing", async () => {
    vi.stubEnv("RUNWAYML_API_SECRET", "");
    const fake = stub({});
    await expect(run("video", "x")).rejects.toThrow(
      /RUNWAYML_API_SECRET is not set.*dev\.runwayml\.com/,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("runway video", () => {
  it("submits text-to-video and prints a resumable handle without waiting", async () => {
    const fake = stub({ "POST /v1/text_to_video": [{ json: CREATED }] });
    await run("video", "a coastal city", "--duration", "4", "--seed", "7");
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.body).toEqual({
      model: "gen4.5",
      promptText: "a coastal city",
      ratio: "1280:720",
      duration: 4,
      seed: 7,
    });
    const out = text();
    expect(out).toContain("Indicative cost: 48 credits (~$0.48)");
    expect(out).toContain("up to 60 credits (~$0.60)");
    expect(out).toContain(`Task submitted: ${TASK_ID}`);
    expect(out).toContain(`multix runway status ${TASK_ID} --wait --download`);
    expect(out).toContain(`multix runway cancel ${TASK_ID}`);
    expect(out).not.toContain("a coastal city");
  });

  it("image-to-video with --wait: create → poll → download, no signed URL printed", async () => {
    const img = path.join(tmp, "frame.png");
    fs.writeFileSync(img, PNG);
    const fake = stub({
      "POST /v1/image_to_video": [{ json: CREATED }],
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [OUTPUT_URL], cost: { credits: 25 } }) }],
      [`GET ${OUTPUT_URL}`]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    });
    await run("video", "-m", "gen4_turbo", "--image", img, "--ratio", "960:960", "--wait");
    const body = fake.calls[0]?.body as Record<string, unknown>;
    expect(body.model).toBe("gen4_turbo");
    expect(body.promptText).toBeUndefined();
    expect(body.ratio).toBe("960:960");
    expect(String(body.promptImage)).toMatch(/^data:image\/png;base64,/);
    const saved = path.join(tmp, "out", `runway-${TASK_ID.slice(0, 8)}-01.mp4`);
    expect(fs.readFileSync(saved)).toEqual(Buffer.from(MP4));
    const out = text();
    expect(out).toContain("Billed: 25 credits (~$0.25)");
    expect(out).not.toContain("SIGNED_TOKEN");
    expect(out).not.toContain(SECRET);
  });

  it("fails loudly on a FAILED task and reports the failure code", async () => {
    stub({
      "POST /v1/text_to_video": [{ json: CREATED }],
      [TASK_PATH]: [
        {
          json: task("FAILED", {
            failure: "Bad input",
            failureCode: "INPUT_PREPROCESSING.SAFETY.TEXT",
            cost: { credits: 0 },
          }),
        },
      ],
    });
    const err = await run("video", "x", "--wait").catch((e) => e);
    expect(err).toBeInstanceOf(RunwayTaskError);
    expect(err.message).toMatch(/failed \[INPUT_PREPROCESSING\.SAFETY\.TEXT\]: Bad input/);
  });

  it("passes https image URLs through and rejects unsafe ones before any request", async () => {
    const fake = stub({ "POST /v1/image_to_video": [{ json: CREATED }] });
    await run("video", "x", "--image", "https://images.example.com/a.png");
    expect((fake.calls[0]?.body as Record<string, unknown>).promptImage).toBe(
      "https://images.example.com/a.png",
    );
    for (const bad of [
      "http://images.example.com/a.png",
      "https://127.0.0.1/a.png",
      "https://10.0.0.5/a.png",
      "https://[::1]/a.png",
      "https://localhost/a.png",
      `https://images.example.com/${"a".repeat(2050)}.png`,
    ]) {
      const f = stub({});
      await expect(run("video", "x", "--image", bad)).rejects.toThrow(/--image URL/);
      expect(f.calls).toHaveLength(0);
    }
  });

  it("rejects an image URL carrying a username or password before any request", async () => {
    for (const bad of [
      "https://user:pass@images.example.com/a.png",
      "https://user@images.example.com/a.png",
    ]) {
      const f = stub({});
      await expect(run("video", "x", "--image", bad)).rejects.toThrow(/username or password/);
      expect(f.calls).toHaveLength(0);
    }
  });

  it("rejects unsupported image files (GIF, missing) before creating a task", async () => {
    const gif = path.join(tmp, "a.gif");
    fs.writeFileSync(gif, "GIF89a");
    const fake = stub({});
    await expect(run("video", "x", "--image", gif)).rejects.toThrow(
      /\.jpg, \.jpeg, \.png or \.webp/,
    );
    await expect(run("video", "x", "--image", path.join(tmp, "nope.png"))).rejects.toThrow(
      /file not found/,
    );
    await expect(run("video", "x", "--image", "data:image/gif;base64,R0lG")).rejects.toThrow(
      /JPEG, PNG or WebP/,
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("uploads a local image larger than the 5MB data URI limit", async () => {
    const big = path.join(tmp, "big.jpg");
    fs.writeFileSync(big, Buffer.alloc(4 * 1024 * 1024, 1));
    const fake = stub({
      "POST /v1/uploads": [
        {
          json: {
            uploadUrl: "https://uploads.runway.test/b",
            fields: { key: "k" },
            runwayUri: "runway://u/1",
          },
        },
      ],
      "POST https://uploads.runway.test/b": [{ status: 204, text: "" }],
      "POST /v1/image_to_video": [{ json: CREATED }],
    });
    await run("video", "x", "--image", big);
    expect(fake.calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/uploads`,
      "https://uploads.runway.test/b",
      `${BASE}/v1/image_to_video`,
    ]);
    expect((fake.calls[2]?.body as Record<string, unknown>).promptImage).toBe("runway://u/1");
  });
});

describe("runway image", () => {
  it("waits by default and saves the image (with references and tags)", async () => {
    const ref = path.join(tmp, "ref.webp");
    fs.writeFileSync(ref, PNG);
    const fake = stub({
      "POST /v1/text_to_image": [{ json: { id: TASK_ID } }],
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [IMAGE_URL], cost: { credits: 2 } }) }],
      [`GET ${IMAGE_URL}`]: [{ bytes: PNG, headers: { "content-type": "image/png" } }],
    });
    const dest = path.join(tmp, "final.png");
    await run(
      "image",
      "@hero on a beach",
      "-m",
      "gen4_image_turbo",
      "--reference",
      ref,
      "--reference",
      "https://images.example.com/b.jpg",
      "--reference-tag",
      "hero",
      "--output",
      dest,
    );
    const body = fake.calls[0]?.body as { referenceImages: Array<{ uri: string; tag?: string }> };
    expect(body.referenceImages).toHaveLength(2);
    expect(body.referenceImages[0]?.tag).toBe("hero");
    expect(body.referenceImages[0]?.uri).toMatch(/^data:image\/webp;base64,/);
    expect(body.referenceImages[1]).toEqual({ uri: "https://images.example.com/b.jpg" });
    expect(fs.readFileSync(dest)).toEqual(Buffer.from(PNG));
    expect(text()).toContain("Indicative cost: 2 credits (~$0.02)");
  });

  it("--async prints the handle; status --download resumes it", async () => {
    stub({ "POST /v1/text_to_image": [{ json: { id: TASK_ID } }] });
    await run("image", "x", "--async");
    expect(text()).toContain(`Task submitted: ${TASK_ID}`);

    stub({
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [IMAGE_URL] }) }],
      [`GET ${IMAGE_URL}`]: [{ bytes: PNG, headers: { "content-type": "image/png" } }],
    });
    await run("status", TASK_ID, "--download", "--output", `${tmp}/dir/`);
    expect(fs.existsSync(path.join(tmp, "dir", `runway-${TASK_ID.slice(0, 8)}-01.png`))).toBe(true);
  });

  it("--no-download prints the raw output URLs on request", async () => {
    stub({
      "POST /v1/text_to_image": [{ json: { id: TASK_ID } }],
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [IMAGE_URL] }) }],
    });
    await run("image", "x", "--no-download");
    expect(output).toContain(IMAGE_URL);
  });
});

describe("downloads", () => {
  it("refuses a redirect to a private address and exits non-zero with a retry hint", async () => {
    stub({
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [OUTPUT_URL] }) }],
      [`GET ${OUTPUT_URL}`]: [
        {
          status: 302,
          text: "",
          headers: { location: "https://169.254.169.254/latest/meta-data" },
        },
      ],
    });
    const err = await run("status", TASK_ID, "--download").catch((e) => e);
    expect(err.message).toMatch(/none of 1 output file\(s\) could be downloaded/);
    expect(err.message).toContain(`multix runway status ${TASK_ID} --download`);
    expect(text()).toMatch(/local or private address/);
    expect(text()).not.toContain("SIGNED_TOKEN");
  });

  it("refuses a non-https output URL", async () => {
    stub({
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: ["http://cdn.runway.test/a.mp4"] }) }],
    });
    await expect(run("status", TASK_ID, "--download")).rejects.toThrow(
      /none of 1 output file\(s\) could be downloaded/,
    );
    expect(text()).toMatch(/only https/);
  });

  it("stops at MULTIX_MAX_DOWNLOAD_MB and leaves no partial file", async () => {
    vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "0.000005");
    stub({
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [OUTPUT_URL] }) }],
      [`GET ${OUTPUT_URL}`]: [
        { bytes: new Uint8Array(64), headers: { "content-type": "video/mp4" } },
      ],
    });
    await expect(run("status", TASK_ID, "--download")).rejects.toThrow(
      /none of 1 output file\(s\) could be downloaded/,
    );
    expect(text()).toMatch(/exceeds the/);
    const outDir = path.join(tmp, "out");
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
  });

  it("refuses an HTML or JSON body served from a media URL and saves nothing", async () => {
    for (const type of ["text/html; charset=utf-8", "application/json"]) {
      stub({
        [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [OUTPUT_URL] }) }],
        [`GET ${OUTPUT_URL}`]: [
          { text: "<html>expired</html>", headers: { "content-type": type } },
        ],
      });
      await expect(run("status", TASK_ID, "--download")).rejects.toThrow(
        /none of 1 output file\(s\) could be downloaded/,
      );
      expect(text()).toMatch(/not media/);
      const outDir = path.join(tmp, "out");
      expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([]);
    }
  });

  it("explains an expired output URL", async () => {
    stub({
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [OUTPUT_URL] }) }],
      [`GET ${OUTPUT_URL}`]: [{ status: 403, text: "AccessDenied" }],
    });
    await expect(run("status", TASK_ID, "--download")).rejects.toThrow(
      /none of 1 output file\(s\) could be downloaded/,
    );
    expect(text()).toMatch(/may have expired/);
  });
});

describe("runway status", () => {
  /** stdout must be exactly one JSON document, whatever the task state. */
  const stdoutJson = () => JSON.parse(stdout.join("\n"));

  it("prints a JSON summary without signed query strings", async () => {
    stub({
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [OUTPUT_URL], cost: { credits: 60 } }) }],
    });
    await run("status", TASK_ID);
    expect(stdoutJson()).toMatchObject({
      id: TASK_ID,
      status: "SUCCEEDED",
      cost: { credits: 60 },
      output: ["https://cdn.runway.test/out/video.mp4?[redacted]"],
    });
    expect(text()).not.toContain("SIGNED_TOKEN");
    expect(text()).not.toContain(SECRET);
  });

  it("--wait without --download keeps stdout to the JSON summary, never the signed URLs", async () => {
    stub({
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [OUTPUT_URL], cost: { credits: 60 } }) }],
    });
    await run("status", TASK_ID, "--wait");
    expect(stdoutJson()).toMatchObject({ id: TASK_ID, status: "SUCCEEDED" });
    // Progress and cost still reach the user, on stderr.
    expect(text()).toContain(`Waiting for task ${TASK_ID}`);
    expect(text()).toContain("Billed: 60 credits");
    expect(text()).not.toContain("SIGNED_TOKEN");
    expect(text()).not.toContain(SECRET);
  });

  it("keeps stdout parseable for a running task and hints how to resume on stderr", async () => {
    stub({ [TASK_PATH]: [{ json: task("RUNNING", { progress: 0.4 }) }] });
    await run("status", TASK_ID);
    expect(stdoutJson()).toMatchObject({ id: TASK_ID, status: "RUNNING", progress: 0.4 });
    expect(stdout.join("\n")).not.toContain("Resume with");
    expect(text()).toContain(`Resume with: multix runway status ${TASK_ID} --wait --download`);
  });

  it("exits non-zero for a CANCELLED task", async () => {
    stub({ [TASK_PATH]: [{ json: task("CANCELLED") }] });
    await expect(run("status", TASK_ID)).rejects.toThrow(RunwayTaskError);
  });
});

describe("runway cancel", () => {
  it("cancels a running task", async () => {
    const fake = stub({
      [TASK_PATH]: [{ json: task("RUNNING") }],
      [`DELETE /v1/tasks/${TASK_ID}`]: [{ status: 204, text: "" }],
    });
    await run("cancel", TASK_ID);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(text()).toContain(`Task ${TASK_ID} canceled (was RUNNING)`);
  });

  it("refuses to delete a finished task (and its outputs) without --delete", async () => {
    const fake = stub({ [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [OUTPUT_URL] }) }] });
    await expect(run("cancel", TASK_ID)).rejects.toThrow(/already finished.*--delete/);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("deletes a finished task with --delete and treats a racing 404 as done", async () => {
    const fake = stub({
      [TASK_PATH]: [{ json: task("SUCCEEDED", { output: [OUTPUT_URL] }) }],
      [`DELETE /v1/tasks/${TASK_ID}`]: [{ status: 404, json: { error: "Not found" } }],
    });
    await run("cancel", TASK_ID, "--delete");
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(text()).toContain("deleted (was SUCCEEDED)");
  });
});

describe("runway models", () => {
  it("--json lists the active registry offline, without a credential or request", async () => {
    vi.stubEnv("RUNWAYML_API_SECRET", "");
    const fake = stub({});
    await run("models", "--json");
    expect(fake.calls).toHaveLength(0);
    const json = JSON.parse(stdout.join("\n"));
    expect(json).toEqual(listRunwayModels());
    expect(json.video.map((m: { id: string }) => m.id)).toEqual(Object.keys(VIDEO_MODELS));
    expect(json.image.map((m: { id: string }) => m.id)).toEqual(Object.keys(IMAGE_MODELS));
    expect(json.video).toContainEqual(
      expect.objectContaining({
        id: "gen4.5",
        default: true,
        textToVideo: true,
        imageToVideo: true,
        textRatios: ["1280:720", "720:1280"],
        minDuration: 2,
        maxDuration: 10,
      }),
    );
    expect(json.video).toContainEqual(
      expect.objectContaining({ id: "gen4_turbo", default: false, textToVideo: false }),
    );
    expect(json.image).toContainEqual(
      expect.objectContaining({ id: "gen4_image_turbo", minReferences: 1, maxReferences: 3 }),
    );
  });

  it("prints a readable list by default", async () => {
    vi.stubEnv("RUNWAYML_API_SECRET", "");
    const fake = stub({});
    await run("models");
    expect(fake.calls).toHaveLength(0);
    const out = text();
    expect(out).toContain("gen4.5 (default)");
    expect(out).toContain("modes: text-to-video, image-to-video");
    expect(out).toContain("modes: image-to-video");
    expect(out).toContain("duration: 2-10s");
    expect(out).toContain("gen4_image_turbo");
    expect(out).toContain("references: 1-3");
  });
});
