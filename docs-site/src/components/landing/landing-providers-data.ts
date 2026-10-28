/**
 * Providers and popular models for the landing page, derived at build time
 * from the CLI's own source (repo-root src/), so the page cannot drift from
 * what multix ships:
 * - the provider list and each provider's modalities come from
 *   src/capabilities/command-capabilities.ts (every command, classified by task);
 * - display names come from src/providers/provider-keys.ts (what `multix check`
 *   prints), except Cloudflare, which `multix check` reports on its own;
 * - model ids are imported constants or are checked against the model list the
 *   provider's commands validate against (src/providers/<name>/models.ts, and
 *   src/capabilities/model-registry.ts for fal).
 *
 * A new command group, a renamed provider or a removed model throws here and
 * fails `npm run build`, instead of shipping a stale list. Only data modules
 * with no `node:*` imports are read; env-backed getters are never called, so
 * the build machine's environment cannot change the page.
 */

import type { Task } from "../../../../src/capabilities/capability-types.ts";
import { COMMAND_CAPABILITIES } from "../../../../src/capabilities/command-capabilities.ts";
import { verifiedModels } from "../../../../src/capabilities/model-registry.ts";
import { ATLAS_DEFAULT_MODELS } from "../../../../src/providers/atlascloud/models.ts";
import {
  BYTEPLUS_3D_MODELS,
  BYTEPLUS_VIDEO_MODELS,
  DEFAULT_BYTEPLUS_IMAGE_MODEL,
} from "../../../../src/providers/byteplus/models.ts";
import {
  CLOUDFLARE_IMAGE_MODEL,
  CLOUDFLARE_TTS_MODEL,
  CLOUDFLARE_VIDEO_MODEL,
} from "../../../../src/providers/cloudflare/model-ids.ts";
import {
  ELEVENLABS_STT_MODELS,
  ELEVENLABS_TTS_MODELS,
} from "../../../../src/providers/elevenlabs/models.ts";
import { DEFAULT_FISH_TTS_MODEL, FISH_TTS_MODELS } from "../../../../src/providers/fish/models.ts";
import {
  IMAGE_MODEL_DEFAULT as GEMINI_IMAGE_MODEL,
  TEXT_MODEL_DEFAULT as GEMINI_TEXT_MODEL,
  TTS_MODEL_DEFAULT as GEMINI_TTS_MODEL,
  VIDEO_MODEL_DEFAULT as GEMINI_VIDEO_MODEL,
} from "../../../../src/providers/gemini/models.ts";
import { AVATAR_ENGINES, HEYGEN_VIDEO_MODEL } from "../../../../src/providers/heygen/models.ts";
import { LEONARDO_VIDEO_MODELS } from "../../../../src/providers/leonardo/models.ts";
import {
  MINIMAX_IMAGE_MODELS,
  MINIMAX_MUSIC_MODELS,
  MINIMAX_SPEECH_MODELS,
  MINIMAX_VIDEO_MODELS,
} from "../../../../src/providers/minimax/models.ts";
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  DEFAULT_OPENAI_STT_MODEL,
  DEFAULT_OPENAI_TTS_MODEL,
} from "../../../../src/providers/openai/models.ts";
import {
  DEFAULT_OPENROUTER_STT_MODEL,
  DEFAULT_OPENROUTER_TTS_MODEL,
} from "../../../../src/providers/openrouter/speech-defaults.ts";
import { PROVIDER_KEYS } from "../../../../src/providers/provider-keys.ts";
import {
  DEFAULT_REPLICATE_IMAGE_MODEL,
  DEFAULT_REPLICATE_VIDEO_MODEL,
} from "../../../../src/providers/replicate/models.ts";
import {
  DEFAULT_RUNWAY_IMAGE_MODEL,
  DEFAULT_RUNWAY_VIDEO_MODEL,
  VIDEO_MODELS as RUNWAY_VIDEO_MODELS,
} from "../../../../src/providers/runway/models.ts";

/** What a provider can produce or read, as shown on the page (labels live in landing-copy.ts). */
export const PROVIDER_MODALITIES = [
  "image",
  "video",
  "avatar",
  "speech",
  "transcription",
  "voice",
  "music",
  "sfx",
  "3d",
  "analysis",
  "document",
  "catalog",
] as const;

export type ProviderModality = (typeof PROVIDER_MODALITIES)[number];

/** Each multix task folded into one visitor-facing modality ("any" is handled per command). */
const TASK_MODALITY: Record<Exclude<Task, "any">, ProviderModality> = {
  image: "image",
  "image-edit": "image",
  video: "video",
  "image-to-video": "video",
  "video-edit": "video",
  "avatar-video": "avatar",
  speech: "speech",
  transcription: "transcription",
  voice: "voice",
  music: "music",
  sfx: "sfx",
  "3d": "3d",
  analysis: "analysis",
  document: "document",
};

/**
 * Command groups that are not providers. `doc convert` runs on Gemini
 * (src/commands/doc/convert.ts), so its tasks count for Gemini; `speech` and
 * `scene` route to providers listed on their own.
 */
const NON_PROVIDER_GROUPS: Readonly<Record<string, string | null>> = {
  doc: "gemini",
  speech: null,
  scene: null,
};

/** Return `id` if the provider's own model list has it; otherwise fail the build. */
function listed(list: Iterable<string>, id: string, source: string): string {
  for (const model of list) if (model === id) return id;
  throw new Error(`landing providers: "${id}" is not in ${source}; update the popular models`);
}

const ids = (list: readonly { id: string }[]) => list.map((m) => m.id);
const falRegistry = verifiedModels({ provider: "fal" }).map((m) => m.model);

interface ProviderSource {
  /** CLI command group: `multix <group> ...`. */
  group: string;
  name: string;
  /** Docs page under /commands/. */
  slug: string;
  /**
   * Popular models, 2-4 per provider. Selection rule: first the model multix
   * runs when `--model` is omitted, one per headline task (image, video,
   * speech, transcription, music, 3D); where those are fewer than two, or are
   * opaque ids (Leonardo's image default is a UUID), the newest flagship
   * entries of the provider's own allow-list fill in. fal's picks come from
   * the verified model registry, one per model family.
   */
  models: readonly string[];
}

const SOURCES: readonly ProviderSource[] = [
  {
    group: "gemini",
    name: "Gemini",
    slug: "gemini",
    models: [GEMINI_IMAGE_MODEL, GEMINI_VIDEO_MODEL, GEMINI_TTS_MODEL, GEMINI_TEXT_MODEL],
  },
  {
    group: "openai",
    name: "OpenAI",
    slug: "openai",
    models: [DEFAULT_OPENAI_IMAGE_MODEL, DEFAULT_OPENAI_TTS_MODEL, DEFAULT_OPENAI_STT_MODEL],
  },
  {
    group: "minimax",
    name: "MiniMax",
    slug: "minimax",
    models: [
      listed(MINIMAX_IMAGE_MODELS, "image-01", "MINIMAX_IMAGE_MODELS"),
      listed(MINIMAX_VIDEO_MODELS, "MiniMax-Hailuo-2.3", "MINIMAX_VIDEO_MODELS"),
      listed(MINIMAX_SPEECH_MODELS, "speech-2.8-hd", "MINIMAX_SPEECH_MODELS"),
      listed(MINIMAX_MUSIC_MODELS, "music-2.5", "MINIMAX_MUSIC_MODELS"),
    ],
  },
  {
    group: "openrouter",
    name: "OpenRouter",
    slug: "openrouter",
    models: [DEFAULT_OPENROUTER_TTS_MODEL, DEFAULT_OPENROUTER_STT_MODEL],
  },
  {
    group: "leonardo",
    name: "Leonardo.Ai",
    slug: "leonardo",
    models: [
      listed(ids(LEONARDO_VIDEO_MODELS), "MOTION2", "LEONARDO_VIDEO_MODELS"),
      listed(ids(LEONARDO_VIDEO_MODELS), "VEO3_1", "LEONARDO_VIDEO_MODELS"),
      listed(ids(LEONARDO_VIDEO_MODELS), "kling-3.0", "LEONARDO_VIDEO_MODELS"),
    ],
  },
  {
    group: "byteplus",
    name: "BytePlus",
    slug: "byteplus",
    models: [
      DEFAULT_BYTEPLUS_IMAGE_MODEL,
      listed(ids(BYTEPLUS_VIDEO_MODELS), "seedance-2.0", "BYTEPLUS_VIDEO_MODELS"),
      listed(ids(BYTEPLUS_3D_MODELS), "hyper3d-gen2-260112", "BYTEPLUS_3D_MODELS"),
    ],
  },
  {
    group: "cloudflare",
    name: "Cloudflare",
    slug: "cloudflare",
    models: [CLOUDFLARE_IMAGE_MODEL, CLOUDFLARE_TTS_MODEL, CLOUDFLARE_VIDEO_MODEL],
  },
  {
    group: "elevenlabs",
    name: "ElevenLabs",
    slug: "elevenlabs",
    models: [
      listed(ELEVENLABS_TTS_MODELS, "eleven_v4", "ELEVENLABS_TTS_MODELS"),
      listed(ELEVENLABS_TTS_MODELS, "eleven_flash_v2_5", "ELEVENLABS_TTS_MODELS"),
      listed(ELEVENLABS_STT_MODELS, "scribe_v1", "ELEVENLABS_STT_MODELS"),
    ],
  },
  {
    group: "fish",
    name: "Fish Audio",
    slug: "fish",
    models: [DEFAULT_FISH_TTS_MODEL, listed(FISH_TTS_MODELS, "s2.1-pro", "FISH_TTS_MODELS")],
  },
  {
    group: "fal",
    name: "fal.ai",
    slug: "fal",
    models: [
      listed(falRegistry, "elevenlabs/tts/eleven-v4", "the verified model registry"),
      listed(falRegistry, "google/gemini-3.8-flash-tts", "the verified model registry"),
      listed(falRegistry, "fal-ai/minimax/speech-2.8-hd", "the verified model registry"),
    ],
  },
  {
    group: "atlas",
    name: "Atlas Cloud",
    slug: "atlascloud",
    models: [
      ATLAS_DEFAULT_MODELS.image,
      ATLAS_DEFAULT_MODELS.video,
      ATLAS_DEFAULT_MODELS.tts,
      ATLAS_DEFAULT_MODELS.textTo3d,
    ],
  },
  {
    group: "replicate",
    name: "Replicate",
    slug: "replicate",
    models: [DEFAULT_REPLICATE_IMAGE_MODEL, DEFAULT_REPLICATE_VIDEO_MODEL],
  },
  {
    group: "runway",
    name: "Runway",
    slug: "runway",
    models: [
      DEFAULT_RUNWAY_VIDEO_MODEL,
      listed(Object.keys(RUNWAY_VIDEO_MODELS), "gen4_turbo", "Runway VIDEO_MODELS"),
      DEFAULT_RUNWAY_IMAGE_MODEL,
    ],
  },
  {
    group: "heygen",
    name: "HeyGen",
    slug: "heygen",
    models: [HEYGEN_VIDEO_MODEL, listed(AVATAR_ENGINES, "avatar_iv", "AVATAR_ENGINES")],
  },
];

export interface LandingProvider {
  group: string;
  name: string;
  /** Docs path, before the locale prefix. */
  href: string;
  modalities: ProviderModality[];
  models: readonly string[];
}

function buildProviders(): LandingProvider[] {
  const modalities = new Map(SOURCES.map((s) => [s.group, new Set<ProviderModality>()]));
  for (const [command, cap] of Object.entries(COMMAND_CAPABILITIES)) {
    const group = command.split(" ")[0] ?? "";
    const owner = group in NON_PROVIDER_GROUPS ? NON_PROVIDER_GROUPS[group] : group;
    if (owner === null) continue;
    const set = modalities.get(owner);
    if (!set) {
      throw new Error(`landing providers: command group "${group}" has no entry; add it`);
    }
    // A catalog command passes any model id the provider serves through.
    if (cap.models === "provider-catalog") set.add("catalog");
    for (const task of cap.tasks) if (task !== "any") set.add(TASK_MODALITY[task]);
  }

  const keyNames = new Set(PROVIDER_KEYS.map((p) => p.name));
  return SOURCES.map((source) => {
    if (source.group !== "cloudflare" && !keyNames.has(source.name)) {
      throw new Error(`landing providers: "${source.name}" is not a name in PROVIDER_KEYS`);
    }
    if (source.models.length < 2 || source.models.length > 4) {
      throw new Error(`landing providers: ${source.name} needs 2-4 popular models`);
    }
    const set = modalities.get(source.group) ?? new Set();
    if (set.size === 0) throw new Error(`landing providers: ${source.name} has no commands`);
    return {
      group: source.group,
      name: source.name,
      href: `/commands/${source.slug}/`,
      modalities: PROVIDER_MODALITIES.filter((m) => set.has(m)),
      models: source.models,
    };
  });
}

export const landingProviders: readonly LandingProvider[] = buildProviders();
