/**
 * Live account balances from the providers that expose a read-only endpoint
 * for them (OpenRouter credits, ElevenLabs character quota). Every other
 * provider the account has a key for is reported as `unsupported`;
 * providers without a key are left out.
 *
 * Runtime-neutral (no node:* imports): the caller passes fetch and the keys.
 * Results never carry response bodies or key values, only fixed wording.
 */

import type { ProviderKeys, ProviderSecretName } from "../provider-secret-names.js";
import type { ProviderBalance } from "./usage-types.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const BALANCE_TIMEOUT_MS = 10_000;

/** Ledger provider (CLI command group) of each credential; identifiers that are not keys are absent. */
const PROVIDER_OF: Partial<Record<ProviderSecretName, string>> = {
  GEMINI_API_KEY: "gemini",
  OPENROUTER_API_KEY: "openrouter",
  OPENAI_API_KEY: "openai",
  MINIMAX_API_KEY: "minimax",
  LEONARDO_API_KEY: "leonardo",
  BYTEPLUS_API_KEY: "byteplus",
  ARK_API_KEY: "byteplus",
  ELEVENLABS_API_KEY: "elevenlabs",
  FAL_KEY: "fal",
  ATLASCLOUD_API_KEY: "atlas",
  REPLICATE_API_TOKEN: "replicate",
  REPLICATE_API_KEY: "replicate",
  RUNWAYML_API_SECRET: "runway",
  HEYGEN_API_KEY: "heygen",
  CLOUDFLARE_API_TOKEN: "cloudflare",
};

type Reading = Pick<ProviderBalance, "kind" | "unit" | "remaining" | "used" | "limit">;

/** A failed lookup with fixed wording, so nothing from the provider reaches the caller. */
class BalanceFailure extends Error {
  constructor(
    readonly status: "forbidden" | "error",
    detail: string,
  ) {
    super(detail);
  }
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

async function getJson(fetch: FetchLike, url: string, headers: Record<string, string>) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    });
  } catch {
    throw new BalanceFailure("error", "The provider could not be reached");
  }
  if (response.status === 401 || response.status === 403) {
    throw new BalanceFailure("forbidden", "The provider refused the saved key");
  }
  if (!response.ok) {
    throw new BalanceFailure("error", `The provider answered HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as Record<string, unknown> | null;
  } catch {
    throw new BalanceFailure("error", "The provider sent an unreadable answer");
  }
}

async function openRouterCredits(fetch: FetchLike, key: string): Promise<Reading> {
  const body = await getJson(fetch, "https://openrouter.ai/api/v1/credits", {
    authorization: `Bearer ${key}`,
  });
  const data = (body?.data ?? {}) as Record<string, unknown>;
  const total = num(data.total_credits);
  const used = num(data.total_usage);
  if (total === null || used === null) {
    throw new BalanceFailure("error", "The provider sent an unexpected answer");
  }
  return { kind: "cash", unit: "USD", remaining: total - used, used, limit: total };
}

async function elevenLabsQuota(fetch: FetchLike, key: string): Promise<Reading> {
  const body = await getJson(fetch, "https://api.elevenlabs.io/v1/user/subscription", {
    "xi-api-key": key,
  });
  const used = num(body?.character_count);
  const limit = num(body?.character_limit);
  if (used === null || limit === null) {
    throw new BalanceFailure("error", "The provider sent an unexpected answer");
  }
  return {
    kind: "subscription_quota",
    unit: "characters",
    remaining: Math.max(limit - used, 0),
    used,
    limit,
  };
}

const READERS: Record<string, (fetch: FetchLike, key: string) => Promise<Reading>> = {
  openrouter: openRouterCredits,
  elevenlabs: elevenLabsQuota,
};

/** One balance per provider the account has a key for, sorted by provider; `now` stamps checkedAt. */
export async function fetchProviderBalances(
  keys: ProviderKeys,
  fetch: FetchLike,
  now: number,
): Promise<ProviderBalance[]> {
  // First key per provider wins: primary names come before fallbacks in PROVIDER_OF.
  const keyOf = new Map<string, string>();
  for (const [name, provider] of Object.entries(PROVIDER_OF)) {
    const key = keys[name as ProviderSecretName]?.trim();
    if (provider && key && !keyOf.has(provider)) keyOf.set(provider, key);
  }
  const providers = [...keyOf.keys()].sort();
  return Promise.all(
    providers.map(async (provider): Promise<ProviderBalance> => {
      const empty = { kind: null, unit: null, remaining: null, used: null, limit: null };
      const read = READERS[provider];
      if (!read) {
        return {
          provider,
          status: "unsupported",
          checkedAt: now,
          ...empty,
          detail: "This provider has no balance endpoint multix can read",
        };
      }
      try {
        const reading = await read(fetch, keyOf.get(provider) as string);
        return { provider, status: "ok", checkedAt: now, ...reading, detail: null };
      } catch (error) {
        const failure =
          error instanceof BalanceFailure
            ? error
            : new BalanceFailure("error", "The balance could not be read");
        return {
          provider,
          status: failure.status,
          checkedAt: now,
          ...empty,
          detail: failure.message,
        };
      }
    }),
  );
}
