/**
 * TopView commands driven through commander with the real env-based clients
 * (global fetch stubbed with the fake TopView APIs): validation before any
 * request, submit handles on stdout with hints on stderr, wait + download,
 * failure and timeout paths with resume hints, m2v export, the chained and
 * resumable product-avatar flow, API Platform generate and status, credits
 * and upload. No network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PollTimeoutError } from "../../../../src/core/async-poll.js";
import { ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { TopviewTaskError } from "../../../../src/providers/topview/client.js";
import { registerTopviewCommands } from "../../../../src/providers/topview/commands/index.js";
import { TopviewPaymentRequiredError } from "../../../../src/providers/topview/platform-client.js";
import {
  IMAGE_URL,
  KEY,
  LEGACY_BASE,
  PLATFORM_BASE,
  PLATFORM_KEY,
  PREDICTION_ID,
  TASK_ID,
  UID,
  UPLOAD_URL,
  VIDEO_URL,
  createFakeTopview,
  data,
  envelopeError,
  ok,
  prediction,
  routeKey,
} from "./fake-topview.js";

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const M2V_SUBMIT = "POST /v1/m2v/task/submit";
const M2V_QUERY = "GET /v1/m2v/task/query";
const T1 = "topview/topview-t1/text-to-video";
const PLATFORM_SUBMIT = `POST ${PLATFORM_BASE}/models/topview/topview-t1/text-to-video/predictions`;
const PLATFORM_GET = `GET ${PLATFORM_BASE}/predictions/${PREDICTION_ID}`;
const VIDEO_GET = routeKey("GET", VIDEO_URL);
const UPLOAD_ROUTES = {
  "GET /v1/upload/credential": [ok({ fileId: "file_1", uploadUrl: UPLOAD_URL })],
  [routeKey("PUT", UPLOAD_URL)]: [{ text: "" }],
  "GET /v1/upload/check": [ok(true)],
};

let tmp: string;
let output: string[];
/** console.log only: what a pipe would read. */
let stdout: string[];
/** console.error / console.warn only. */
let stderr: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-topview-cmd-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("TOPVIEW_API_KEY", KEY);
  vi.stubEnv("TOPVIEW_UID", UID);
  vi.stubEnv("TOPVIEW_BASE_URL", LEGACY_BASE);
  vi.stubEnv("TOPVIEW_PLATFORM_API_KEY", PLATFORM_KEY);
  vi.stubEnv("TOPVIEW_PLATFORM_BASE_URL", PLATFORM_BASE);
  vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "");
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  output = [];
  stdout = [];
  stderr = [];
  const line = (args: unknown[]) => args.map(String).join(" ");
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output.push(line(args));
    stdout.push(line(args));
  });
  const err = (...args: unknown[]) => {
    output.push(line(args));
    stderr.push(line(args));
  };
  vi.spyOn(console, "warn").mockImplementation(err);
  vi.spyOn(console, "error").mockImplementation(err);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stub(routes: Parameters<typeof createFakeTopview>[0]) {
  const fake = createFakeTopview(routes);
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: (s) => output.push(s), writeOut: (s) => output.push(s) });
  registerTopviewCommands(program);
  await program.parseAsync(["node", "multix", "topview", ...args]);
}

function file(name: string, bytes: Uint8Array = PNG): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, bytes);
  return p;
}

const outFiles = () => fs.readdirSync(path.join(tmp, "out"));
const err = () => stderr.join("\n");
const all = () => output.join("\n");

describe("validation happens before any request", () => {
  const cases: [string, string[], RegExp][] = [
    ["private product URL", ["url-to-video", "http://127.0.0.1/p"], /public address/],
    ["non-http product URL", ["url-to-video", "ftp://shop.example.com/p"], /http:\/\/ or https/],
    [
      "both script modes",
      ["url-to-video", "https://shop.example.com/p", "--script-style", "a", "--script-prompt", "b"],
      /either --script-style or --script-prompt/,
    ],
    [
      "unknown aspect ratio",
      ["url-to-video", "https://shop.example.com/p", "--aspect-ratio", "2:1"],
      /--aspect-ratio must be one of/,
    ],
    [
      "--output without --wait",
      ["url-to-video", "https://shop.example.com/p", "--output", "x.mp4"],
      /need --wait/,
    ],
    [
      "video length out of range",
      ["url-to-video", "https://shop.example.com/p", "--video-length", "5"],
      /--video-length/,
    ],
    [
      "materials without files",
      ["materials-to-video", "--product-name", "Mug"],
      /at least one --file/,
    ],
    [
      "missing material file",
      ["materials-to-video", "--file", "missing.png", "--product-name", "Mug"],
      /file not found: missing.png/,
    ],
    [
      "materials without a product name",
      ["materials-to-video", "--file", "file_abc"],
      /--product-name is required/,
    ],
    [
      "materials without a description",
      ["materials-to-video", "--file", "file_abc", "--product-name", "Mug"],
      /--product-description is required/,
    ],
    ["export with a bad id", ["export", "../x"], /Invalid TopView task id/],
    [
      "two avatar sources",
      ["video-avatar", "--video", "vid_1", "--photo", "img_1", "--tts-text", "hi"],
      /exactly one avatar source/,
    ],
    ["no avatar script", ["video-avatar", "--avatar-id", "av_1"], /exactly one script/],
    [
      "TTS on a photo without a voice",
      ["video-avatar", "--photo", "img_1", "--tts-text", "hi"],
      /needs --voice-id/,
    ],
    [
      "voice speed out of range",
      ["video-avatar", "--avatar-id", "av_1", "--tts-text", "hi", "--voice-speed", "2"],
      /0.8 to 1.2/,
    ],
    [
      "product avatar without a video mode",
      [
        "product-avatar",
        "--product-image",
        "file_p",
        "--avatar-id",
        "av_1",
        "--tts-text",
        "hi",
        "--voice-id",
        "v_1",
      ],
      /--video-mode is required/,
    ],
    [
      "manual placement without a location",
      [
        "product-avatar",
        "--product-cutout",
        "cut_1",
        "--avatar-id",
        "av_1",
        "--image-mode",
        "manual",
        "--replace-only",
      ],
      /needs --location/,
    ],
    [
      "bad location",
      [
        "product-avatar",
        "--product-cutout",
        "cut_1",
        "--avatar-id",
        "av_1",
        "--image-mode",
        "manual",
        "--location",
        "[[0,0],[2,0],[1,1],[0,1]]",
        "--replace-only",
      ],
      /four \[x, y\] points/,
    ],
    [
      "anyshoot without a template",
      [
        "product-anyshoot",
        "--product-image",
        "file_p",
        "--template-mask",
        "file_m",
        "--prompt",
        "x",
      ],
      /--template-id <id> or --template/,
    ],
    [
      "anyshoot count too high",
      [
        "product-anyshoot",
        "--product-image",
        "file_p",
        "--template-mask",
        "file_m",
        "--template-id",
        "t_1",
        "--prompt",
        "x",
        "--count",
        "5",
      ],
      /--count must be a positive integer up to 4/,
    ],
    [
      "unknown platform model",
      ["generate", "openai/sora-9/text-to-video", "--prompt", "x"],
      /Unknown TopView platform model/,
    ],
    [
      "model given twice",
      ["generate", T1, "--model", "alibaba/wan-3.0/text-to-video", "--prompt", "x"],
      /Pass the model once/,
    ],
    ["invalid --input", ["generate", T1, "--input", "{nope"], /--input must be valid JSON/],
    [
      "private image URL",
      ["generate", "topview/topview-t1/image-to-video", "--image", "https://10.0.0.1/a.png"],
      /public address/,
    ],
    [
      "image on text-to-video",
      ["generate", T1, "--prompt", "x", "--image", "https://images.example.com/a.png"],
      /takes no --image/,
    ],
    [
      "undocumented field",
      ["generate", T1, "--prompt", "x", "--input", '{"fps":60}'],
      /body.fps is not a documented field/,
    ],
    [
      "bad idempotency key",
      ["generate", T1, "--prompt", "x", "--idempotency-key", "no spaces allowed"],
      /--idempotency-key/,
    ],
    ["unknown status kind", ["status", "cancel", TASK_ID], /Unknown task kind/],
    ["bad prediction id", ["status", "platform", "../x"], /Invalid TopView prediction id/],
    ["upload of a missing file", ["upload", "missing.png"], /File not found/],
  ];

  it.each(cases)("%s", async (_name, args, message) => {
    const fake = stub({});
    await expect(run(...args)).rejects.toThrow(message);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a WebP product image in anyshoot easy mode", async () => {
    const fake = stub({});
    const webp = file("p.webp");
    await expect(
      run(
        "product-anyshoot",
        "--product-image",
        webp,
        "--template-mask",
        "file_m",
        "--template-id",
        "t_1",
        "--prompt",
        "x",
      ),
    ).rejects.toThrow(/WebP/);
    expect(fake.calls).toHaveLength(0);
  });

  it("names the missing credential", async () => {
    vi.stubEnv("TOPVIEW_UID", "");
    stub({});
    await expect(run("url-to-video", "https://shop.example.com/p")).rejects.toThrow(
      /TOPVIEW_UID is not set/,
    );
    vi.stubEnv("TOPVIEW_PLATFORM_API_KEY", "");
    await expect(run("generate", T1, "--prompt", "x")).rejects.toThrow(
      /TOPVIEW_PLATFORM_API_KEY is not set/,
    );
  });
});

describe("marketing videos (m2v)", () => {
  it("submits url-to-video and prints only the task id on stdout", async () => {
    const fake = stub({ [M2V_SUBMIT]: [ok({ taskId: TASK_ID, status: "init" })] });
    await run(
      "url-to-video",
      "https://shop.example.com/p",
      "--aspect-ratio",
      "16:9",
      "--language",
      "vi",
      "--preview",
    );
    expect(stdout).toEqual([TASK_ID]);
    expect(fake.calls[0]?.body).toEqual({
      productLink: "https://shop.example.com/p",
      aspectRatio: "16:9",
      language: "vi",
      preview: "true",
    });
    expect(fake.calls[0]?.headers["topview-uid"]).toBe(UID);
    expect(err()).toContain(`Check:  multix topview status m2v ${TASK_ID}`);
    expect(err()).toContain(`Resume: multix topview status m2v ${TASK_ID} --wait --download`);
  });

  it("waits and downloads the video without printing the signed URL", async () => {
    stub({
      [M2V_SUBMIT]: [ok({ taskId: TASK_ID, status: "init" })],
      [M2V_QUERY]: [
        ok({
          taskId: TASK_ID,
          status: "success",
          costCredit: 5,
          previewVideos: [{ scriptId: 1, status: "success", videoUrl: VIDEO_URL }],
        }),
      ],
      [VIDEO_GET]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    });
    await run("url-to-video", "https://shop.example.com/p", "--wait");
    expect(outFiles()).toEqual(["topview-task0123-01.mp4"]);
    expect(stdout.join("\n")).toContain(`Saved 1 file(s) from task ${TASK_ID}`);
    expect(err()).toContain("Credits charged: 5");
    expect(all()).not.toContain("SIGNED_TOKEN");
    expect(all()).not.toContain(KEY);
  });

  it("fails loudly when the task fails, and downloads nothing", async () => {
    stub({
      [M2V_SUBMIT]: [ok({ taskId: TASK_ID, status: "init" })],
      [M2V_QUERY]: [ok({ taskId: TASK_ID, status: "fail", errorMsg: "product page unreadable" })],
    });
    const error = await run("url-to-video", "https://shop.example.com/p", "--wait").catch((e) => e);
    expect(error).toBeInstanceOf(TopviewTaskError);
    expect(error.message).toContain("product page unreadable");
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
  });

  it("prints the resume command when polling times out", async () => {
    stub({
      [M2V_SUBMIT]: [ok({ taskId: TASK_ID, status: "init" })],
      [M2V_QUERY]: [ok({ taskId: TASK_ID, status: "running" })],
    });
    const error = await run(
      "url-to-video",
      "https://shop.example.com/p",
      "--wait",
      "--wait-timeout",
      "1",
    ).catch((e) => e);
    expect(error).toBeInstanceOf(PollTimeoutError);
    expect(error.message).toContain(
      `Resume with: multix topview status m2v ${TASK_ID} --wait --download`,
    );
  });

  it("uploads local materials and submits their file ids", async () => {
    const fake = stub({
      ...UPLOAD_ROUTES,
      [M2V_SUBMIT]: [ok({ taskId: TASK_ID, status: "init" })],
    });
    const png = file("mug.png");
    await run(
      "materials-to-video",
      "--file",
      png,
      "--file",
      "file_2",
      "--product-name",
      "Mug",
      "--script-prompt",
      "funny",
    );
    const submit = fake.calls.find((c) => c.key === M2V_SUBMIT);
    expect(submit?.body).toEqual({
      fileIds: ["file_1", "file_2"],
      productName: "Mug",
      isDiyScript: "true",
      diyStyle: "diyScriptPrompt",
      diyScriptPrompt: "funny",
    });
    expect(fake.calls.filter((c) => c.method === "PUT")).toHaveLength(1);
  });

  it("exports one script and prints its raw URL with --no-download", async () => {
    const fake = stub({
      "POST /v1/m2v/export": [ok({ taskId: TASK_ID, status: "running" })],
      [M2V_QUERY]: [
        ok({
          taskId: TASK_ID,
          status: "success",
          previewVideos: [{ scriptId: 2, status: "success", videoUrl: IMAGE_URL }],
          exportVideos: [{ scriptId: 2, status: "success", videoUrl: VIDEO_URL }],
        }),
      ],
    });
    await run("export", TASK_ID, "--script-id", "2", "--wait", "--no-download");
    expect(fake.calls[0]?.body).toEqual({ taskId: TASK_ID, scriptId: "2" });
    expect(stdout).toEqual([VIDEO_URL]);
  });

  it("fails an export that finished without a video", async () => {
    stub({
      "POST /v1/m2v/export": [ok({ taskId: TASK_ID, status: "running" })],
      [M2V_QUERY]: [
        ok({ taskId: TASK_ID, status: "success", exportVideos: [{ scriptId: 2, status: "fail" }] }),
      ],
    });
    await expect(run("export", TASK_ID, "--script-id", "2", "--wait")).rejects.toThrow(
      /export finished without a video/,
    );
  });
});

describe("video-avatar and product-anyshoot", () => {
  it("submits a public avatar with TTS", async () => {
    const fake = stub({
      "POST /v1/video_avatar/task/submit": [ok({ taskId: TASK_ID, status: "init" })],
    });
    await run(
      "video-avatar",
      "--avatar-id",
      "av_1",
      "--tts-text",
      " Hello ",
      "--mode",
      "avatar2",
      "--voice-speed",
      "1.1",
    );
    expect(fake.calls[0]?.body).toEqual({
      avatarSourceFrom: "1",
      audioSourceFrom: "1",
      aiAvatarId: "av_1",
      modeType: "1",
      ttsText: "Hello",
      voiceSpeed: 1.1,
    });
    expect(stdout).toEqual([TASK_ID]);
  });

  it("submits an anyshoot with the documented fields", async () => {
    const fake = stub({ "POST /v1/product_anyShoot/task/submit": [ok({ taskId: TASK_ID })] });
    await run(
      "product-anyshoot",
      "--product-image",
      "file_p",
      "--template-mask",
      "file_m",
      "--template-id",
      "tpl_1",
      "--prompt",
      "on a desk",
      "--count",
      "2",
    );
    expect(fake.calls[0]?.body).toEqual({
      mode: "easy",
      easyModePrompt: "on a desk",
      generatingCount: "2",
      templateId: "tpl_1",
      productImageFileId: "file_p",
      templateMaskFileId: "file_m",
    });
  });
});

describe("product-avatar chain", () => {
  const RB_SUBMIT = "POST /v1/common_task/remove_background/submit";
  const RB_QUERY = "GET /v1/common_task/remove_background/query";
  const RP_SUBMIT = "POST /v3/product_avatar/task/image_replace/submit";
  const RP_QUERY = "GET /v3/product_avatar/task/image_replace/query";
  const VID_SUBMIT = "POST /v3/product_avatar/task/image2Video/submit";
  const replaceDone = (faceExistence: boolean) =>
    ok({
      taskId: "rp_1",
      status: "success",
      replaceProductResult: [{ imageId: "img_1", url: IMAGE_URL, faceExistence }],
    });

  it("removes the background, places the product, then submits the video", async () => {
    const fake = stub({
      ...UPLOAD_ROUTES,
      [RB_SUBMIT]: [ok({ taskId: "rb_1", status: "init" })],
      [RB_QUERY]: [ok({ taskId: "rb_1", status: "success", bgRemovedImageFileId: "cut_1" })],
      [RP_SUBMIT]: [ok({ taskId: "rp_1", status: "init" })],
      [RP_QUERY]: [replaceDone(true)],
      [VID_SUBMIT]: [ok({ taskId: "vid_1", status: "init" })],
    });
    const png = file("bottle.png");
    await run(
      "product-avatar",
      "--product-image",
      png,
      "--avatar-id",
      "av_1",
      "--video-mode",
      "avatar4",
      "--tts-text",
      "Buy it",
      "--voice-id",
      "v_1",
    );

    const body = (key: string) => fake.calls.find((c) => c.key === key)?.body;
    expect(body(RB_SUBMIT)).toEqual({ productImageFileId: "file_1" });
    expect(body(RP_SUBMIT)).toEqual({
      generateImageMode: "auto",
      avatarId: "av_1",
      productImageWithoutBackgroundFileId: "cut_1",
    });
    expect(body(VID_SUBMIT)).toEqual({
      mode: "avatar4",
      scriptMode: "text",
      ttsText: "Buy it",
      voiceId: "v_1",
      replaceProductTaskImageId: "img_1",
    });
    expect(stdout).toEqual(["vid_1"]);
    expect(err()).toContain("Step remove-background: task rb_1");
    expect(err()).toContain("resume with --product-cutout cut_1");
    expect(err()).toContain("Step product-avatar-replace: task rp_1");
    expect(err()).toContain("resume with --replace-image-id img_1");
    expect(err()).toContain(
      "Resume: multix topview status product-avatar-video vid_1 --wait --download",
    );
  });

  it("stops before the video when the image has no face, with a resume hint", async () => {
    const fake = stub({
      [RP_SUBMIT]: [ok({ taskId: "rp_1", status: "init" })],
      [RP_QUERY]: [replaceDone(false)],
    });
    const error = await run(
      "product-avatar",
      "--product-cutout",
      "cut_1",
      "--avatar-id",
      "av_1",
      "--video-mode",
      "avatar4",
      "--tts-text",
      "Buy it",
      "--voice-id",
      "v_1",
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain("--replace-image-id img_1 --video-mode avatar2");
    expect(fake.calls.some((c) => c.key === VID_SUBMIT)).toBe(false);
  });

  it("resumes at the video step from a replace image id", async () => {
    const fake = stub({ [VID_SUBMIT]: [ok({ taskId: "vid_1", status: "init" })] });
    await run(
      "product-avatar",
      "--replace-image-id",
      "img_1",
      "--video-mode",
      "avatar2",
      "--audio",
      "aud_1",
    );
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.body).toEqual({
      mode: "avatar2",
      scriptMode: "audio",
      replaceProductTaskImageId: "img_1",
      audioFileId: "aud_1",
    });
  });

  it("fails the chain when background removal fails", async () => {
    const fake = stub({
      [RB_SUBMIT]: [ok({ taskId: "rb_1", status: "init" })],
      [RB_QUERY]: [ok({ taskId: "rb_1", status: "fail", errorMsg: "no product found" })],
    });
    await expect(
      run("product-avatar", "--product-image", "file_p", "--avatar-id", "av_1", "--replace-only"),
    ).rejects.toThrow(/no product found/);
    expect(fake.calls.some((c) => c.key === RP_SUBMIT)).toBe(false);
  });
});

describe("API Platform generate", () => {
  it("submits, waits and downloads, logging the estimate and the charge", async () => {
    const fake = stub({
      [PLATFORM_SUBMIT]: [data(prediction("created"))],
      [PLATFORM_GET]: [
        data(
          prediction("completed", {
            outputs: [VIDEO_URL],
            charged_usd: "0.8245",
            billing_state: "settled",
          }),
        ),
      ],
      [VIDEO_GET]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    });
    await run("generate", T1, "--prompt", "a cat", "--wait");
    const submit = fake.calls[0];
    expect(submit?.headers.authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(submit?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(submit?.body).toEqual({ content: [{ type: "text", text: "a cat" }] });
    expect(err()).toContain("Estimated cost: up to $0.8245");
    expect(err()).toContain("Charged: $0.8245 (billing settled)");
    expect(outFiles()).toEqual(["topview-pred0123-01.mp4"]);
    expect(all()).not.toContain("SIGNED_TOKEN");
    expect(all()).not.toContain(PLATFORM_KEY);
  });

  it("prints the prediction id and sends the given idempotency key", async () => {
    const fake = stub({ [PLATFORM_SUBMIT]: [data(prediction("created"))] });
    await run("generate", "--model", T1, "--prompt", "a cat", "--idempotency-key", "retry-key-123");
    expect(stdout).toEqual([PREDICTION_ID]);
    expect(fake.calls[0]?.headers["idempotency-key"]).toBe("retry-key-123");
    expect(err()).toContain(
      `Resume: multix topview status platform ${PREDICTION_ID} --wait --download`,
    );
  });

  it("uploads a local image and sends its download URL", async () => {
    const fake = stub({
      [`POST ${PLATFORM_BASE}/media/files`]: [data({ id: "media_1", download_url: IMAGE_URL })],
      [`POST ${PLATFORM_BASE}/models/topview/topview-t1/image-to-video/predictions`]: [
        data(prediction("created")),
      ],
    });
    const png = file("frame.png");
    await run("generate", "topview/topview-t1/image-to-video", "--image", png, "--prompt", "move");
    expect(fake.calls[1]?.body).toEqual({
      content: [
        { type: "text", text: "move" },
        { type: "image_url", role: "first_frame", image_url: { url: IMAGE_URL } },
      ],
    });
  });

  it("explains a safe retry after an ambiguous submit", async () => {
    const fake = stub({ [PLATFORM_SUBMIT]: [data({ status: "created" })] });
    const error = await run(
      "generate",
      T1,
      "--prompt",
      "a cat",
      "--idempotency-key",
      "retry-key-123",
    ).catch((e) => e);
    expect(error.message).toContain(
      "Safe retry: run the same command again with --idempotency-key retry-key-123",
    );
    expect(fake.calls).toHaveLength(1);
  });
});

describe("status", () => {
  it("prints a running legacy task with redacted URLs and a resume hint", async () => {
    stub({
      [M2V_QUERY]: [
        ok({
          taskId: TASK_ID,
          status: "running",
          previewVideos: [{ scriptId: 1, status: "success", videoUrl: VIDEO_URL }],
        }),
      ],
    });
    await run("status", "url-to-video", TASK_ID);
    const summary = JSON.parse(stdout.join("\n"));
    expect(summary).toMatchObject({ kind: "m2v", taskId: TASK_ID, status: "running" });
    expect(all()).not.toContain("SIGNED_TOKEN");
    expect(err()).toContain(
      `Still running. Resume with: multix topview status m2v ${TASK_ID} --wait --download`,
    );
  });

  it("downloads a finished legacy task", async () => {
    stub({
      "GET /v1/video_avatar/task/query": [
        ok({ taskId: TASK_ID, status: "success", outputVideoUrl: VIDEO_URL }),
      ],
      [VIDEO_GET]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    });
    await run("status", "video-avatar", TASK_ID, "--download");
    expect(outFiles()).toEqual(["topview-task0123-01.mp4"]);
  });

  it("names the refetch command when a download fails", async () => {
    stub({
      "GET /v1/video_avatar/task/query": [
        ok({ taskId: TASK_ID, status: "success", outputVideoUrl: VIDEO_URL }),
      ],
      [VIDEO_GET]: [{ status: 403, text: "expired" }],
    });
    await expect(run("status", "video-avatar", TASK_ID, "--download")).rejects.toThrow(
      `Retry: multix topview status video-avatar ${TASK_ID} --download`,
    );
    expect(all()).not.toContain("SIGNED_TOKEN");
  });

  it("fails on a failed legacy task after printing it", async () => {
    stub({
      "GET /v1/video_avatar/task/query": [
        ok({ taskId: TASK_ID, status: "fail", errorMsg: "bad audio" }),
      ],
    });
    await expect(run("status", "video-avatar", TASK_ID)).rejects.toThrow(TopviewTaskError);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ status: "fail", errorMsg: "bad audio" });
  });

  it("stops at payment_required with the top-up and resume hints", async () => {
    stub({ [PLATFORM_GET]: [data(prediction("payment_required", { amount_due_usd: "0.5" }))] });
    const error = await run("status", "platform", PREDICTION_ID, "--wait").catch((e) => e);
    expect(error).toBeInstanceOf(TopviewPaymentRequiredError);
    expect(error.message).toContain("amount due $0.5");
    expect(err()).toContain(
      `After topping up, resume with: multix topview status platform ${PREDICTION_ID} --wait --download`,
    );
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ status: "payment_required" });
  });

  it("surfaces a legacy API error code", async () => {
    stub({ [M2V_QUERY]: [envelopeError("4004", "task not found")] });
    await expect(run("status", "m2v", TASK_ID)).rejects.toThrow(/code 4004/);
  });
});

describe("account helpers", () => {
  it("prints remaining credits and never the account's API keys", async () => {
    stub({
      "GET /user/credit/detail": [
        ok({
          remainCredit: 42,
          expiredTime: "2027-01-01",
          apiKeyMap: [{ apiKey: KEY, costCredit: 1 }],
        }),
      ],
    });
    await run("credits");
    expect(stdout).toEqual(["Remaining credits: 42", "Expires: 2027-01-01"]);
    expect(err()).toContain("API Platform (USD) balance is separate");
    expect(all()).not.toContain(KEY);
  });

  it("uploads a file and prints its fileId", async () => {
    stub(UPLOAD_ROUTES);
    await run("upload", file("logo.png"));
    expect(stdout).toEqual(["file_1"]);
  });

  it("lists models as JSON without schemas", async () => {
    stub({});
    await run("models", "--json");
    const rows = JSON.parse(stdout.join("\n")) as Record<string, unknown>[];
    expect(rows).toHaveLength(22);
    expect(rows[0]).not.toHaveProperty("schema");
    expect(rows[0]).toHaveProperty("verified_at");
  });
});
