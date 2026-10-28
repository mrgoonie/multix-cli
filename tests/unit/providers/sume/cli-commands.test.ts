/**
 * `multix sume` commands driven through commander with the env-based client
 * and the global fetch stubbed by a fake Sume API: submit, wait, settle,
 * download, resume, cancel, and the refusals that must send nothing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run as runState } from "../../../../src/agent/run-state.js";
import { _resetEnvLoader } from "../../../../src/core/env-loader.js";
import { classifyError } from "../../../../src/core/error-classify.js";
import { type MultixError, ProviderError, ValidationError } from "../../../../src/core/errors.js";
import { _resetOutputDir } from "../../../../src/core/output-dir.js";
import { registerSumeCommands } from "../../../../src/providers/sume/commands/index.js";
import { CATALOG_BODY, type Reply, fakeSume, job, json, sumeError } from "./fake-sume.js";

const CAPTURED = { status: "captured", captured_usd_cents: 4, captured_credits: 40, final: true };
const REFUNDED = { status: "refunded", captured_usd_cents: 0, refunded_usd_cents: 3, final: true };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let tmp: string;
let stdout: string[];
let stderr: string[];
const originalEnv = { ...process.env };

function stub(routes: Record<string, Reply[]>) {
  const fake = fakeSume({ "GET /v1/open/catalog": [json(CATALOG_BODY)], ...routes });
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}

async function sume(...args: string[]): Promise<void> {
  const p = new Command();
  p.exitOverride();
  registerSumeCommands(p);
  await p.parseAsync(["node", "multix", "sume", ...args]);
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const posts = (calls: { method: string; url: string }[]) =>
  calls.filter((c) => c.method === "POST").map((c) => new URL(c.url).pathname);

const submitted = (id: string, status = "queued") =>
  json({ data: { job: job(id, status), status_url: `/v1/jobs/${id}/status` } }, 202);
const done = (id: string, state = "completed") =>
  json({ data: { job_id: id, sume_status: state, terminal: true } });
const artifacts = (id: string) =>
  json({
    data: {
      job_id: id,
      result: {
        artifacts: [
          { url: `https://cdn.sume.com/out/${id}.png?sig=secret`, content_type: "image/png" },
        ],
      },
    },
  });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sume-cli-"));
  process.env.MULTIX_OUTPUT_DIR = tmp;
  process.env.MULTIX_CACHE_DIR = path.join(tmp, "cache");
  process.env.SUME_API_KEY = "sk_sume_test_secret";
  process.env.MULTIX_IMAGE_FORMAT = "original";
  process.env.NO_COLOR = "1";
  _resetEnvLoader();
  _resetOutputDir();
  runState.ids = [];
  runState.inFlight = undefined;
  runState.data = undefined;
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    stdout.push(a.join(" "));
  });
  for (const fn of ["error", "warn"] as const) {
    vi.spyOn(console, fn).mockImplementation((...a: unknown[]) => {
      stderr.push(a.join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
  _resetEnvLoader();
  _resetOutputDir();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("sume image", () => {
  it("submits once, waits, reads the ledger and saves the artifact", async () => {
    const fake = stub({
      "POST /v1/image-router/generate": [submitted("job_a")],
      "GET /v1/jobs/job_a/status": [done("job_a")],
      "GET /v1/jobs/job_a": [json({ data: { job: job("job_a", "completed", CAPTURED) } })],
      "GET /v1/jobs/job_a/result": [artifacts("job_a")],
      "GET /out/job_a.png": [new Response(PNG, { headers: { "content-type": "image/png" } })],
    });
    await sume("image", "a red fox", "-m", "seedream-v4", "--aspect-ratio", "1:1");
    expect(posts(fake.calls)).toEqual(["/v1/image-router/generate"]);
    const submit = fake.calls.find((c) => c.method === "POST");
    expect(submit?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(submit?.body).toEqual({
      model: "seedream-v4",
      prompt: "a red fox",
      aspect_ratio: "1:1",
    });
    const saved = path.join(tmp, "sume-job_a-01.png");
    expect(fs.readFileSync(saved)).toEqual(Buffer.from(PNG));
    expect(runState.ids[0]).toBe("job_a");
    expect(stderr.join("\n") + stdout.join("\n")).not.toContain("sig=secret");
  });

  it("--async prints only the job id and the resume command on stderr", async () => {
    stub({ "POST /v1/image-router/generate": [submitted("job_b")] });
    await sume("image", "a fox", "-m", "seedream-v4", "--async");
    expect(stdout).toEqual(["job_b"]);
    expect(stderr.join("\n")).toContain("multix sume status job_b --wait --download");
  });

  it("passes the user's --idempotency-key through unchanged", async () => {
    const fake = stub({ "POST /v1/image-router/generate": [submitted("job_c")] });
    await sume("image", "a fox", "-m", "seedream-v4", "--async", "--idempotency-key", "my-key-1");
    expect(fake.calls.find((c) => c.method === "POST")?.headers["idempotency-key"]).toBe(
      "my-key-1",
    );
  });

  it("uploads a local --image and sends its public URL", async () => {
    const local = path.join(tmp, "in.png");
    fs.writeFileSync(local, PNG);
    const fake = stub({
      "POST /v1/files/generate-upload-url": [
        json({
          data: {
            public_url: "https://cdn.sume.com/assets/in.png",
            upload_url: "https://uploads.sume.com/put/in.png?sig=secret",
            upload_method: "PUT",
            upload_headers: { "Content-Type": "image/png" },
          },
        }),
      ],
      "PUT /put/in.png": [new Response(null, { status: 200 })],
      "POST /v1/image-router/generate": [submitted("job_d")],
    });
    await sume("image", "make it blue", "-m", "seedream-v4", "--image", local, "--async");
    const submit = fake.calls.find((c) => new URL(c.url).pathname === "/v1/image-router/generate");
    expect(submit?.body).toMatchObject({ image_urls: ["https://cdn.sume.com/assets/in.png"] });
    expect(fake.calls.find((c) => c.method === "PUT")?.headers.authorization).toBeUndefined();
  });

  it("refuses a non-media local file before any request", async () => {
    const secret = path.join(tmp, ".env");
    fs.writeFileSync(secret, "KEY=1");
    const fake = stub({});
    const err = await caught(sume("image", "x", "-m", "seedream-v4", "--image", secret));
    expect(err).toBeInstanceOf(ValidationError);
    expect(posts(fake.calls)).toEqual([]);
  });

  it("sends nothing for an unknown model or an option the catalog does not list", async () => {
    const fake = stub({});
    expect(await caught(sume("image", "x", "-m", "no-such-model"))).toBeInstanceOf(ValidationError);
    expect(
      await caught(sume("image", "x", "-m", "seedream-v4", "--aspect-ratio", "7:3")),
    ).toBeInstanceOf(ValidationError);
    expect(posts(fake.calls)).toEqual([]);
  });

  it("sends nothing when the catalog cannot be read and no copy is cached", async () => {
    const fake = stub({ "GET /v1/open/catalog": [new Response("down", { status: 503 })] });
    const err = await caught(sume("image", "x", "-m", "seedream-v4"));
    expect((err as Error).message).toMatch(/catalog is unavailable/);
    expect(posts(fake.calls)).toEqual([]);
  });

  it("reports an ambiguous submit without resubmitting", async () => {
    const fake = stub({
      "POST /v1/image-router/generate": [new Response("bad gateway", { status: 502 })],
    });
    const err = await caught(sume("image", "x", "-m", "seedream-v4"));
    expect((err as MultixError).code).toBe("UNKNOWN_REMOTE_STATE");
    expect((err as Error).message).toMatch(/--idempotency-key \S+/);
    expect(posts(fake.calls)).toEqual(["/v1/image-router/generate"]);
  });

  it("surfaces insufficient balance once, not charged and not retried", async () => {
    const fake = stub({
      "POST /v1/image-router/generate": [sumeError(402, "insufficient_funds", "Top up")],
    });
    const err = await caught(sume("image", "x", "-m", "seedream-v4"));
    expect((err as Error).message).toContain("not charged");
    expect(posts(fake.calls)).toHaveLength(1);
  });
});

describe("sume video", () => {
  it("fails a failed job, naming the refund, without downloading", async () => {
    const fake = stub({
      "POST /v1/video-router/generate": [submitted("job_f")],
      "GET /v1/jobs/job_f/status": [
        json({
          data: {
            job_id: "job_f",
            sume_status: "failed",
            terminal: true,
            error: { code: "content_policy", message: "refused" },
          },
        }),
      ],
      "GET /v1/jobs/job_f": [json({ data: { job: job("job_f", "failed", REFUNDED) } })],
    });
    const err = await caught(sume("video", "a cat", "-m", "kling-3", "--duration", "5"));
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as Error).message).toMatch(
      /job failed \(job_f\): content_policy.*refunded \$0\.03/,
    );
    expect(classifyError(err).code).toBe("JOB_FAILED");
    expect(fake.calls.some((c) => c.url.includes("/result"))).toBe(false);
    expect(posts(fake.calls)).toHaveLength(1);
  });
});

describe("sume status / result / cancel", () => {
  it("resumes a job by id without submitting anything", async () => {
    const fake = stub({
      "GET /v1/jobs/job_r/status": [done("job_r")],
      "GET /v1/jobs/job_r": [json({ data: { job: job("job_r", "completed", CAPTURED) } })],
      "GET /v1/jobs/job_r/result": [artifacts("job_r")],
      "GET /out/job_r.png": [new Response(PNG, { headers: { "content-type": "image/png" } })],
    });
    await sume("status", "job_r", "--wait", "--download");
    expect(posts(fake.calls)).toEqual([]);
    expect(fs.existsSync(path.join(tmp, "sume-job_r-01.png"))).toBe(true);

    // A second resume keeps the saved file instead of downloading it again.
    const before = fake.calls.filter((c) => c.url.includes("/out/")).length;
    await sume("status", "job_r", "--download");
    expect(fake.calls.filter((c) => c.url.includes("/out/")).length).toBe(before);
  });

  it("prints a running job's status as JSON", async () => {
    stub({
      "GET /v1/jobs/job_q/status": [
        json({ data: { job_id: "job_q", status: "IN_PROGRESS", terminal: false } }),
      ],
    });
    await sume("status", "job_q");
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ job_id: "job_q", status: "IN_PROGRESS" });
  });

  it("result refuses a job that has not finished", async () => {
    stub({ "GET /v1/jobs/job_q/status": [json({ data: { status: "IN_QUEUE" } })] });
    const err = await caught(sume("result", "job_q"));
    expect((err as Error).message).toMatch(/not finished/);
  });

  it("result --no-download prints the artifact URLs", async () => {
    stub({
      "GET /v1/jobs/job_r/status": [done("job_r")],
      "GET /v1/jobs/job_r": [json({ data: { job: job("job_r", "completed", CAPTURED) } })],
      "GET /v1/jobs/job_r/result": [artifacts("job_r")],
    });
    await sume("result", "job_r", "--no-download");
    expect(stdout).toEqual(["https://cdn.sume.com/out/job_r.png?sig=secret"]);
  });

  it("cancel sends one POST and prints the answer", async () => {
    const fake = stub({
      "POST /v1/jobs/job_x/cancel": [
        json({
          data: { job_id: "job_x", canceled: true, job: job("job_x", "canceled", REFUNDED) },
        }),
      ],
    });
    await sume("cancel", "job_x");
    expect(posts(fake.calls)).toEqual(["/v1/jobs/job_x/cancel"]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({ canceled: true });
  });

  it("a 401 on status is reported, not retried forever", async () => {
    stub({ "GET /v1/jobs/job_z/status": [sumeError(401, "invalid_api_key", "bad key")] });
    const err = await caught(sume("status", "job_z", "--wait"));
    expect((err as { status?: number }).status).toBe(401);
  });
});

describe("sume models", () => {
  it("lists the catalog with its source and caches it", async () => {
    const fake = stub({});
    await sume("models", "--kind", "video");
    expect(stdout[0]).toMatch(/fresh read .*https:\/\/api\.sume\.com\/v1\/open\/catalog/);
    expect(stdout.join("\n")).toContain("kling-3");
    expect(stdout.join("\n")).not.toContain("seedream-v4");
    await sume("models");
    expect(fake.calls.filter((c) => c.url.includes("/v1/open/catalog"))).toHaveLength(1);
    expect(fake.calls.every((c) => !c.headers.authorization)).toBe(true);
  });
});
