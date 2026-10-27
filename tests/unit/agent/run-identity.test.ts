/**
 * Receipts record which model was requested and which one the provider served,
 * and the provider job id with the attempt that submitted it. Offline: fetch is
 * mocked and finalizeRun writes to a captured fd 1.
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };

async function runWith(
  replies: Reply[],
  send: (fetchFn: typeof fetch) => Promise<void>,
  setup?: (run: typeof import("../../../src/agent/run-state.js").run) => void,
) {
  vi.resetModules();
  const queue = [...replies];
  globalThis.fetch = vi.fn(async () => {
    const r = queue.shift() ?? {};
    const json = r.body !== undefined;
    return new Response(json ? JSON.stringify(r.body) : null, {
      status: r.status ?? 200,
      headers: { ...(json ? { "content-type": "application/json" } : {}), ...r.headers },
    });
  }) as typeof fetch;
  const written: string[] = [];
  const spy = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buf: Buffer) => {
    if (fd !== 1) throw new Error(`unexpected write to fd ${fd}`);
    written.push(buf.toString());
    return buf.length;
  }) as typeof fs.writeSync);
  try {
    const { run } = await import("../../../src/agent/run-state.js");
    const { installFetchTelemetry, settleTelemetry } = await import(
      "../../../src/agent/fetch-telemetry.js"
    );
    const { finalizeRun } = await import("../../../src/agent/agent-runtime.js");
    installFetchTelemetry(() => {
      throw new Error("not a dry run");
    });
    run.json = true;
    run.command = "test run";
    run.group = "testprov";
    setup?.(run);
    await send(globalThis.fetch);
    await settleTelemetry();
    finalizeRun({ exitCode: 0 });
    return JSON.parse(written.join(""));
  } finally {
    spy.mockRestore();
  }
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });
const original = globalThis.fetch;

describe("model and job identity in the envelope", () => {
  beforeEach(() => vi.stubEnv("MULTIX_HISTORY", "0"));
  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.fetch = original;
  });

  it("records the requested model and the model the provider reports serving", async () => {
    const envelope = await runWith(
      [{ body: { id: "gen-1", model: "openai/gpt-5.1-20260901", choices: [] } }],
      async (f) => {
        await f("https://openrouter.ai/api/v1/chat/completions", post({ model: "openai/gpt-5.1" }));
      },
    );
    expect(envelope.model).toBe("openai/gpt-5.1");
    expect(envelope.model_requested).toBe("openai/gpt-5.1");
    expect(envelope.model_resolved).toBe("openai/gpt-5.1-20260901");
    expect(envelope.job).toEqual({ provider: "testprov", id: "gen-1", attempt: 1 });
  });

  it("reads Gemini modelVersion for a model named in the path", async () => {
    const envelope = await runWith(
      [{ body: { candidates: [], modelVersion: "gemini-2.5-flash-001" } }],
      async (f) => {
        await f(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          post({ contents: [] }),
        );
      },
    );
    expect(envelope.model_requested).toBe("gemini-2.5-flash");
    expect(envelope.model_resolved).toBe("gemini-2.5-flash-001");
    expect(envelope.job).toBeUndefined();
  });

  it("reports model_resolved as null when the provider names no model, never a guess", async () => {
    const envelope = await runWith([{ body: { request_id: "req-9" } }], async (f) => {
      await f("https://api.example.com/v1/images", post({ model: "img-1", prompt: "x" }));
    });
    expect(envelope.model_requested).toBe("img-1");
    expect(envelope.model_resolved).toBeNull();
    expect(envelope.job).toEqual({ provider: "testprov", id: "req-9", attempt: 1 });
  });

  it("ignores a model named by an unrelated response", async () => {
    const envelope = await runWith(
      [{ body: { ok: true } }, { body: { model: "other-model" } }],
      async (f) => {
        await f("https://api.example.com/v1/gen", post({ model: "asked" }));
        await f("https://api.example.com/v1/lookup");
      },
    );
    expect(envelope.model_resolved).toBeNull();
  });

  it("counts the attempt of a submit retried after a 429", async () => {
    const envelope = await runWith(
      [{ status: 429 }, { status: 201, body: { id: "pred-7", model: "owner/name" } }],
      async (f) => {
        const init = post({ version: "abc123", input: {} });
        await f("https://api.replicate.com/v1/predictions", init);
        await f("https://api.replicate.com/v1/predictions", init);
      },
    );
    expect(envelope.job).toEqual({ provider: "testprov", id: "pred-7", attempt: 2 });
    expect(envelope.model_requested).toBe("abc123");
    expect(envelope.model_resolved).toBe("owner/name");
  });

  it("takes the job from the latest accepted submit, not an earlier upload or a poll", async () => {
    const envelope = await runWith(
      [
        { status: 201, body: { id: "file-1" } },
        { status: 201, body: { id: "pred-2" } },
        { body: { id: "pred-2", status: "succeeded" } },
      ],
      async (f) => {
        await f("https://api.replicate.com/v1/files", { method: "POST", body: "bytes" });
        await f("https://api.replicate.com/v1/models/o/n/predictions", post({ input: {} }));
        await f("https://api.replicate.com/v1/predictions/pred-2");
      },
    );
    expect(envelope.job).toEqual({ provider: "testprov", id: "pred-2", attempt: 1 });
    expect(envelope.model_requested).toBeUndefined();
    expect(envelope.model_resolved).toBeUndefined();
  });

  it("prefers the tracked in-flight job id", async () => {
    const envelope = await runWith(
      [{ body: { data: { id: "atlas-1" } } }],
      async (f) => {
        await f("https://api.atlascloud.ai/api/v1/model/generateVideo", post({ model: "m" }));
      },
      (run) => {
        run.inFlight = { id: "atlas-1", resume: "multix atlas status atlas-1 --wait" };
        run.ids.unshift("atlas-1");
      },
    );
    expect(envelope.job).toEqual({ provider: "testprov", id: "atlas-1", attempt: 1 });
  });

  it("omits job when no provider returned an id, and failed submits give none", async () => {
    const envelope = await runWith(
      [{ status: 500, body: { id: "err-1" }, headers: { "x-request-id": "r-500" } }],
      async (f) => {
        await f("https://api.example.com/v1/gen", post({ model: "m" }));
      },
    );
    expect(envelope.job).toBeUndefined();
    expect(envelope.model_resolved).toBeNull();
  });
});

describe("modelFromResponse", () => {
  it("reads modelVersion from the tail of an oversized body and the openai-model header", async () => {
    const { modelFromResponse } = await import("../../../src/agent/fetch-telemetry.js");
    const tail =
      '..."text":"say \\"modelVersion\\": \\"fake\\""}],"modelVersion": "gemini-tts-002"}';
    expect(modelFromResponse(undefined, new Headers(), tail)).toBe("gemini-tts-002");
    expect(
      modelFromResponse(undefined, new Headers(), '"text":"\\"modelVersion\\":\\"fake\\""'),
    ).toBeUndefined();
    expect(
      modelFromResponse({ data: [] }, new Headers({ "openai-model": "gpt-image-2-2026" })),
    ).toBe("gpt-image-2-2026");
    expect(modelFromResponse({ model: { id: "x" } }, new Headers())).toBeUndefined();
  });
});
