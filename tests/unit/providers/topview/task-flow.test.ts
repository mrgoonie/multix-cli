/**
 * End-to-end command flows with a faked TopView (global fetch stubbed):
 * submit -> status -> wait -> download -> resume, on both APIs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run, summarizeUsage } from "../../../../src/agent/run-state.js";
import { _resetEnvLoader } from "../../../../src/core/env-loader.js";
import { classifyError } from "../../../../src/core/error-classify.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerTopviewCommands } from "../../../../src/providers/topview/commands/index.js";
import { runLegacyTask } from "../../../../src/providers/topview/commands/task-runner.js";
import {
  LEGACY_BASE,
  LEGACY_KEY,
  PLATFORM_KEY,
  UID,
  createFakeTopview,
  legacyError,
  ok,
  prediction,
} from "./fake-topview.js";

const VIDEO = "https://cdn.topview.test/out/export-1.mp4";
const PLATFORM_ROUTE = "bytedance/seedance-2.0-mini/text-to-video";
const quietLogger = {
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  header: vi.fn(),
};

let tmp: string;
let stdout: string[];
const originalEnv = { ...process.env };

function install(routes: Parameters<typeof createFakeTopview>[0]) {
  const fake = createFakeTopview({
    ...routes,
    "GET cdn.topview.test": { text: "MP4BYTES", headers: { "content-type": "video/mp4" } },
  });
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

async function cli(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerTopviewCommands(program);
  await program.parseAsync(["node", "multix", "topview", ...args]);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "topview-flow-"));
  process.env.MULTIX_OUTPUT_DIR = tmp;
  process.env.TOPVIEW_API_KEY = LEGACY_KEY;
  process.env.TOPVIEW_UID = UID;
  process.env.TOPVIEW_API_PLATFORM_KEY = PLATFORM_KEY;
  _resetEnvLoader();
  _resetOutputDir();
  run.getUsage.clear();
  run.postUsage.length = 0;
  stdout = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.join(" "));
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  _resetEnvLoader();
  _resetOutputDir();
  run.getUsage.clear();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("product video (legacy API): submit -> status -> download -> resume", () => {
  it("runs the whole lifecycle and a resume reuses the saved file", async () => {
    const fake = install({
      "POST /v1/m2v/task/submit": { body: ok({ taskId: "task_1", status: "init" }) },
      "GET /v1/m2v/task/query": [
        { body: ok({ taskId: "task_1", status: "running" }) },
        {
          body: ok({
            taskId: "task_1",
            status: "success",
            costCredit: 12,
            exportVideos: [{ status: "success", videoUrl: VIDEO }],
          }),
        },
      ],
    });

    await cli("url-to-video", "--product-link", "https://shop.test/p/1", "--async");
    expect(stdout).toEqual(["task_1"]);
    const submits = fake.calls.filter((c) => c.method === "POST");
    expect(submits).toHaveLength(1);
    expect(submits[0]?.body).toEqual({ productLink: "https://shop.test/p/1" });

    stdout = [];
    await cli("status", "task_1", "--task", "m2v");
    expect(JSON.parse(stdout.join("\n")).status).toBe("running");

    stdout = [];
    await cli("status", "task_1", "--task", "m2v", "--download");
    const saved = path.join(tmp, "topview-task_1-01.mp4");
    expect(fs.readFileSync(saved, "utf8")).toBe("MP4BYTES");
    expect(run.data).toMatchObject({ api: "legacy", credits: 12, files: [saved] });

    const downloadsBefore = fake.calls.filter((c) => c.url === VIDEO).length;
    await cli("status", "task_1", "--task", "m2v", "--download");
    expect(fake.calls.filter((c) => c.url === VIDEO).length).toBe(downloadsBefore);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a failed task exits with the provider's reason", async () => {
    install({
      "GET /v1/m2v/task/query": {
        body: ok({ taskId: "task_2", status: "fail", errorMsg: "link not parsable" }),
      },
    });
    const err = await cli("status", "task_2", "--task", "m2v", "--download").catch((e) => e);
    expect(classifyError(err).code).toBe("JOB_FAILED");
    expect((err as Error).message).toContain("link not parsable");
  });

  it("a credit refusal is sent once and nothing is polled", async () => {
    const fake = install({
      "POST /v1/m2v/task/submit": { body: legacyError("4100", "Credit not enough") },
    });
    const err = await cli("url-to-video", "--product-link", "https://shop.test/p/1").catch(
      (e) => e,
    );
    expect(classifyError(err).code).toBe("QUOTA_EXCEEDED");
    expect(fake.calls).toHaveLength(1);
  });

  it("an interrupted wait reports the resume command, without resubmitting", async () => {
    const fake = createFakeTopview({
      "POST /v1/m2v/task/submit": { body: ok({ taskId: "task_3" }) },
      "GET /v1/m2v/task/query": { body: ok({ taskId: "task_3", status: "running" }) },
    });
    const err = await runLegacyTask({
      client: fake.legacy,
      logger: quietLogger,
      kind: "m2v",
      body: { productLink: "https://shop.test/p/1" },
      opts: { waitTimeout: "50" },
      defaultWaitMs: 60_000,
      pollIntervalMs: 1,
      hint: "video",
    }).catch((e) => e);
    expect(classifyError(err).code).toBe("TIMEOUT");
    expect((err as Error).message).toContain("multix topview status task_3 --task m2v --download");
    expect(run.inFlight?.id).toBe("task_3");
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("refuses to upload a non-media file", async () => {
    const fake = install({});
    const secret = path.join(tmp, ".env");
    fs.writeFileSync(secret, "KEY=1");
    const err = await cli("materials-to-video", "--file", secret, "--product-name", "Mug").catch(
      (e) => e,
    );
    expect((err as Error).message).toMatch(/not a supported media file/);
    expect(fake.calls).toHaveLength(0);
  });

  it("export polls until the exported video exists, then downloads it", async () => {
    const fake = install({
      "POST /v1/m2v/export": { body: ok({ taskId: "task_4", status: "running" }) },
      "GET /v1/m2v/task/query": [
        {
          body: ok({
            taskId: "task_4",
            status: "success",
            previewVideos: [{ videoUrl: "https://cdn.topview.test/out/preview.mp4" }],
          }),
        },
        {
          body: ok({
            taskId: "task_4",
            status: "success",
            exportVideos: [{ status: "success", videoUrl: VIDEO }],
          }),
        },
      ],
    });
    const res = await runLegacyTask({
      client: fake.legacy,
      logger: quietLogger,
      kind: "m2v-export",
      body: { taskId: "task_4", scriptId: "s1" },
      opts: {},
      defaultWaitMs: 60_000,
      pollIntervalMs: 1,
      hint: "video",
    });
    const saved = path.join(tmp, "topview-task_4-01.mp4");
    expect(res.files).toEqual([saved]);
    expect(fs.readFileSync(saved, "utf8")).toBe("MP4BYTES");
    expect(fake.calls.some((c) => c.url.includes("preview.mp4"))).toBe(false);
  });
});

describe("API Platform model flow", () => {
  const completed = prediction("pred_1", "completed", {
    outputs: [VIDEO],
    charged_usd: "0.42",
    billing_state: "CAPTURED",
  });

  it("creates once, waits, downloads, and records the settled charge once", async () => {
    const fake = install({
      [`POST /api/v1/models/${PLATFORM_ROUTE}/predictions`]: {
        body: prediction("pred_1", "created", { billing_state: "RESERVED" }),
      },
      "GET /api/v1/predictions/pred_1": { body: completed },
    });
    await cli(
      "generate",
      PLATFORM_ROUTE,
      "--input",
      '{"prompt":"waves at dusk"}',
      "--idempotency-key",
      "idem-key-0001",
    );
    const post = fake.calls.find((c) => c.method === "POST");
    expect(post?.headers["idempotency-key"]).toBe("idem-key-0001");
    expect(post?.headers.authorization).toBe(`Bearer ${PLATFORM_KEY}`);
    expect(fs.readFileSync(path.join(tmp, "topview-pred_1-01.mp4"), "utf8")).toBe("MP4BYTES");
    expect(summarizeUsage()?.cost_usd).toBe(0.42);

    // Reading the same task again replaces the record instead of adding to it.
    await cli("status", "pred_1", "--task", "platform");
    expect(summarizeUsage()?.cost_usd).toBe(0.42);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a RESERVED hold is not recorded as spend", async () => {
    install({
      "GET /api/v1/predictions/pred_2": {
        body: prediction("pred_2", "processing", {
          charged_usd: "0.50",
          billing_state: "RESERVED",
        }),
      },
    });
    await cli("status", "pred_2", "--task", "platform");
    expect(summarizeUsage()?.cost_usd).toBeUndefined();
  });

  it("refuses an unverified route before any request", async () => {
    const fake = install({});
    const err = await cli("generate", "acme/made-up/text-to-video", "--input", "{}").catch(
      (e) => e,
    );
    expect((err as Error).message).toMatch(/Unknown or unverified/);
    expect(fake.calls).toHaveLength(0);
  });

  it("never uses the legacy key for the Platform", async () => {
    process.env.TOPVIEW_API_PLATFORM_KEY = "";
    _resetEnvLoader();
    const fake = install({});
    const err = await cli("generate", PLATFORM_ROUTE, "--input", "{}").catch((e) => e);
    expect(classifyError(err).code).toBe("MISSING_KEY");
    expect((err as Error).message).toContain("TOPVIEW_API_PLATFORM_KEY");
    expect(fake.calls).toHaveLength(0);
  });
});

it("the legacy base URL is the documented one", () => {
  expect(LEGACY_BASE).toBe("https://api.topview.ai");
});
