/**
 * Receipts name the model the run asked for, the model the provider reported
 * serving, and the provider job (id and send attempt) — from mocked responses only.
 */

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

/**
 * Fresh run state per case: install the fetch wrapper over `responses`, let
 * `send` make the calls, then finalize and return the envelope written to fd 1.
 */
async function runWith(
  group: string,
  responses: Response[],
  send: () => Promise<void>,
  setup: (run: typeof import("../../../src/agent/run-state.js").run) => void = () => {},
) {
  vi.resetModules();
  const original = globalThis.fetch;
  const queue = [...responses];
  globalThis.fetch = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("no more mocked responses");
    return next;
  }) as typeof fetch;
  const written: string[] = [];
  const spy = vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, buf: Buffer) => {
    if (fd !== 1) throw new Error(`unexpected write to fd ${fd}`);
    written.push(buf.toString());
    return buf.length;
  }) as typeof fs.writeSync);
  try {
    const { run } = await import("../../../src/agent/run-state.js");
    const telemetry = await import("../../../src/agent/fetch-telemetry.js");
    const { finalizeRun } = await import("../../../src/agent/agent-runtime.js");
    telemetry.installFetchTelemetry(() => {
      throw new Error("not a dry run");
    });
    run.json = true;
    run.command = `${group} generate`;
    run.group = group;
    setup(run);
    await send();
    await telemetry.settleTelemetry();
    finalizeRun({ exitCode: 0 });
    return JSON.parse(written.join(""));
  } finally {
    spy.mockRestore();
    globalThis.fetch = original;
  }
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", body: JSON.stringify(body) }).then(() => undefined);

describe("model_requested / model_resolved", () => {
  beforeEach(() => vi.stubEnv("MULTIX_HISTORY", "0"));
  afterEach(() => vi.unstubAllEnvs());

  it("records the alias requested and the model the provider served", async () => {
    const out = await runWith(
      "openrouter",
      [json({ id: "gen-1", model: "openai/gpt-5.1-2026-01-01", usage: { total_tokens: 3 } })],
      () => post("https://openrouter.ai/api/v1/chat/completions", { model: "openai/gpt-5.1" }),
    );
    expect(out.model).toBe("openai/gpt-5.1");
    expect(out.model_requested).toBe("openai/gpt-5.1");
    expect(out.model_resolved).toBe("openai/gpt-5.1-2026-01-01");
    expect(out.job).toEqual({ provider: "openrouter", id: "gen-1", attempt: 1 });
  });

  it("reads Gemini's modelVersion and responseId", async () => {
    const out = await runWith(
      "gemini",
      [json({ responseId: "resp-9", modelVersion: "gemini-2.5-flash-001", candidates: [] })],
      () =>
        post(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
          {},
        ),
    );
    expect(out.model_requested).toBe("gemini-2.5-flash");
    expect(out.model_resolved).toBe("gemini-2.5-flash-001");
    expect(out.job).toEqual({ provider: "gemini", id: "resp-9", attempt: 1 });
  });

  it("is null, not a guess, when the provider reports no model or id", async () => {
    const out = await runWith(
      "elevenlabs",
      [new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } })],
      () => post("https://api.elevenlabs.io/v1/text-to-speech/v", { model_id: "eleven_v4" }),
    );
    expect(out.model_requested).toBe("eleven_v4");
    expect(out.model_resolved).toBeNull();
    expect(out.job).toBeUndefined();
  });

  it("falls back to --model and keeps both fields null when there is no model", async () => {
    const withOption = await runWith(
      "fish",
      [],
      async () => {},
      (run) => {
        run.options = { model: "s2-pro" };
      },
    );
    expect(withOption.model_requested).toBe("s2-pro");
    expect(withOption.model_resolved).toBeNull();
    const none = await runWith("fish", [], async () => {});
    expect(none.model_requested).toBeNull();
    expect(none.model_resolved).toBeNull();
    expect(none.model).toBeUndefined();
  });

  it("does not take a looked-up generation's model or id as this run's", async () => {
    const out = await runWith(
      "openrouter",
      [json({ data: { id: "gen-old", model: "x/y" } })],
      () => fetch("https://openrouter.ai/api/v1/generation?id=gen-old").then(() => undefined),
      (run) => {
        run.command = "openrouter generation";
      },
    );
    expect(out.model_resolved).toBeNull();
    expect(out.job).toBeUndefined();
  });
});

describe("job identity", () => {
  beforeEach(() => vi.stubEnv("MULTIX_HISTORY", "0"));
  afterEach(() => vi.unstubAllEnvs());

  it("counts failed sends of the same request before the one that returned the id", async () => {
    const url = "https://queue.fal.run/fal-ai/flux";
    const out = await runWith(
      "fal",
      [
        json({ detail: "slow down" }, 429, { "x-request-id": "rl-1" }),
        json({ request_id: "req-ok" }),
        json({ status: "COMPLETED", request_id: "req-ok" }),
      ],
      async () => {
        await post(url, { prompt: "a" });
        await post(url, { prompt: "a" });
        await fetch(`${url}/requests/req-ok/status`).then(() => undefined);
      },
    );
    expect(out.job).toEqual({ provider: "fal", id: "req-ok", attempt: 2 });
    expect(out.provider_ids).toEqual(["rl-1", "req-ok"]);
    expect(out.cost.operation_id).toBe("fal:req-ok");
  });

  it("prefers a tracked in-flight job over other ids", async () => {
    const out = await runWith(
      "atlas",
      [json({ code: 200, data: { id: "pred_1", model: "atlas/flux-dev", status: "processing" } })],
      async () => {
        await post("https://api.atlascloud.ai/api/v1/model/generateImage", { model: "flux" });
        const { trackInFlight } = await import("../../../src/agent/run-state.js");
        trackInFlight("pred_1", "multix atlas status pred_1 --wait");
      },
    );
    expect(out.model_resolved).toBe("atlas/flux-dev");
    expect(out.job).toEqual({ provider: "atlas", id: "pred_1", attempt: 1 });
  });

  it("names the prediction, not the input file a Replicate run uploaded first", async () => {
    const out = await runWith(
      "replicate",
      [json({ id: "file-abc", name: "1mb.png" }, 201), json({ id: "pred-xyz", model: "o/m" }, 201)],
      async () => {
        await fetch("https://api.replicate.com/v1/files", { method: "POST" });
        await post("https://api.replicate.com/v1/predictions", { version: "o/m" });
      },
    );
    expect(out.job).toEqual({ provider: "replicate", id: "pred-xyz", attempt: 1 });
    expect(out.cost.operation_id).toBe("replicate:pred-xyz");
  });

  it("names the prediction after more uploads than provider_ids keeps", async () => {
    const uploads = Array.from({ length: 12 }, (_, i) => json({ id: `file-${i}` }, 201));
    const out = await runWith(
      "replicate",
      [...uploads, json({ id: "pred-xyz", model: "o/m" }, 201), json({ id: "pred-2" }, 201)],
      async () => {
        for (let i = 0; i < 12; i++) {
          await fetch("https://api.replicate.com/v1/files", { method: "POST" });
        }
        await post("https://api.replicate.com/v1/predictions", { version: "o/m" });
        await post("https://api.replicate.com/v1/predictions", { version: "o/m" });
      },
    );
    expect(out.job).toEqual({ provider: "replicate", id: "pred-xyz", attempt: 1 });
    expect(out.cost.operation_id).toBe("replicate:pred-xyz");
    // Only the job's id goes past the cap: ten upload ids, then the prediction.
    expect(out.provider_ids).toHaveLength(11);
  });

  it("names the job a result read was given when the body carries no id", async () => {
    const out = await runWith("fal", [json({ images: [] })], async () => {
      const { nameJob } = await import("../../../src/agent/run-state.js");
      nameJob("req-9");
      await fetch("https://queue.fal.run/fal-ai/flux/requests/req-9");
    });
    expect(out.job).toEqual({ provider: "fal", id: "req-9", attempt: 1 });
    // The submit run of the same job files under the same operation.
    expect(out.cost.operation_id).toBe("fal:req-9");
  });

  it("keeps an explicit MULTIX_OPERATION_ID over the job", async () => {
    vi.stubEnv("MULTIX_OPERATION_ID", "batch-7");
    const out = await runWith("replicate", [json({ id: "pred-1", model: "o/m" }, 201)], () =>
      post("https://api.replicate.com/v1/predictions", { version: "o/m" }),
    );
    expect(out.cost.operation_id).toBe("batch-7");
  });

  it("does not count a failed status poll as a resubmit", async () => {
    const url = "https://queue.fal.run/fal-ai/flux/requests/req-1/status";
    const out = await runWith(
      "fal",
      [
        json({ detail: "busy" }, 503, { "x-request-id": "poll-1" }),
        json({ status: "COMPLETED", request_id: "req-1" }),
      ],
      async () => {
        await fetch(url).then(() => undefined);
        await fetch(url).then(() => undefined);
      },
    );
    expect(out.job).toEqual({ provider: "fal", id: "req-1", attempt: 1 });
    // The submit run of the same job files under the same operation.
    expect(out.cost.operation_id).toBe("fal:req-1");
  });

  it("names no job when only a failed request returned an id", async () => {
    const out = await runWith(
      "fal",
      [json({ detail: "bad" }, 422, { "x-request-id": "rej-1" })],
      () => post("https://queue.fal.run/fal-ai/flux", {}),
    );
    expect(out.provider_ids).toEqual(["rej-1"]);
    expect(out.job).toBeUndefined();
    expect(out.cost.operation_id).toBe("fal:rej-1");
  });

  it("reads the model and response id after inline audio in an oversized body", async () => {
    const audio = "A".repeat(2_100_000);
    const body = `{"candidates":[{"content":{"parts":[{"inlineData":{"data":"${audio}"}}]}}],"usageMetadata":{"totalTokenCount":5},"modelVersion":"gemini-tts-001","responseId":"resp-big"}`;
    const out = await runWith(
      "gemini",
      [new Response(body, { headers: { "content-type": "application/json" } })],
      () =>
        post(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-tts:generateContent",
          {},
        ),
    );
    expect(out.model_resolved).toBe("gemini-tts-001");
    expect(out.job).toEqual({ provider: "gemini", id: "resp-big", attempt: 1 });
  });

  it("is absent for a command outside a provider group", async () => {
    const out = await runWith("", [json({ id: "x" })], () =>
      fetch("https://example.com/a").then(() => undefined),
    );
    expect(out.job).toBeUndefined();
  });
});
