/**
 * The API key env names of each provider, in the order the provider reads
 * them, with where to get a key. `multix check` reports on this table and the
 * project `.env` allowlist (src/project-env-names.ts) is built from it.
 */

import type { BaseUrlRouting } from "../core/env-loader.js";
import { ATLAS_ROUTING } from "./atlascloud/models.js";
import { BYTEPLUS_ROUTING } from "./byteplus/models.js";
import { FAL_ROUTING } from "./fal/models.js";
import { HEYGEN_ROUTING } from "./heygen/models.js";
import { LEONARDO_ROUTING } from "./leonardo/models.js";
import { REPLICATE_ROUTING } from "./replicate/models.js";
import { RUNWAY_DASHBOARD_LINK, RUNWAY_ROUTING } from "./runway/models.js";

export interface ProviderEntry {
  name: string;
  envPrimary: string;
  envFallback?: string;
  optional: boolean;
  link: string;
}

/** Key names of a provider that exports its BaseUrlRouting, in the order it reads them. */
function keyNames(routing: BaseUrlRouting): Pick<ProviderEntry, "envPrimary" | "envFallback"> {
  const [envPrimary, envFallback] = routing.keyEnvs;
  return envFallback ? { envPrimary, envFallback } : { envPrimary };
}

export const PROVIDER_KEYS: readonly ProviderEntry[] = [
  {
    name: "Gemini",
    envPrimary: "GEMINI_API_KEY",
    optional: false,
    link: "https://aistudio.google.com/apikey",
  },
  {
    name: "OpenRouter",
    envPrimary: "OPENROUTER_API_KEY",
    optional: true,
    link: "https://openrouter.ai/settings/keys",
  },
  {
    name: "OpenAI",
    envPrimary: "OPENAI_API_KEY",
    optional: true,
    link: "https://platform.openai.com/api-keys",
  },
  {
    name: "MiniMax",
    envPrimary: "MINIMAX_API_KEY",
    optional: true,
    link: "https://platform.minimax.io/user-center/basic-information/interface-key",
  },
  {
    name: "Leonardo.Ai",
    ...keyNames(LEONARDO_ROUTING),
    optional: true,
    link: "https://app.leonardo.ai/settings/api-keys",
  },
  {
    name: "BytePlus",
    ...keyNames(BYTEPLUS_ROUTING),
    optional: true,
    link: "https://console.byteplus.com/auth/api-keys",
  },
  {
    name: "ElevenLabs",
    envPrimary: "ELEVENLABS_API_KEY",
    optional: true,
    link: "https://elevenlabs.io/app/settings/api-keys",
  },
  {
    name: "Fish Audio",
    envPrimary: "FISH_API_KEY",
    optional: true,
    link: "https://fish.audio/app/api-keys/",
  },
  {
    name: "fal.ai",
    ...keyNames(FAL_ROUTING),
    optional: true,
    link: "https://fal.ai/dashboard/keys",
  },
  {
    name: "Atlas Cloud",
    ...keyNames(ATLAS_ROUTING),
    optional: true,
    link: "https://www.atlascloud.ai/console/api-keys",
  },
  {
    name: "Replicate",
    ...keyNames(REPLICATE_ROUTING),
    optional: true,
    link: "https://replicate.com/account/api-tokens",
  },
  {
    name: "Runway",
    ...keyNames(RUNWAY_ROUTING),
    optional: true,
    link: RUNWAY_DASHBOARD_LINK,
  },
  {
    name: "HeyGen",
    ...keyNames(HEYGEN_ROUTING),
    optional: true,
    link: "https://app.heygen.com/developers/api",
  },
];
