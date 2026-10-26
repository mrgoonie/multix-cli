import { afterEach, describe, expect, it } from "vitest";
import {
  installFetchTelemetry,
  settleTelemetry,
  usageFromTail,
} from "../../../src/agent/fetch-telemetry.js";
import { run } from "../../../src/agent/run-state.js";
import { extractUsage } from "../../../src/core/usage-extract.js";

describe("usage from the tail of an oversized JSON body", () => {
  it("finds Gemini usageMetadata after inline audio", () => {
    const tail = `${"QUJD".repeat(1000)}"}}]}}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":250,"totalTokenCount":270},"modelVersion":"x"}`;
    const body = usageFromTail(tail);
    expect(body).toEqual({
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 250, totalTokenCount: 270 },
    });
    expect(extractUsage(body).tokens).toMatchObject({ input: 20, output: 250 });
  });

  it("finds the Interactions API usage block", () => {
    const tail = `AAAA"}],"usage":{"total_input_tokens":12,"total_output_tokens":500}}`;
    expect(usageFromTail(tail)).toEqual({
      usage: { total_input_tokens: 12, total_output_tokens: 500 },
    });
  });

  it("ignores a cut-off block or the word inside a string", () => {
    expect(usageFromTail(`"usageMetadata":{"promptTokenCount":20`)).toBeUndefined();
    expect(usageFromTail(`"text":"see usage notes"`)).toBeUndefined();
  });
});

describe("telemetry on a large Gemini TTS response", () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
    run.postUsage.length = 0;
    run.calls.length = 0;
  });

  it("records usage from a 3 MB JSON body without buffering it whole", async () => {
    const audio = "QUJD".repeat(750_000);
    const body = `{"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"audio/L16","data":"${audio}"}}]}}],"usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":2500,"totalTokenCount":2520}}`;
    globalThis.fetch = (async () =>
      new Response(body, { headers: { "content-type": "application/json" } })) as typeof fetch;
    installFetchTelemetry(() => {
      throw new Error("not a dry run");
    });
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/x:generateContent",
      {
        method: "POST",
        body: "{}",
      },
    );
    const json = (await res.json()) as { candidates: unknown[] };
    expect(json.candidates).toHaveLength(1);
    await settleTelemetry();
    expect(run.postUsage.at(-1)?.tokens).toMatchObject({ input: 20, output: 2500 });
  });
});
