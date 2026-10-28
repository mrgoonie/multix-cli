/**
 * Every provider credential an account can store from the dashboard: the key
 * env names the CLI reads (src/providers/provider-keys.ts, primary then
 * fallback, in the CLI's order) plus the Cloudflare Workers AI names.
 *
 * Kept as a literal table rather than imported: provider-keys.ts type-imports
 * src/core/env-loader.ts, which pulls Node types into the Worker typecheck.
 * test/provider-secret-names.test.ts fails when this table drifts from the CLI's.
 */

export interface ProviderKeyGroup {
  /** Provider name shown on the dashboard (same as the CLI table). */
  provider: string;
  /** Where to create a key. */
  link: string;
  /** Env names, primary first; later names are fallbacks the CLI reads when earlier ones are unset. */
  names: readonly ProviderSecretName[];
}

/** Names from the CLI table, in its order. */
const CLI_KEY_NAMES = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "MINIMAX_API_KEY",
  "LEONARDO_API_KEY",
  "BYTEPLUS_API_KEY",
  "ARK_API_KEY",
  "ELEVENLABS_API_KEY",
  "FISH_API_KEY",
  "FAL_KEY",
  "ATLASCLOUD_API_KEY",
  "REPLICATE_API_TOKEN",
  "REPLICATE_API_KEY",
  "RUNWAYML_API_SECRET",
  "SUME_API_KEY",
  "HEYGEN_API_KEY",
] as const;

const CLOUDFLARE_NAMES = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_AI_GATEWAY_ID",
] as const;

/** Every name an account can store, in dashboard order. */
export const PROVIDER_SECRET_NAMES = [...CLI_KEY_NAMES, ...CLOUDFLARE_NAMES] as const;
export type ProviderSecretName = (typeof PROVIDER_SECRET_NAMES)[number];

/** Plaintext provider keys of one account, keyed by env name. */
export type ProviderKeys = Partial<Record<ProviderSecretName, string>>;

/** Mirrors the CLI table's provider names, links and env names. */
export const CLI_PROVIDER_KEY_GROUPS: readonly ProviderKeyGroup[] = [
  { provider: "Gemini", link: "https://aistudio.google.com/apikey", names: ["GEMINI_API_KEY"] },
  {
    provider: "OpenRouter",
    link: "https://openrouter.ai/settings/keys",
    names: ["OPENROUTER_API_KEY"],
  },
  { provider: "OpenAI", link: "https://platform.openai.com/api-keys", names: ["OPENAI_API_KEY"] },
  {
    provider: "MiniMax",
    link: "https://platform.minimax.io/user-center/basic-information/interface-key",
    names: ["MINIMAX_API_KEY"],
  },
  {
    provider: "Leonardo.Ai",
    link: "https://app.leonardo.ai/settings/api-keys",
    names: ["LEONARDO_API_KEY"],
  },
  {
    provider: "BytePlus",
    link: "https://console.byteplus.com/auth/api-keys",
    names: ["BYTEPLUS_API_KEY", "ARK_API_KEY"],
  },
  {
    provider: "ElevenLabs",
    link: "https://elevenlabs.io/app/settings/api-keys",
    names: ["ELEVENLABS_API_KEY"],
  },
  { provider: "Fish Audio", link: "https://fish.audio/app/api-keys/", names: ["FISH_API_KEY"] },
  { provider: "fal.ai", link: "https://fal.ai/dashboard/keys", names: ["FAL_KEY"] },
  {
    provider: "Atlas Cloud",
    link: "https://www.atlascloud.ai/console/api-keys",
    names: ["ATLASCLOUD_API_KEY"],
  },
  {
    provider: "Replicate",
    link: "https://replicate.com/account/api-tokens",
    names: ["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"],
  },
  { provider: "Runway", link: "https://dev.runwayml.com/", names: ["RUNWAYML_API_SECRET"] },
  {
    provider: "Sume",
    link: "https://www.sume.com/docs/authentication",
    names: ["SUME_API_KEY"],
  },
  { provider: "HeyGen", link: "https://app.heygen.com/developers/api", names: ["HEYGEN_API_KEY"] },
];

/** Dashboard groups: the CLI providers, then Cloudflare Workers AI. */
export const PROVIDER_KEY_GROUPS: readonly ProviderKeyGroup[] = [
  ...CLI_PROVIDER_KEY_GROUPS,
  {
    provider: "Cloudflare Workers AI",
    link: "https://dash.cloudflare.com/profile/api-tokens",
    names: CLOUDFLARE_NAMES,
  },
];

/** Identifiers rather than credentials: rendered as plain text inputs and not scrubbed from errors. */
export const NON_SECRET_NAMES: ReadonlySet<ProviderSecretName> = new Set<ProviderSecretName>([
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AI_GATEWAY_ID",
]);

const NAME_SET: ReadonlySet<string> = new Set(PROVIDER_SECRET_NAMES);

export function isProviderSecretName(name: string): name is ProviderSecretName {
  return NAME_SET.has(name);
}
