import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigError, ValidationError } from "../../../../src/core/errors.js";
import {
  CLOUDFLARE_IMAGE_MODEL,
  CLOUDFLARE_TTS_MODEL,
  getCloudflareModel,
  requireCloudflareConfig,
  requireCloudflareVideoConfig,
  validateImageSteps,
} from "../../../../src/providers/cloudflare/models.js";

describe("Cloudflare model catalog", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows only the supported native media models", () => {
    expect(getCloudflareModel("image")).toBe(CLOUDFLARE_IMAGE_MODEL);
    expect(getCloudflareModel("speech")).toBe(CLOUDFLARE_TTS_MODEL);
    expect(() => getCloudflareModel("image", "arbitrary/model")).toThrow(ValidationError);
  });

  it("validates FLUX Schnell steps", () => {
    expect(validateImageSteps("1")).toBe(1);
    expect(validateImageSteps("8")).toBe(8);
    expect(() => validateImageSteps("0")).toThrow(ValidationError);
    expect(() => validateImageSteps("9")).toThrow(ValidationError);
    expect(() => validateImageSteps("4steps")).toThrow(ValidationError);
  });

  it("requires only native credentials for image and speech", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    expect(requireCloudflareConfig()).toEqual({
      accountId: "account",
      apiToken: "token",
      gatewayId: undefined,
    });
  });

  it("requires gateway and Replicate credentials for video", () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    expect(() => requireCloudflareVideoConfig()).toThrow(ConfigError);

    vi.stubEnv("CLOUDFLARE_AI_GATEWAY_ID", "gateway");
    vi.stubEnv("REPLICATE_API_TOKEN", "replicate");
    expect(requireCloudflareVideoConfig()).toMatchObject({
      gatewayId: "gateway",
      replicateApiToken: "replicate",
    });
  });
});
