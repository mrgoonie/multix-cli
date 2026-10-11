import { describe, expect, it } from "vitest";
import { HttpError, ProviderError } from "../../../../src/core/errors.js";
import {
  type CloudflareVideoConfig,
  createCloudflareVideoPrediction,
  getCloudflareVideoPrediction,
} from "../../../../src/providers/cloudflare/video-client.js";

const config: CloudflareVideoConfig = {
  accountId: "acct-secret-id",
  apiToken: "cf-token-value",
  gatewayId: "gw-private",
  replicateApiToken: "r8-token-value",
};

function rejectingFetch(error: unknown) {
  return async (): Promise<Response> => {
    throw error;
  };
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the request to fail");
}

function expectNoIdentifiers(error: Error): void {
  for (const value of Object.values(config)) expect(error.message).not.toContain(value);
}

describe("Cloudflare video client errors", () => {
  it("reports a timeout as HttpError(0) without account or gateway ids", async () => {
    // Never resolves until the per-request timeout aborts it.
    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const error = await failure(
      createCloudflareVideoPrediction(config, { prompt: "x" }, { fetch: hanging, timeoutMs: 20 }),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(0);
    expect((error as HttpError).message).toMatch(/timed out after 0\.02s/);
    expectNoIdentifiers(error as Error);
  });

  it("reports an AbortError the same way", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    const error = await failure(
      getCloudflareVideoPrediction(config, "pred1", { fetch: rejectingFetch(abort) }),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).message).toMatch(/timed out/);
  });

  it("reports a network failure as HttpError(0)", async () => {
    const error = await failure(
      getCloudflareVideoPrediction(config, "pred1", {
        fetch: rejectingFetch(new TypeError("fetch failed")),
      }),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(0);
    expect((error as HttpError).message).toMatch(/network error: fetch failed/);
    expect((error as HttpError).url).toBe("https://gateway.ai.cloudflare.com/");
    expectNoIdentifiers(error as Error);
  });

  it("wraps any other fetch rejection in a ProviderError", async () => {
    const error = await failure(
      createCloudflareVideoPrediction(
        config,
        { prompt: "x" },
        { fetch: rejectingFetch(new Error("boom")) },
      ),
    );
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe("Cloudflare request failed: boom");
  });
});
