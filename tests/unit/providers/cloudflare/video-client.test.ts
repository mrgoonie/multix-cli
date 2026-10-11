import { describe, expect, it } from "vitest";
import { isTransientHttpError } from "../../../../src/core/async-poll.js";
import { ConfigError, HttpError } from "../../../../src/core/errors.js";
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

const ORIGIN = "https://gateway.ai.cloudflare.com/";

function rejectingFetch(error: unknown) {
  return async (): Promise<Response> => {
    throw error;
  };
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the request to fail");
}

function expectNoIdentifiers(error: Error): void {
  for (const value of Object.values(config)) {
    expect(error.message).not.toContain(value);
    expect(JSON.stringify(error)).not.toContain(value);
  }
}

describe("Cloudflare video client errors", () => {
  it("reports a timeout as a transient HttpError(0) without account or gateway ids", async () => {
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
    expect(error.message).toMatch(/timed out after 0\.02s/);
    expect(isTransientHttpError(error)).toBe(true);
    expectNoIdentifiers(error);
  });

  it("reports an AbortError the same way", async () => {
    const abort = new DOMException("The operation was aborted", "AbortError");
    const error = await failure(
      getCloudflareVideoPrediction(config, "pred1", { fetch: rejectingFetch(abort) }),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect(error.message).toMatch(/timed out/);
  });

  it.each([
    ["an undici network failure", new TypeError("fetch failed")],
    ["a codeless Workers error", new Error("Network connection lost.")],
  ])("treats %s as a transient HttpError(0) naming only the origin", async (_label, cause) => {
    const error = await failure(
      getCloudflareVideoPrediction(config, "pred1", { fetch: rejectingFetch(cause) }),
    );
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(0);
    expect((error as HttpError).url).toBe(ORIGIN);
    expect(error.message).toContain(cause.message);
    expect(isTransientHttpError(error)).toBe(true);
    expectNoIdentifiers(error);
  });

  it("reports an invalid header value as a non-retryable ConfigError without the token", async () => {
    const cause = new TypeError(
      `Headers.append: "Bearer ${config.apiToken}\n" is an invalid header value.`,
    );
    const error = await failure(
      createCloudflareVideoPrediction(config, { prompt: "x" }, { fetch: rejectingFetch(cause) }),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(isTransientHttpError(error)).toBe(false);
    expect(error.message).not.toContain(config.apiToken);
    expectNoIdentifiers(error);
  });

  it("strips account and gateway ids from redirect failures", async () => {
    // Same-origin redirect back to itself: followed until the loop limit.
    const looping = async (url: string): Promise<Response> =>
      new Response(null, { status: 302, headers: { location: url } });
    const error = await failure(getCloudflareVideoPrediction(config, "pred1", { fetch: looping }));
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(302);
    expect(error.message).toMatch(/too many redirects/);
    expect((error as HttpError).url).toBe(ORIGIN);
    expectNoIdentifiers(error);
    // The original redirect error holds the full path; it must not survive as the cause.
    expect(error.cause).toBeUndefined();
  });
});
