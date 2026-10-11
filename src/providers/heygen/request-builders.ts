/**
 * Pure request builders + validation for HeyGen v3 create endpoints. Shared by
 * the CLI and future non-Node callers (no node:* imports). Validation mirrors
 * the documented schema rules so obvious mistakes fail before a paid request.
 */

import { ValidationError } from "../../core/errors.js";
import {
  AGENT_ORIENTATIONS,
  AVATAR_ENGINES,
  AVATAR_VIDEO_ASPECT_RATIOS,
  AVATAR_VIDEO_RESOLUTIONS,
  EXPRESSIVENESS_LEVELS,
  HEYGEN_VIDEO_MODEL,
  LIMITS,
  MODEL_VIDEO_ASPECT_RATIOS,
  MODEL_VIDEO_MODES,
  MODEL_VIDEO_PROMPT_ENHANCEMENT,
  MODEL_VIDEO_RESOLUTIONS,
  QUALITY_MODES,
  SPEECH_ENGINES,
} from "./models.js";
import type {
  CreateAvatarVideoRequest,
  CreateModelVideoRequest,
  CreateSpeechRequest,
  CreateVideoAgentRequest,
  HeygenAssetInput,
  HeygenModelVideoMode,
} from "./types.js";

/** Validate an enum-like option; returns undefined when absent. */
export function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${flag} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value as T;
}

/** Parse a numeric option within an inclusive range. */
export function numberInRange(
  value: string | number | undefined,
  flag: string,
  min: number,
  max: number,
  integer = false,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new ValidationError(
      `${flag} must be ${integer ? "an integer" : "a number"} between ${min} and ${max} (got "${value}")`,
    );
  }
  return n;
}

function requireHttps(url: string, flag: string): string {
  if (!/^https:\/\//i.test(url)) throw new ValidationError(`${flag} must be an https:// URL`);
  return url;
}

/** Classification of a media reference given on the command line. */
export type MediaRef =
  | { kind: "url"; url: string }
  | { kind: "asset"; assetId: string }
  | { kind: "path"; path: string };

/**
 * Media reference syntax: `https://…` (public URL), `asset:<asset_id>`
 * (already uploaded), anything else is a local file path to upload.
 */
export function classifyMediaRef(value: string): MediaRef {
  const v = value.trim();
  if (!v) throw new ValidationError("Media reference must not be empty");
  if (/^https?:\/\//i.test(v)) return { kind: "url", url: requireHttps(v, "Media URL") };
  const asset = v.match(/^asset(?:_id)?:(.+)$/i);
  if (asset?.[1]) return { kind: "asset", assetId: asset[1].trim() };
  return { kind: "path", path: v };
}

/** Convert a non-path reference to the v3 AssetInput union. */
export function assetInputFromRef(ref: MediaRef): HeygenAssetInput {
  if (ref.kind === "url") return { type: "url", url: ref.url };
  if (ref.kind === "asset") return { type: "asset_id", asset_id: ref.assetId };
  throw new ValidationError(`Local file ${ref.path} must be uploaded before use`);
}

/**
 * Split `--languages` on commas that are not inside parentheses: HeyGen
 * language names can contain commas, e.g. "Chinese (Cantonese, Traditional)".
 */
export function splitLanguages(raw: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of raw) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  const langs = out.map((s) => s.trim()).filter(Boolean);
  if (langs.length === 0) throw new ValidationError("--languages must list at least one language");
  return [...new Set(langs)];
}

/** Validate an optional `--callback-url` (HeyGen requires HTTPS). */
export function checkCallback(url: string | undefined): string | undefined {
  return url === undefined ? undefined : requireHttps(url, "--callback-url");
}

// ── Video Agent ───────────────────────────────────────────────────────────

export interface VideoAgentInput {
  prompt: string;
  avatarId?: string;
  voiceId?: string;
  styleId?: string;
  brandKitId?: string;
  brandGlossaryId?: string;
  orientation?: string;
  files?: HeygenAssetInput[];
  callbackUrl?: string;
  callbackId?: string;
}

export function buildVideoAgentRequest(input: VideoAgentInput): CreateVideoAgentRequest {
  const prompt = input.prompt?.trim() ?? "";
  if (prompt.length < 1 || prompt.length > LIMITS.agentPromptMax) {
    throw new ValidationError(`Prompt must be 1-${LIMITS.agentPromptMax} characters`);
  }
  const files = input.files ?? [];
  if (files.length > LIMITS.agentFilesMax) {
    throw new ValidationError(`Video Agent accepts at most ${LIMITS.agentFilesMax} files`);
  }
  const body: CreateVideoAgentRequest = { prompt, mode: "generate" };
  if (input.avatarId) body.avatar_id = input.avatarId;
  if (input.voiceId) body.voice_id = input.voiceId;
  if (input.styleId) body.style_id = input.styleId;
  if (input.brandKitId) body.brand_kit_id = input.brandKitId;
  if (input.brandGlossaryId) body.brand_glossary_id = input.brandGlossaryId;
  const orientation = oneOf(input.orientation, AGENT_ORIENTATIONS, "--orientation");
  if (orientation) body.orientation = orientation;
  if (files.length > 0) body.files = files;
  const callbackUrl = checkCallback(input.callbackUrl);
  if (callbackUrl) body.callback_url = callbackUrl;
  if (input.callbackId) body.callback_id = input.callbackId;
  return body;
}

// ── Avatar video ──────────────────────────────────────────────────────────

export interface AvatarVideoInput {
  avatarId: string;
  script?: string;
  voiceId?: string;
  audio?: HeygenAssetInput;
  title?: string;
  folderId?: string;
  resolution?: string;
  aspectRatio?: string;
  fit?: string;
  backgroundColor?: string;
  backgroundImage?: HeygenAssetInput;
  removeBackground?: boolean;
  outputFormat?: string;
  captions?: boolean;
  burnCaptions?: boolean;
  speed?: string | number;
  pitch?: string | number;
  volume?: string | number;
  locale?: string;
  engine?: string;
  referenceLookId?: string;
  motionPrompt?: string;
  expressiveness?: string;
  brandGlossaryId?: string;
  callbackUrl?: string;
  callbackId?: string;
}

/** Build a `type: "avatar"` POST /v3/videos body, enforcing variant rules. */
export function buildAvatarVideoRequest(input: AvatarVideoInput): CreateAvatarVideoRequest {
  if (!input.avatarId?.trim()) throw new ValidationError("--avatar <look-id> is required");
  const script = input.script?.trim();
  if (script && input.audio) {
    throw new ValidationError("Provide either a script or --audio, not both");
  }
  if (!script && !input.audio) {
    throw new ValidationError("Provide a script argument or --audio <url|asset:id|file>");
  }
  if (script && script.length > LIMITS.scriptMax) {
    throw new ValidationError(`Script must be at most ${LIMITS.scriptMax} characters`);
  }

  const body: CreateAvatarVideoRequest = { type: "avatar", avatar_id: input.avatarId.trim() };
  if (script) {
    body.script = script;
    if (input.voiceId) body.voice_id = input.voiceId;
  } else if (input.audio) {
    if (input.voiceId) throw new ValidationError("--voice applies to scripts, not --audio");
    if (input.audio.type === "url") body.audio_url = input.audio.url;
    else if (input.audio.type === "asset_id") body.audio_asset_id = input.audio.asset_id;
    else throw new ValidationError("--audio must be a URL, asset id, or uploaded file");
  }

  const resolution = oneOf(input.resolution, AVATAR_VIDEO_RESOLUTIONS, "--resolution");
  if (resolution) body.resolution = resolution;
  const aspect = oneOf(input.aspectRatio, AVATAR_VIDEO_ASPECT_RATIOS, "--aspect-ratio");
  if (aspect) body.aspect_ratio = aspect;
  const fit = oneOf(input.fit, ["contain", "cover"] as const, "--fit");
  if (fit) body.fit = fit;
  const outputFormat = oneOf(input.outputFormat, ["mp4", "webm"] as const, "--output-format");
  if (outputFormat) body.output_format = outputFormat;

  if (input.backgroundColor && input.backgroundImage) {
    throw new ValidationError("Use either --background-color or --background-image, not both");
  }
  if (outputFormat === "webm" && (input.backgroundColor || input.backgroundImage)) {
    throw new ValidationError(
      "--output-format webm renders a transparent background; drop --background-*",
    );
  }
  if (input.backgroundColor) {
    if (!/^#[0-9a-f]{6}$/i.test(input.backgroundColor)) {
      throw new ValidationError("--background-color must be a hex color like #112233");
    }
    body.background = { type: "color", value: input.backgroundColor };
  } else if (input.backgroundImage) {
    const bg = input.backgroundImage;
    if (bg.type === "url") body.background = { type: "image", url: bg.url };
    else if (bg.type === "asset_id") body.background = { type: "image", asset_id: bg.asset_id };
  }
  if (input.removeBackground) body.remove_background = true;
  if (input.captions || input.burnCaptions) {
    body.caption = {
      file_format: "srt",
      ...(input.burnCaptions ? { style: "default" as const } : {}),
    };
  }

  const speed = numberInRange(input.speed, "--speed", 0.5, 1.5);
  const pitch = numberInRange(input.pitch, "--pitch", -50, 50);
  const volume = numberInRange(input.volume, "--volume", 0, 1);
  if (speed !== undefined || pitch !== undefined || volume !== undefined || input.locale) {
    if (!script) throw new ValidationError("Voice settings apply only to scripted videos");
    body.voice_settings = {
      ...(speed !== undefined ? { speed } : {}),
      ...(pitch !== undefined ? { pitch } : {}),
      ...(volume !== undefined ? { volume } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
    };
  }

  const engine = oneOf(input.engine, AVATAR_ENGINES, "--engine");
  if (input.referenceLookId && engine !== "avatar_v") {
    throw new ValidationError("--reference-look requires --engine avatar_v");
  }
  if (engine) {
    body.engine = {
      type: engine,
      ...(input.referenceLookId ? { reference_look_id: input.referenceLookId } : {}),
    };
  }
  if (input.motionPrompt) {
    if (engine === "avatar_iii") {
      throw new ValidationError("--motion-prompt is not supported with --engine avatar_iii");
    }
    body.motion_prompt = input.motionPrompt;
  }
  const expressiveness = oneOf(input.expressiveness, EXPRESSIVENESS_LEVELS, "--expressiveness");
  if (expressiveness) {
    if (engine === "avatar_v" || engine === "avatar_iii") {
      throw new ValidationError("--expressiveness is Avatar IV only (photo avatars)");
    }
    body.expressiveness = expressiveness;
  }
  if (resolution === "4k" && engine !== "avatar_iii") {
    throw new ValidationError(
      "--resolution 4k requires --engine avatar_iii (digital twins and studio avatars)",
    );
  }

  if (input.title) body.title = input.title;
  if (input.folderId) body.folder_id = input.folderId;
  if (input.brandGlossaryId) body.brand_glossary_id = input.brandGlossaryId;
  const callbackUrl = checkCallback(input.callbackUrl);
  if (callbackUrl) body.callback_url = callbackUrl;
  if (input.callbackId) body.callback_id = input.callbackId;
  return body;
}

// ── Speech ────────────────────────────────────────────────────────────────

export interface SpeechInput {
  text: string;
  voiceId: string;
  ssml?: boolean;
  speed?: string | number;
  language?: string;
  locale?: string;
  engine?: string;
}

export function buildSpeechRequest(input: SpeechInput): CreateSpeechRequest {
  const text = input.text ?? "";
  if (text.trim().length < 1 || text.length > LIMITS.speechTextMax) {
    throw new ValidationError(`Text must be 1-${LIMITS.speechTextMax} characters`);
  }
  if (!input.voiceId?.trim()) throw new ValidationError("--voice <voice-id> is required");
  const body: CreateSpeechRequest = { text, voice_id: input.voiceId.trim() };
  if (input.ssml) body.input_type = "ssml";
  const speed = numberInRange(input.speed, "--speed", 0.5, 2);
  if (speed !== undefined) body.speed = speed;
  if (input.language) body.language = input.language;
  if (input.locale) body.locale = input.locale;
  const engine = oneOf(input.engine, SPEECH_ENGINES, "--engine");
  if (engine) body.engine = engine;
  return body;
}

// ── HeyGen Video model ────────────────────────────────────────────────────

export interface ModelVideoInput {
  prompt: string;
  mode?: string;
  image?: HeygenAssetInput;
  referenceImages?: HeygenAssetInput[];
  referenceVideos?: HeygenAssetInput[];
  referenceAudio?: HeygenAssetInput[];
  duration?: string | number;
  resolution?: string;
  aspectRatio?: string;
  promptEnhancement?: string;
  seed?: string | number;
  callbackUrl?: string;
  callbackId?: string;
}

export function buildModelVideoRequest(input: ModelVideoInput): CreateModelVideoRequest {
  const prompt = input.prompt?.trim() ?? "";
  if (prompt.length < 1 || prompt.length > LIMITS.modelVideoPromptMax) {
    throw new ValidationError(`Prompt must be 1-${LIMITS.modelVideoPromptMax} characters`);
  }
  const refImages = input.referenceImages ?? [];
  const refVideos = input.referenceVideos ?? [];
  const refAudio = input.referenceAudio ?? [];
  const hasRefs = refImages.length + refVideos.length + refAudio.length > 0;

  const inferred: HeygenModelVideoMode = input.image
    ? "image_to_video"
    : hasRefs
      ? "reference_to_video"
      : "text_to_video";
  const mode = oneOf(input.mode, MODEL_VIDEO_MODES, "--mode") ?? inferred;

  if (mode === "image_to_video" && !input.image) {
    throw new ValidationError("image_to_video requires --image");
  }
  if (mode !== "image_to_video" && input.image) {
    throw new ValidationError("--image is only valid with --mode image_to_video");
  }
  if (mode === "reference_to_video" && refImages.length + refVideos.length === 0) {
    throw new ValidationError(
      "reference_to_video needs at least one --reference-image or --reference-video",
    );
  }
  if (mode !== "reference_to_video" && hasRefs) {
    throw new ValidationError("--reference-* inputs are only valid with --mode reference_to_video");
  }
  if (refImages.length > LIMITS.modelVideoReferenceImagesMax) {
    throw new ValidationError(`At most ${LIMITS.modelVideoReferenceImagesMax} reference images`);
  }
  if (refVideos.length > LIMITS.modelVideoReferenceVideosMax) {
    throw new ValidationError(`At most ${LIMITS.modelVideoReferenceVideosMax} reference videos`);
  }
  if (refAudio.length > LIMITS.modelVideoReferenceAudioMax) {
    throw new ValidationError(
      `At most ${LIMITS.modelVideoReferenceAudioMax} reference audio files`,
    );
  }

  const body: CreateModelVideoRequest = { model: HEYGEN_VIDEO_MODEL, mode, prompt };
  const duration = numberInRange(
    input.duration,
    "--duration",
    LIMITS.modelVideoMinDuration,
    LIMITS.modelVideoMaxDuration,
    true,
  );
  if (duration !== undefined) body.duration = duration;
  const resolution = oneOf(input.resolution, MODEL_VIDEO_RESOLUTIONS, "--resolution");
  if (resolution) body.resolution = resolution;
  const aspect = oneOf(input.aspectRatio, MODEL_VIDEO_ASPECT_RATIOS, "--aspect-ratio");
  if (aspect === "adaptive" && mode !== "reference_to_video") {
    throw new ValidationError("--aspect-ratio adaptive is only valid for reference_to_video");
  }
  if (aspect && mode === "image_to_video") {
    throw new ValidationError("image_to_video follows the first frame; drop --aspect-ratio");
  }
  if (aspect) body.aspect_ratio = aspect;
  const enhancement = oneOf(
    input.promptEnhancement,
    MODEL_VIDEO_PROMPT_ENHANCEMENT,
    "--prompt-enhancement",
  );
  if (enhancement) body.prompt_enhancement = enhancement;
  const seed = numberInRange(input.seed, "--seed", 0, 4_294_967_295, true);
  if (seed !== undefined) body.seed = seed;
  if (input.image) body.image = input.image;
  if (refImages.length) body.reference_images = refImages;
  if (refVideos.length) body.reference_videos = refVideos;
  if (refAudio.length) body.reference_audio = refAudio;
  const callbackUrl = checkCallback(input.callbackUrl);
  if (callbackUrl) body.callback_url = callbackUrl;
  if (input.callbackId) body.callback_id = input.callbackId;
  return body;
}

/** Validate `--mode speed|precision` for translation and lipsync. */
export function qualityMode(value: string | undefined): "speed" | "precision" | undefined {
  return oneOf(value, QUALITY_MODES, "--mode");
}
