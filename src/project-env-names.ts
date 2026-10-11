/**
 * Variable names a project-level `.env` may set: the names multix itself
 * reads. Anything else in a project `.env` (NODE_OPTIONS, npm_config_*,
 * LD_PRELOAD, proxy and TLS settings, …) is ignored by loadEnv, so a cloned
 * repository cannot change how multix or the tools it spawns behave.
 *
 * Built from the constants the providers export where they exist; settings
 * that are read inline are listed in INLINE_SETTINGS. A unit test scans `src/`
 * and `.env.example` so a newly read variable cannot be left out.
 */

import { getCheckProviders } from "./commands/check.js";
import { envNameKey } from "./core/env-loader.js";
import { ATLAS_MODEL_ENV, MAX_UPLOAD_ENV } from "./providers/atlascloud/commands/env.js";
import { ATLAS_ROUTING } from "./providers/atlascloud/models.js";
import { BYTEPLUS_ROUTING } from "./providers/byteplus/models.js";
import {
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_GATEWAY_ID_ENV,
  CLOUDFLARE_VIDEO_CREDENTIALS,
} from "./providers/cloudflare/models.js";
import { FAL_ROUTING } from "./providers/fal/models.js";
import { HEYGEN_ROUTING } from "./providers/heygen/models.js";
import { LEONARDO_ROUTING } from "./providers/leonardo/models.js";
import { REPLICATE_ROUTING } from "./providers/replicate/models.js";

/** Model defaults and other provider settings that are read by name in place. */
const INLINE_SETTINGS = [
  "GEMINI_MODEL",
  "MULTIMODAL_MODEL",
  "IMAGE_GEN_MODEL",
  "GEMINI_IMAGE_GEN_MODEL",
  "VIDEO_GEN_MODEL",
  "GEMINI_TTS_MODEL",
  "TTS_MODEL",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_TTS_MODEL",
  "OPENAI_STT_MODEL",
  "OPENROUTER_IMAGE_MODEL",
  "OPENROUTER_VIDEO_MODEL",
  "OPENROUTER_FALLBACK_MODELS",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_NAME",
  "MINIMAX_IMAGE_MODEL",
  "MINIMAX_VIDEO_MODEL",
  "MINIMAX_SPEECH_MODEL",
  "MINIMAX_MUSIC_MODEL",
  "LEONARDO_DEFAULT_MODEL",
  "LEONARDO_VIDEO_MODEL",
  "BYTEPLUS_IMAGE_MODEL",
  "BYTEPLUS_VIDEO_MODEL",
  "BYTEPLUS_3D_MODEL",
  "BYTEPLUS_VIDEO_PARAMS_MODE",
  "FAL_IMAGE_MODEL",
  "FAL_VIDEO_MODEL",
  "FAL_VIDEO_IMAGE_MODEL",
  "REPLICATE_IMAGE_MODEL",
  "REPLICATE_VIDEO_MODEL",
  "CLOUDFLARE_AI_IMAGE_MODEL",
  "CLOUDFLARE_AI_TTS_MODEL",
  "CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD",
  "NO_COLOR",
] as const;

const ROUTING = [
  ATLAS_ROUTING,
  BYTEPLUS_ROUTING,
  FAL_ROUTING,
  HEYGEN_ROUTING,
  LEONARDO_ROUTING,
  REPLICATE_ROUTING,
];

/** Every fixed name multix reads (MULTIX_* and numbered Gemini keys are matched by pattern). */
export const PROJECT_ENV_NAMES: ReadonlySet<string> = new Set([
  ...getCheckProviders().flatMap((p) =>
    p.envFallback ? [p.envPrimary, p.envFallback] : [p.envPrimary],
  ),
  ...ROUTING.flatMap((r) => [r.name, ...r.keyEnvs]),
  CLOUDFLARE_ACCOUNT_ID_ENV,
  CLOUDFLARE_GATEWAY_ID_ENV,
  ...CLOUDFLARE_VIDEO_CREDENTIALS,
  ...Object.values(ATLAS_MODEL_ENV),
  MAX_UPLOAD_ENV,
  ...INLINE_SETTINGS,
]);

/** `MULTIX_*` settings and the Gemini rotation keys `GEMINI_API_KEY_2`, `_3`, … */
const PROJECT_ENV_PATTERN = /^(MULTIX_[A-Z0-9_]+|GEMINI_API_KEY_\d+)$/;

/**
 * True when a project `.env` may set `name`. On Windows env names are
 * case-insensitive, so the check ignores case there, as the OS does.
 */
export function isProjectEnvName(
  name: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const key = envNameKey(name, platform);
  return PROJECT_ENV_NAMES.has(key) || PROJECT_ENV_PATTERN.test(key);
}
