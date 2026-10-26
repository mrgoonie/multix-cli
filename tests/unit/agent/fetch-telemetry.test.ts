/**
 * The CLI fetch wrapper records provider usage with the host that reported it,
 * so a credit number in the envelope always names its source.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { installFetchTelemetry, settleTelemetry } from "../../../src/agent/fetch-telemetry.js";
import { run } from "../../../src/agent/run-state.js";

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
  run.postUsage = [];
  run.calls = [];
  run.ids = [];
  run.requestModel = undefined;
});

describe("installFetchTelemetry", () => {
  it("prefixes usage sources with the responding host", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "audio/mpeg", "character-cost": "5" },
        }),
    ) as typeof fetch;
    installFetchTelemetry(() => {
      throw new Error("not a dry run");
    });
    await fetch("https://api.elevenlabs.io/v1/text-to-speech/v", {
      method: "POST",
      body: JSON.stringify({ text: "Hi", model_id: "eleven_v4" }),
    });
    await settleTelemetry();
    expect(run.requestModel).toBe("eleven_v4");
    expect(run.postUsage).toHaveLength(1);
    expect(run.postUsage[0]?.credits).toBe(5);
    expect(run.postUsage[0]?.sources).toEqual({
      credits: "api.elevenlabs.io header.character-cost",
    });
  });
});
