import { describe, expect, it } from "vitest";
import { secretValues } from "../src/config.js";
import {
  CLI_PROVIDER_KEY_GROUPS,
  PROVIDER_KEY_GROUPS,
  PROVIDER_SECRET_NAMES,
  isProviderSecretName,
} from "../src/provider-secret-names.js";

interface CliProviderEntry {
  name: string;
  envPrimary: string;
  envFallback?: string;
  link: string;
  companions?: string[];
}

// Loaded at run time only: a static import would pull the CLI's Node types
// (src/core/env-loader.ts) into the Worker test typecheck. Vite resolves an
// absolute file path; the Workers types do not declare import.meta.url.
const testFileUrl = (import.meta as unknown as { url: string }).url;
const CLI_TABLE = decodeURIComponent(
  new URL("../../src/providers/provider-keys.ts", testFileUrl).pathname,
);

async function cliTable(): Promise<CliProviderEntry[]> {
  const mod = (await import(/* @vite-ignore */ CLI_TABLE)) as { PROVIDER_KEYS: CliProviderEntry[] };
  return mod.PROVIDER_KEYS;
}

describe("provider secret names", () => {
  it("mirrors every provider, link and key env name of the CLI table, in order", async () => {
    const expected = (await cliTable()).map((entry) => ({
      provider: entry.name,
      link: entry.link,
      names: [
        entry.envPrimary,
        ...(entry.envFallback ? [entry.envFallback] : []),
        ...(entry.companions ?? []),
      ],
    }));
    expect(CLI_PROVIDER_KEY_GROUPS).toEqual(expected);
  });

  it("lists the CLI names, then the Cloudflare Workers AI names, with no duplicates", () => {
    expect(PROVIDER_SECRET_NAMES).toEqual(PROVIDER_KEY_GROUPS.flatMap((g) => g.names));
    expect(PROVIDER_SECRET_NAMES.slice(-3)).toEqual([
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_AI_GATEWAY_ID",
    ]);
    expect(new Set(PROVIDER_SECRET_NAMES).size).toBe(PROVIDER_SECRET_NAMES.length);
    expect(isProviderSecretName("ARK_API_KEY")).toBe(true);
    expect(isProviderSecretName("MULTIX_ALLOWED_USERS")).toBe(false);
    expect(isProviderSecretName("toString")).toBe(false);
  });

  it("scrubs every stored credential from error text but not account or gateway ids", () => {
    const values = secretValues({
      GEMINI_API_KEY: "gemini-secret-value-1",
      ARK_API_KEY: "ark-secret-value-12345",
      CLOUDFLARE_API_TOKEN: "cf-token-value-123456",
      CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      CLOUDFLARE_AI_GATEWAY_ID: "gateway-id-1234",
      TOPVIEW_UID: "topview-account-uid-1",
      FAL_KEY: "short",
    });
    expect(values.sort()).toEqual(
      ["ark-secret-value-12345", "cf-token-value-123456", "gemini-secret-value-1"].sort(),
    );
  });
});
