/**
 * Opt-in live smoke test against the real Replicate API. Skipped by default.
 *
 *   MULTIX_MCP_LIVE=1 REPLICATE_API_TOKEN=... npm test --prefix worker -- live-smoke
 *
 * Runs the Worker handler in-process with the real fetch: tools/list, one
 * cheap image (1 output, default flux-schnell) and, only with
 * MULTIX_MCP_LIVE_VIDEO=1 as well, one video start + status + cancel.
 * Costs a few cents. Never prints credential values: the handler scrubs its
 * own output and this file only asserts on tool results.
 */

import { describe, expect, it } from "vitest";
import type { Env } from "../src/config.js";
import { TOKEN, callTool, rpc } from "./helpers.js";

const vars =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const replicateToken = vars.REPLICATE_API_TOKEN?.trim() || vars.REPLICATE_API_KEY?.trim();
const enabled = vars.MULTIX_MCP_LIVE === "1" && Boolean(replicateToken);
const videoEnabled = enabled && vars.MULTIX_MCP_LIVE_VIDEO === "1";

function liveEnv(): Env {
  return {
    MCP_AUTH_TOKEN: TOKEN,
    REPLICATE_API_TOKEN: replicateToken,
    MULTIX_MCP_ALLOWED_PROVIDERS: "replicate",
    MULTIX_MCP_MAX_OUTPUTS: "1",
    MULTIX_MCP_MAX_VIDEO_SECONDS: "5",
  };
}

describe.skipIf(!enabled)("live smoke (MULTIX_MCP_LIVE=1 + REPLICATE_API_TOKEN)", () => {
  it("lists tools", async () => {
    const body = await rpc(liveEnv(), "tools/list");
    expect(body.result.tools.length).toBeGreaterThanOrEqual(5);
  });

  it("generates one image and returns a URL or a pollable id", async () => {
    const result = await callTool(liveEnv(), "multix_generate_image", {
      provider: "replicate",
      prompt: "a single red apple on a white table, studio photo",
      num_outputs: 1,
      wait_seconds: 25,
    });
    expect(result.isError).toBeFalsy();
    const job = result.structuredContent;
    expect(job.id).toMatch(/^[A-Za-z0-9_-]+$/);
    if (job.done) {
      expect(job.succeeded).toBe(true);
      expect(job.outputs[0]).toMatch(/^https:\/\//);
    } else {
      expect(job.next.tool).toBe("multix_prediction_status");
    }
  }, 60_000);

  it.skipIf(!videoEnabled)(
    "starts a video, reads its status and cancels it",
    async () => {
      const env = liveEnv();
      const started = await callTool(env, "multix_generate_video", {
        provider: "replicate",
        prompt: "slow ocean waves at sunset",
      });
      expect(started.isError).toBeFalsy();
      const id = started.structuredContent.id as string;
      const status = await callTool(env, "multix_prediction_status", {
        provider: "replicate",
        prediction_id: id,
      });
      expect(status.isError).toBeFalsy();
      expect(status.structuredContent.id).toBe(id);
      const canceled = await callTool(env, "multix_prediction_cancel", {
        provider: "replicate",
        prediction_id: id,
      });
      expect(canceled.isError).toBeFalsy();
    },
    60_000,
  );
});
