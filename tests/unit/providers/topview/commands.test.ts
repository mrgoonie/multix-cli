/**
 * TopView commands driven through commander with the real env-based clients
 * (global fetch stubbed with the fake TopView hosts): validation before any
 * upload or paid request, async handles, uploads, the product-avatar stage
 * chain and its resume points, status/prediction resume with downloads, the
 * platform route allowlist, the catalog cache, and logs free of secrets,
 * signed URLs and prompts. No network or paid calls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerTopviewCommands } from "../../../../src/providers/topview/commands/index.js";
import {
  type FakeResponse,
  IMAGE_URL,
  LEGACY_BASE,
  LEGACY_KEY,
  MP4,
  PLATFORM_BASE,
  PLATFORM_KEY,
  PNG,
  PREDICTION_ID,
  TASK_ID,
  UID,
  UPLOAD_URL,
  VIDEO_URL,
  createFakeTopview,
  data,
  legacyError,
  ok,
  prediction,
  uploadRoutes,
} from "./fake-topview.js";

const PROMPT = "SECRET-PROMPT-do-not-log";
const T1 = "11111111111111111111111111111111";
const T2 = "22222222222222222222222222222222";
const T3 = "33333333333333333333333333333333";

let tmp: string;
let output: string[];
let stdout: string[];
let productPng: string;
let voiceMp3: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "multix-topview-cmd-"));
  vi.stubEnv("MULTIX_OUTPUT_DIR", path.join(tmp, "out"));
  vi.stubEnv("MULTIX_CACHE_DIR", path.join(tmp, "cache"));
  vi.stubEnv("MULTIX_MODELS_TTL", "");
  vi.stubEnv("MULTIX_MAX_DOWNLOAD_MB", "");
  vi.stubEnv("TOPVIEW_API_KEY", LEGACY_KEY);
  vi.stubEnv("TOPVIEW_UID", UID);
  vi.stubEnv("TOPVIEW_BASE_URL", LEGACY_BASE);
  vi.stubEnv("TOPVIEW_PLATFORM_API_KEY", PLATFORM_KEY);
  vi.stubEnv("TOPVIEW_PLATFORM_BASE_URL", PLATFORM_BASE);
  vi.stubEnv("NO_COLOR", "1");
  _resetOutputDir();
  productPng = path.join(tmp, "product.png");
  voiceMp3 = path.join(tmp, "voice.mp3");
  fs.writeFileSync(productPng, PNG);
  fs.writeFileSync(voiceMp3, new Uint8Array([0x49, 0x44, 0x33, 4]));
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
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    output.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stub(routes: Record<string, FakeResponse[]>) {
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

const text = () => output.join("\n");
const savedFiles = () => fs.readdirSync(path.join(tmp, "out")).sort();

function expectCleanLogs(): void {
  const all = text();
  for (const secret of [LEGACY_KEY, PLATFORM_KEY, PROMPT, "SIGNED_OUT_SIG", "SIGNED_UPLOAD_SIG"]) {
    expect(all).not.toContain(secret);
  }
}

describe("validation before any request", () => {
  it.each([
    [["url-to-video", "ftp://shop.example/p"], /must be an http:\/\/ or https:\/\/ URL/],
    [["url-to-video", "https://u:p@shop.example/p"], /username or password/],
    [
      ["url-to-video", "https://shop.example/p", "--aspect-ratio", "2:1"],
      /--aspect-ratio must be one of/,
    ],
    [["url-to-video", "https://shop.example/p", "--video-length-type", "5"], /--video-length-type/],
    [["url-to-video", "https://shop.example/p", "--output", "a.mp4"], /need --wait/],
    [["materials-to-video"], /at least one --file/],
    [["materials-to-video", "--file", "x.png"], /--product-name and --product-description/],
    [["video-avatar", "--tts-text", "hi"], /exactly one avatar source/],
    [["video-avatar", "--avatar-id", "a1"], /exactly one audio source/],
    [
      ["video-avatar", "--avatar-id", "a1", "--custom-avatar", "--tts-text", "hi"],
      /needs --voice-id/,
    ],
    [
      ["video-avatar", "--avatar-id", "a1", "--tts-text", "hi", "--voice-speed", "2"],
      /--voice-speed/,
    ],
    [
      ["product-avatar", "--mode", "avatar4", "--tts-text", "x", "--voice-id", "v"],
      /exactly one of --product-image/,
    ],
    [
      ["product-avatar", "--replace-image-id", "i1", "--tts-text", "x", "--voice-id", "v"],
      /--mode is required/,
    ],
    [
      ["product-avatar", "--replace-image-id", "i1", "--mode", "avatar9", "--tts-text", "x"],
      /--mode must be one of/,
    ],
    [
      ["product-avatar", "--replace-image-id", "i1", "--mode", "avatar4", "--tts-text", "x"],
      /--tts-text needs --voice-id/,
    ],
    [
      [
        "product-avatar",
        "--replace-image-id",
        "i1",
        "--mode",
        "avatar4",
        "--tts-text",
        "x",
        "--voice-id",
        "v",
        "--avatar-id",
        "a",
      ],
      /resumes at stage 3/,
    ],
    [
      [
        "product-avatar",
        "--bg-removed-file-id",
        "f1",
        "--mode",
        "avatar4",
        "--tts-text",
        "x",
        "--voice-id",
        "v",
        "--avatar-id",
        "a",
      ],
      /auto needs --image-edit-prompt/,
    ],
    [
      [
        "product-avatar",
        "--bg-removed-file-id",
        "f1",
        "--mode",
        "avatar4",
        "--tts-text",
        "x",
        "--voice-id",
        "v",
        "--avatar-id",
        "a",
        "--generate-image-mode",
        "manual",
        "--location",
        "[[0,0]]",
      ],
      /--location must be four/,
    ],
    [["product-anyshoot", "--product-file-id", "f1"], /--mode is required/],
    [
      ["product-anyshoot", "--mode", "try-on", "--product-file-id", "f1", "--template-id", "t"],
      /--template-mask/,
    ],
    [
      [
        "product-anyshoot",
        "--mode",
        "try-on",
        "--product-file-id",
        "f1",
        "--template-id",
        "t",
        "--template-mask",
        "m.png",
        "--prompt",
        "x",
      ],
      /--prompt do\(es\) not apply to --mode try-on/,
    ],
    [
      ["product-anyshoot", "--mode", "background", "--product-file-id", "f1", "--prompt", "x"],
      /needs --location/,
    ],
    [["status", "video", TASK_ID], /kind/i],
    [["status", "m2v", "../user/credit"], /task id/],
    [["m2v-export", TASK_ID, "1.5"], /<scriptId> must be a whole number/],
    [
      ["run", "openai/sora/text-to-video", "--input", "{}"],
      /Unsupported TopView API Platform route/,
    ],
    [["run", "bytedance/seedance-2.0/text-to-video"], /--input <json\|@file> is required/],
    [["run", "bytedance/seedance-2.0/text-to-video", "--input", '{"prompt":"x"}'], /content/],
    [["run", "bytedance/seedance-2.0/text-to-video", "--input", "[1]"], /JSON object/],
    [["prediction", "bad/id"], /prediction id|Invalid/i],
    [["upload", "missing.png"], /<file> file not found/],
  ])("%j", async (args, re) => {
    const fake = stub({});
    await expect(run(...args)).rejects.toThrow(re);
    expect(fake.calls).toHaveLength(0);
  });

  it("rejects a file type the upload credential does not accept", async () => {
    const notes = path.join(tmp, "notes.txt");
    fs.writeFileSync(notes, "hello");
    const fake = stub({});
    await expect(run("upload", notes)).rejects.toThrow(/must be a png, .* file/);
    expect(fake.calls).toHaveLength(0);
  });

  it("names both legacy credentials when TOPVIEW_UID is missing", async () => {
    vi.stubEnv("TOPVIEW_UID", "");
    const fake = stub({});
    await expect(run("credit")).rejects.toThrow(/TOPVIEW_UID is not set.*api-settings/);
    expect(fake.calls).toHaveLength(0);
  });

  it("does not fall back from the platform key to the legacy key", async () => {
    vi.stubEnv("TOPVIEW_PLATFORM_API_KEY", "");
    const fake = stub({});
    await expect(run("prediction", PREDICTION_ID)).rejects.toThrow(
      /TOPVIEW_PLATFORM_API_KEY is not set/,
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("Legacy API commands", () => {
  it("url-to-video submits the product link and prints the async handle", async () => {
    const fake = stub({ "POST /v1/m2v/task/submit": [ok({ taskId: TASK_ID, status: "init" })] });
    await run(
      "url-to-video",
      "https://shop.example/p/1",
      "--product-description",
      PROMPT,
      "--video-length-type",
      "2",
    );
    expect(fake.calls[0]?.body).toEqual({
      productLink: "https://shop.example/p/1",
      productDescription: PROMPT,
      videoLengthType: 2,
    });
    expect(stdout.join("\n")).toContain(`Task submitted: ${TASK_ID}`);
    expect(text()).toContain(`multix topview status m2v ${TASK_ID} --wait --download`);
    expect(text()).toMatch(/Cancel: not available/);
    expectCleanLogs();
  });

  it("materials-to-video uploads each file, then submits the fileIds", async () => {
    const second = path.join(tmp, "b.png");
    fs.writeFileSync(second, PNG);
    const upload2 = "https://s3.topview.test/uploads/def?X-Amz-Signature=SIGNED_UPLOAD_SIG";
    const fake = stub({
      "GET /v1/upload/credential?format=png": [
        ok({ fileId: "f_a", uploadUrl: UPLOAD_URL }),
        ok({ fileId: "f_b", uploadUrl: upload2 }),
      ],
      [`PUT ${UPLOAD_URL}`]: [{ text: "" }],
      [`PUT ${upload2}`]: [{ text: "" }],
      "GET /v1/upload/check?fileId=f_a": [ok(true)],
      "GET /v1/upload/check?fileId=f_b": [ok(true)],
      "POST /v1/m2v/task/submit": [ok({ taskId: TASK_ID })],
    });
    await run(
      "materials-to-video",
      "--file",
      productPng,
      "--file",
      second,
      "--product-name",
      "Mug",
      "--product-description",
      PROMPT,
    );
    expect(fake.of("POST /v1/m2v/task/submit")[0]?.body).toMatchObject({
      fileIds: ["f_a", "f_b"],
      productName: "Mug",
    });
    expectCleanLogs();
  });

  it("video-avatar --wait uploads audio, polls and downloads the video", async () => {
    const fake = stub({
      ...uploadRoutes("mp3", "f_audio"),
      "POST /v1/video_avatar/task/submit": [ok({ taskId: TASK_ID })],
      [`GET /v1/video_avatar/task/query?taskId=${TASK_ID}`]: [
        ok({ taskId: TASK_ID, status: "success", outputVideoUrl: VIDEO_URL, costCredit: 3 }),
      ],
      [`GET ${VIDEO_URL}`]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    });
    await run("video-avatar", "--avatar-id", "av1", "--audio", voiceMp3, "--wait");
    expect(fake.of("POST /v1/video_avatar/task/submit")[0]?.body).toEqual({
      aiAvatarId: "av1",
      avatarSourceFrom: "1",
      audioSourceFrom: "0",
      audioFileId: "f_audio",
    });
    expect(savedFiles()).toEqual(["topview-a1b2c3d4-01.mp4"]);
    expect(text()).toMatch(/3 credits \(Legacy API plan credits\)/);
    expectCleanLogs();
  });

  it("refuses a remote input on a private address before uploading", async () => {
    const fake = stub({});
    await expect(
      run(
        "video-avatar",
        "--image",
        "https://10.0.0.5/face.png",
        "--tts-text",
        "hi",
        "--voice-id",
        "v",
      ),
    ).rejects.toThrow(/private address/);
    expect(fake.calls).toHaveLength(0);
  });

  it("status m2v --wait --download saves the exported video", async () => {
    stub({
      [`GET /v1/m2v/task/query?taskId=${TASK_ID}`]: [
        ok({
          taskId: TASK_ID,
          status: "success",
          exportVideos: [{ scriptId: 2, status: "success", videoUrl: VIDEO_URL }],
        }),
      ],
      [`GET ${VIDEO_URL}`]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    });
    await run("status", "m2v", TASK_ID, "--wait", "--download");
    expect(savedFiles()).toEqual(["topview-a1b2c3d4-01.mp4"]);
    expectCleanLogs();
  });

  it("status prints only JSON on stdout, with URLs stripped of their signatures", async () => {
    stub({
      [`GET /v1/video_avatar/task/query?taskId=${TASK_ID}`]: [
        ok({ taskId: TASK_ID, status: "success", outputVideoUrl: VIDEO_URL }),
      ],
    });
    await run("status", "video-avatar", TASK_ID);
    const json = JSON.parse(stdout.join("\n"));
    expect(json).toMatchObject({ kind: "video-avatar", taskId: TASK_ID, status: "success" });
    expectCleanLogs();
  });

  it("status of a failed task prints its summary and exits non-zero", async () => {
    stub({
      [`GET /v1/video_avatar/task/query?taskId=${TASK_ID}`]: [
        ok({ taskId: TASK_ID, status: "fail", errorMsg: "face not found" }),
      ],
    });
    await expect(run("status", "video-avatar", TASK_ID)).rejects.toThrow(
      /video-avatar task .* fail: face not found/,
    );
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ status: "fail" });
  });

  it("upload prints the fileId as JSON", async () => {
    stub(uploadRoutes("png", "f_up"));
    await run("upload", productPng);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      fileId: "f_up",
      name: "product.png",
      format: "png",
    });
    expectCleanLogs();
  });

  it("credit prints the balance and never the API key map keys", async () => {
    stub({
      "GET /user/credit/detail": [
        ok({ remainCredit: 99, apiKeyMap: { [LEGACY_KEY]: [{ taskId: TASK_ID, costCredit: 2 }] } }),
      ],
    });
    await run("credit");
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ remainCredit: 99 });
    expect(text()).toMatch(/separate USD balance/);
    expectCleanLogs();
  });

  it("a 4100 error points at the credit command", async () => {
    stub({ "POST /v1/m2v/task/submit": [legacyError("4100", "insufficient")] });
    await expect(run("url-to-video", "https://shop.example/p")).rejects.toThrow(
      /not enough.*multix topview credit/,
    );
  });

  it("product-anyshoot background sends location, mode and similarity", async () => {
    const fake = stub({
      "POST /v3/product_anyShoot/product_background/task/submit": [ok({ taskId: TASK_ID })],
    });
    await run(
      "product-anyshoot",
      "--mode",
      "background",
      "--product-file-id",
      "f_nobg",
      "--prompt",
      PROMPT,
      "--location",
      "[[0.2,0.2],[0.6,0.2],[0.6,0.6],[0.2,0.6]]",
      "--similarity",
      "creative",
    );
    expect(fake.calls[0]?.body).toEqual({
      productImageWithoutBackgroundFileId: "f_nobg",
      mode: "prompt",
      prompt: PROMPT,
      location: [
        [0.2, 0.2],
        [0.6, 0.2],
        [0.6, 0.6],
        [0.2, 0.6],
      ],
      productSimilarity: "creative",
    });
    expect(text()).toContain(`multix topview status anyshoot-background ${TASK_ID}`);
    expectCleanLogs();
  });
});

describe("product-avatar chain", () => {
  const REMOVE = "POST /v1/common_task/remove_background/submit";
  const REPLACE = "POST /v3/product_avatar/task/image_replace/submit";
  const VIDEO = "POST /v3/product_avatar/task/image2Video/submit";
  const stage3 = ["--mode", "avatar4", "--tts-text", PROMPT, "--voice-id", "voice1"];

  function chainRoutes(): Record<string, FakeResponse[]> {
    return {
      ...uploadRoutes("png", "f_prod"),
      [REMOVE]: [ok({ taskId: T1 })],
      [`GET /v1/common_task/remove_background/query?taskId=${T1}`]: [
        ok({ taskId: T1, status: "success", bgRemovedImageFileId: "f_nobg" }),
      ],
      [REPLACE]: [ok({ taskId: T2 })],
      [`GET /v3/product_avatar/task/image_replace/query?taskId=${T2}`]: [
        ok({
          taskId: T2,
          status: "success",
          replaceProductResult: [
            { imageId: "img_noface", url: IMAGE_URL, faceExistence: false },
            { imageId: "img_face", url: IMAGE_URL, faceExistence: true },
          ],
        }),
      ],
      [VIDEO]: [ok({ taskId: T3 })],
      [`GET /v3/product_avatar/task/image2Video/query?taskId=${T3}`]: [
        ok({ taskId: T3, status: "success", "finishedVideoUrl ": VIDEO_URL, costCredit: "8" }),
      ],
      [`GET ${VIDEO_URL}`]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    };
  }

  it("hands each stage's output to the next and downloads the video", async () => {
    const fake = stub(chainRoutes());
    await run(
      "product-avatar",
      "--product-image",
      productPng,
      "--avatar-id",
      "pa1",
      "--image-edit-prompt",
      PROMPT,
      ...stage3,
    );
    expect(fake.of(REMOVE)[0]?.body).toEqual({ productImageFileId: "f_prod" });
    expect(fake.of(REPLACE)[0]?.body).toEqual({
      generateImageMode: "auto",
      templateImageFileId: "",
      imageEditPrompt: PROMPT,
      avatarId: "pa1",
      productImageWithoutBackgroundFileId: "f_nobg",
    });
    // avatar4 needs a face: the faceless first result is skipped.
    expect(fake.of(VIDEO)[0]?.body).toEqual({
      mode: "avatar4",
      scriptMode: "text",
      ttsText: PROMPT,
      voiceId: "voice1",
      replaceProductTaskImageId: "img_face",
    });
    expect(savedFiles()).toEqual(["topview-33333333-01.mp4"]);
    for (const id of [T1, T2, T3]) expect(text()).toContain(id);
    expect(text()).toContain("--bg-removed-file-id f_nobg");
    expect(text()).toContain("--replace-image-id img_face");
    expectCleanLogs();
  });

  it("stops without resubmitting when a stage submit is ambiguous", async () => {
    const routes = chainRoutes();
    routes[REPLACE] = [{ status: 502, text: "bad gateway" }];
    const fake = stub(routes);
    await expect(
      run(
        "product-avatar",
        "--product-image",
        productPng,
        "--avatar-id",
        "pa1",
        "--image-edit-prompt",
        "edit",
        ...stage3,
      ),
    ).rejects.toThrow(/may have been created.*--bg-removed-file-id f_nobg/);
    expect(fake.of(REMOVE)).toHaveLength(1);
    expect(fake.of(REPLACE)).toHaveLength(1);
    expect(fake.of(VIDEO)).toHaveLength(0);
  });

  it("stops when a stage task fails, naming its resume command", async () => {
    const routes = chainRoutes();
    routes[`GET /v1/common_task/remove_background/query?taskId=${T1}`] = [
      ok({ taskId: T1, status: "fail", errorMsg: "no product found" }),
    ];
    const fake = stub(routes);
    await expect(
      run(
        "product-avatar",
        "--product-image",
        productPng,
        "--avatar-id",
        "pa1",
        "--image-edit-prompt",
        "e",
        ...stage3,
      ),
    ).rejects.toThrow(/remove-bg task 1+ fail: no product found/);
    expect(fake.of(REPLACE)).toHaveLength(0);
  });

  it("resumes at stage 3 with --replace-image-id and uploads the audio", async () => {
    const fake = stub({ ...chainRoutes(), ...uploadRoutes("mp3", "f_audio") });
    await run(
      "product-avatar",
      "--replace-image-id",
      "img_face",
      "--mode",
      "avatar2",
      "--audio",
      voiceMp3,
    );
    expect(fake.of(REMOVE)).toHaveLength(0);
    expect(fake.of(REPLACE)).toHaveLength(0);
    expect(fake.of(VIDEO)[0]?.body).toEqual({
      mode: "avatar2",
      scriptMode: "audio",
      audioFileId: "f_audio",
      replaceProductTaskImageId: "img_face",
    });
  });

  it("refuses to animate faceless images with an avatar4 mode", async () => {
    const routes = chainRoutes();
    routes[`GET /v3/product_avatar/task/image_replace/query?taskId=${T2}`] = [
      ok({
        taskId: T2,
        status: "success",
        replaceProductResult: [{ imageId: "img_noface", faceExistence: false }],
      }),
    ];
    const fake = stub(routes);
    await expect(
      run(
        "product-avatar",
        "--bg-removed-file-id",
        "f_nobg",
        "--avatar-id",
        "pa1",
        "--image-edit-prompt",
        "e",
        ...stage3,
      ),
    ).rejects.toThrow(/no replaced image has a face.*--mode avatar2/);
    expect(fake.of(VIDEO)).toHaveLength(0);
  });
});

describe("API Platform commands", () => {
  const ROUTE = "bytedance/seedance-2.0/text-to-video";
  const SUBMIT = `POST /api/v1/models/${ROUTE}/predictions`;
  const GET = `GET /api/v1/predictions/${PREDICTION_ID}`;
  const INPUT = JSON.stringify({ content: [{ type: "text", text: PROMPT }] });

  it("run prints the prediction handle with its idempotency key", async () => {
    const fake = stub({
      [SUBMIT]: [data(prediction("created", { charged_usd: "0.5", billing_state: "RESERVED" }))],
    });
    await run("run", ROUTE, "--input", INPUT);
    const key = fake.calls[0]?.headers["idempotency-key"];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(stdout.join("\n")).toContain(`Prediction submitted: ${PREDICTION_ID}`);
    expect(stdout.join("\n")).toContain(`Idempotency key: ${key}`);
    expect(text()).toMatch(/charged_usd: \$0\.5 \(RESERVED: reserved, not final\)/);
    expectCleanLogs();
  });

  it("run --input @file --wait downloads the outputs", async () => {
    const file = path.join(tmp, "input.json");
    fs.writeFileSync(file, INPUT);
    stub({
      [SUBMIT]: [data(prediction("created"))],
      [GET]: [
        data(
          prediction("completed", {
            outputs: [VIDEO_URL],
            charged_usd: "0.320000000000",
            billing_state: "CAPTURED",
          }),
        ),
      ],
      [`GET ${VIDEO_URL}`]: [{ bytes: MP4, headers: { "content-type": "video/mp4" } }],
    });
    await run("run", ROUTE, "--input", `@${file}`, "--wait");
    expect(savedFiles()).toEqual(["topview-01KQ8Z9Y-01.mp4"]);
    expect(text()).toMatch(/CAPTURED: settled/);
    expectCleanLogs();
  });

  it("run --idempotency-key resends the earlier key", async () => {
    const fake = stub({ [SUBMIT]: [data(prediction("created"))] });
    await run("run", ROUTE, "--input", INPUT, "--idempotency-key", "earlier-key-1234");
    expect(fake.calls[0]?.headers["idempotency-key"]).toBe("earlier-key-1234");
  });

  it("prediction with payment_required exits non-zero with top-up guidance", async () => {
    stub({ [GET]: [data(prediction("payment_required", { code: 402, shortfall_usd: "0.2" }))] });
    await expect(run("prediction", PREDICTION_ID)).rejects.toThrow(
      /payment_required.*Shortfall: \$0\.2.*Top up/,
    );
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ status: "payment_required" });
  });

  it("prediction --download saves inline data outputs", async () => {
    const b64 = Buffer.from(PNG).toString("base64");
    stub({ [GET]: [data(prediction("completed", { outputs: [`data:image/png;base64,${b64}`] }))] });
    await run("prediction", PREDICTION_ID, "--download");
    expect(savedFiles()).toEqual(["topview-01KQ8Z9Y-01.png"]);
  });

  it("models joins verified routes with the cached public catalog", async () => {
    const catalog = {
      code: 200,
      data: {
        items: [
          {
            displayName: "Seedance 2.0",
            manufacturer: "ByteDance",
            offers: [
              {
                spec: { resolution: "720p" },
                price: {
                  unit: "second",
                  unitSize: "1.000",
                  saleUnitUsd: "0.1036",
                  componentCode: "video_seconds",
                },
              },
            ],
          },
          { displayName: "Brand New Model", offers: [] },
        ],
        nextCursor: null,
      },
    };
    const fake = stub({ "GET /platform/v1/models": [{ json: catalog }] });
    await run("models", "--json");
    const view = JSON.parse(stdout.join("\n"));
    expect(view.catalog.state).toBe("fresh");
    expect(view.routes.find((r: { route: string }) => r.route === ROUTE)).toMatchObject({
      manufacturer: "ByteDance",
      prices: [{ saleUnitUsd: "0.1036", unit: "second" }],
      verified_at: "2026-10-28",
    });
    expect(view.unrouted).toEqual(["Brand New Model"]);
    expect(fake.calls[0]?.headers.authorization).toBeUndefined();

    stdout.length = 0;
    await run("models");
    expect(fake.calls).toHaveLength(1); // served from the cache
    expect(stdout.join("\n")).toMatch(/\$0\.1036 \/ second \(video_seconds\) \[resolution=720p\]/);
  });

  it("models still lists routes when the catalog is unavailable", async () => {
    stub({ "GET /platform/v1/models": [{ status: 503, text: "down" }] });
    await run("models", "--json", "--refresh");
    const view = JSON.parse(stdout.join("\n"));
    expect(view.catalog.state).toBe("unavailable");
    expect(view.routes).toHaveLength(22);
  });
});
