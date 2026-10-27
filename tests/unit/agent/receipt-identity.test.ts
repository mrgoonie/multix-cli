/**
 * Generation receipts name the requested and the served model and the provider
 * job (id and attempt) behind the outputs. Offline: fetch is mocked.
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFetchTelemetry,
  modelFromResponse,
  modelFromTail,
  settleTelemetry,
} from "../../../src/agent/fetch-telemetry.js";
import { jobIdentity, run } from "../../../src/agent/run-state.js";

const original = globalThis.fetch;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Install the wrapper over a fetch that answers with `responses` in order. */
function serve(...responses: Response[]): void {
  let i = 0;
  globalThis.fetch = vi.fn(async () => {
    const next = responses[i++];
    if (!next) throw new Error("no more responses");
    return next;
  }) as typeof fetch;
  installFetchTelemetry(() => {
    throw new Error("not a dry run");
  });
}

function reset(): void {
  globalThis.fetch = original;
  run.postUsage = [];
  run.getUsage = new Map();
  run.calls = [];
  run.ids = [];
  run.requestsStarted = 0;
  run.requestModel = undefined;
  run.resolvedModel = undefined;
  run.job = undefined;
  run.inFlight = undefined;
  run.group = "";
  run.dryRun = false;
}

beforeEach(reset);
afterEach(reset);

describe("modelFromResponse / modelFromTail", () => {
  it("reads top-level model keys only", () => {
    expect(modelFromResponse({ model: "openai/gpt-4o-2024-08-06" })).toBe(
      "openai/gpt-4o-2024-08-06",
    );
    expect(modelFromResponse({ modelVersion: "gemini-2.5-flash-image" })).toBe(
      "gemini-2.5-flash-image",
    );
    expect(modelFromResponse({ data: { model: "nested" } })).toBeUndefined();
    expect(modelFromResponse({ model: { id: "x" } })).toBeUndefined();
    expect(modelFromResponse([{ model: "x" }])).toBeUndefined();
  });

  it("finds the trailing modelVersion of an oversized Gemini body", () => {
    expect(
      modelFromTail('…AAAA"}}]}}],"usageMetadata":{"totalTokenCount":9},"modelVersion":"g-tts"}'),
    ).toBe("g-tts");
    expect(modelFromTail('"usageMetadata":{}}')).toBeUndefined();
  });
});

describe("resolved model and job from provider responses", () => {
  it("records the served model and the body id of the generation request", async () => {
    run.group = "openrouter";
    serve(
      json({ id: "gen-123", model: "openai/gpt-4o-2024-08-06" }, 200, {
        "x-request-id": "req-hdr",
      }),
    );
    await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "openai/gpt-4o" }),
    });
    await settleTelemetry();
    expect(run.requestModel).toBe("openai/gpt-4o");
    expect(run.resolvedModel?.model).toBe("openai/gpt-4o-2024-08-06");
    expect(jobIdentity()).toEqual({ provider: "openrouter", id: "gen-123", attempt: 1 });
  });

  it("leaves the served model unset when no response names one", async () => {
    run.group = "fal";
    serve(json({ request_id: "fal-req-1", status: "IN_QUEUE" }));
    await fetch("https://queue.fal.run/fal-ai/flux/dev", {
      method: "POST",
      body: JSON.stringify({ prompt: "cat" }),
    });
    await settleTelemetry();
    expect(run.resolvedModel).toBeUndefined();
    expect(jobIdentity()).toEqual({ provider: "fal", id: "fal-req-1", attempt: 1 });
  });

  it("counts failed calls to the same endpoint before the one that returned the job", async () => {
    run.group = "gemini";
    serve(
      json({ error: { code: 503 } }, 503),
      json({ error: { code: 429 } }, 429),
      json({ name: "operations/abc", id: "op-1", modelVersion: "veo-3.0-001" }),
      json({ id: "op-1", done: true }),
    );
    const url = "https://generativelanguage.googleapis.com/v1beta/models/veo-3.0:predict";
    for (let i = 0; i < 3; i++) await fetch(url, { method: "POST", body: "{}" });
    await fetch("https://generativelanguage.googleapis.com/v1beta/operations/abc");
    await settleTelemetry();
    expect(run.requestModel).toBe("veo-3.0");
    expect(run.resolvedModel?.model).toBe("veo-3.0-001");
    expect(jobIdentity()).toEqual({ provider: "gemini", id: "op-1", attempt: 3 });
  });

  it("prefers the generation request's id over an earlier upload's", async () => {
    run.group = "openai";
    serve(
      json({ id: "file-upload-1" }),
      json({ id: "job-77", model: "gpt-image-1" }, 200, { "x-request-id": "req-2" }),
    );
    await fetch("https://api.openai.com/v1/files", { method: "POST", body: "{}" });
    await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-image-1" }),
    });
    await settleTelemetry();
    expect(jobIdentity()?.id).toBe("job-77");
  });

  it("falls back to a request-id header when the body has no id", async () => {
    run.group = "elevenlabs";
    serve(json({ ok: true }, 200, { "request-id": "el-req-9" }));
    await fetch("https://api.elevenlabs.io/v1/text-to-speech/v", {
      method: "POST",
      body: JSON.stringify({ model_id: "eleven_v3" }),
    });
    await settleTelemetry();
    expect(jobIdentity()).toEqual({ provider: "elevenlabs", id: "el-req-9", attempt: 1 });
  });

  it("ignores ids and models from failed responses", async () => {
    run.group = "openai";
    serve(json({ id: "err-1", model: "x" }, 500, { "x-request-id": "req-err" }));
    await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "gpt-image-1" }),
    });
    await settleTelemetry();
    expect(run.resolvedModel).toBeUndefined();
    expect(jobIdentity()).toBeUndefined();
  });

  it("uses a tracked in-flight job id", () => {
    run.group = "atlas";
    run.inFlight = { id: "pred-1", resume: "multix atlas status pred-1 --wait" };
    expect(jobIdentity()).toEqual({ provider: "atlas", id: "pred-1", attempt: 1 });
  });
});

/** finalizeRun on a fresh module copy, capturing the envelope and the history entry. */
async function finalize(setup: (state: typeof run) => void, input = { exitCode: 0 }) {
  vi.resetModules();
  const written: string[] = [];
  const realWriteSync = fs.writeSync;
  // The envelope goes to fd 1; the history file is appended through other fds.
  const spy = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, ...rest: unknown[]) => {
    if (fd !== 1) return (realWriteSync as (...a: unknown[]) => number)(fd, ...rest);
    const buf = rest[0] as Buffer;
    written.push(buf.toString());
    return buf.length;
  }) as typeof fs.writeSync);
  try {
    const state = (await import("../../../src/agent/run-state.js")).run;
    const { finalizeRun } = await import("../../../src/agent/agent-runtime.js");
    state.json = true;
    state.actionStarted = true;
    setup(state);
    finalizeRun(input);
    return JSON.parse(written.join(""));
  } finally {
    spy.mockRestore();
  }
}

describe("finalizeRun receipt identity", () => {
  let historyFile = "";
  beforeEach(() => {
    historyFile = `${fs.mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/multix-hist-`)}/h.jsonl`;
    vi.stubEnv("MULTIX_HISTORY", "1");
    vi.stubEnv("MULTIX_HISTORY_FILE", historyFile);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(historyFile.replace(/\/h\.jsonl$/, ""), { recursive: true, force: true });
  });

  it("writes model_requested, model_resolved and job to the envelope and history", async () => {
    const envelope = await finalize((s) => {
      s.command = "openrouter chat";
      s.group = "openrouter";
      s.requestModel = "openai/gpt-4o";
      s.resolvedModel = { seq: 1, rank: 0, model: "openai/gpt-4o-2024-08-06" };
      s.job = { seq: 1, rank: 0, id: "gen-1", method: "POST", host: "openrouter.ai", path: "/x" };
      s.calls = [{ method: "POST", host: "openrouter.ai", path: "/x", status: 200, ms: 1, seq: 1 }];
    });
    expect(envelope).toMatchObject({
      model: "openai/gpt-4o",
      model_requested: "openai/gpt-4o",
      model_resolved: "openai/gpt-4o-2024-08-06",
      job: { provider: "openrouter", id: "gen-1", attempt: 1 },
    });
    const entry = JSON.parse(fs.readFileSync(historyFile, "utf8").trim());
    expect(entry).toMatchObject({
      model: "openai/gpt-4o",
      model_requested: "openai/gpt-4o",
      model_resolved: "openai/gpt-4o-2024-08-06",
      job: { provider: "openrouter", id: "gen-1", attempt: 1 },
    });
  });

  it("reports model_resolved null, never a guess, and no job without an id", async () => {
    const envelope = await finalize((s) => {
      s.command = "fal run";
      s.group = "fal";
      s.options = { model: "fal-ai/flux/dev" };
    });
    expect(envelope.model_requested).toBe("fal-ai/flux/dev");
    expect(envelope.model_resolved).toBeNull();
    expect(envelope).not.toHaveProperty("job");
  });

  it("omits both model fields when no model is known", async () => {
    const envelope = await finalize((s) => {
      s.command = "media optimize";
    });
    expect(envelope).not.toHaveProperty("model_requested");
    expect(envelope).not.toHaveProperty("model_resolved");
  });
});
