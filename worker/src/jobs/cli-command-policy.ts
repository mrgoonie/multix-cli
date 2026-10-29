/**
 * Hand-maintained overlay on the generated CLI catalog: what the remote runner
 * may execute and how each option is treated. The catalog says what the CLI
 * accepts; this file says what a remote caller may send.
 *
 * - File inputs never take a caller-written path. The caller passes https
 *   URLs in `inputs`; the container downloads them and the server writes the
 *   local paths into argv.
 * - Output locations belong to the server: files land in the job's output
 *   directory (MULTIX_OUTPUT_DIR) and are uploaded from there.
 * - Caps reuse the operator limits of the Worker tools (MULTIX_MCP_*).
 *   A run the caps cannot bound is marked (`uncappedSpend`, `uncappedOptions`,
 *   `countFromModel`) and goes through MULTIX_MCP_UNCAPPED_SPEND instead.
 *
 * Option names are long flags without the leading `--`.
 */

import type { ProviderSecretName } from "../provider-secret-names.js";

/** `file`: one or more downloaded files (repeatable when the CLI option is). `dir`: a directory of them. */
export type FileInputKind = "file" | "dir";

export interface CapRules {
  /** Video length in seconds: at most `maxVideoSeconds`. */
  duration?: string[];
  /** Number of outputs: at most `maxOutputs`. */
  count?: string[];
  /**
   * The CLI sends no count when the option is omitted, so the model's own
   * default (which can be above 1) applies: such a run is uncapped.
   */
  countFromModel?: boolean;
  /** Video resolution: must normalise to one of `allowedResolutions`. */
  resolution?: string[];
  /**
   * When the resolution is omitted and the CLI has no default (the provider
   * picks one, or an edit keeps the source's), send an allowed one instead.
   */
  fillResolution?: boolean;
}

export interface CommandPolicy {
  /** Options whose values are files supplied through `inputs`. */
  fileOptions?: Record<string, FileInputKind>;
  /** Positionals whose values are files supplied through `inputs`. */
  filePositionals?: string[];
  /** File options that also accept a provider asset reference (`asset:<id>`) as a plain value. */
  assetRefOptions?: string[];
  /** Options whose plain value must be a public https URL. */
  urlOptions?: string[];
  /** Options the server always sets; the caller may only repeat the same value. */
  forced?: Record<string, string>;
  /** Options a remote caller may not use. */
  unsupported?: string[];
  /**
   * Options whose value the CLI puts into an output file name (a prefix, a
   * language code): letters, digits, `_` and `-` only, so it cannot add a path.
   */
  nameOptions?: string[];
  /** Options the CLI collects when repeated but the catalog cannot tell (custom parser, no array default). */
  repeatable?: string[];
  caps?: CapRules;
  /**
   * Why the caps cannot bound this command's spend (a pass-through request
   * body, a price set by the length of the source media). Every run of it is
   * subject to MULTIX_MCP_UNCAPPED_SPEND.
   */
  uncappedSpend?: string;
  /** Options that make a run uncapped when given (a JSON body merged into the request). */
  uncappedOptions?: string[];
  /**
   * Options that set an image's size, quality, resolution tier or upscale
   * factor. They change the price per image and no operator cap bounds them,
   * so a run that sets one is uncapped; omitting it keeps the model default.
   */
  imageSizeOptions?: string[];
  /**
   * The job gets the keys of the provider groups these options name (the part
   * of each value before the first `:`) instead of the command group's keys.
   * The first option is required; an empty list gives the job no keys.
   */
  keyOptions?: { options: readonly string[]; groups: readonly string[] };
}

/** Commands that act on the local machine or need an interactive login. */
export const EXCLUDED_COMMANDS: ReadonlySet<string> = new Set([
  "check",
  "update",
  // Agent tooling that reads the local run ledger or key setup; remote callers use multix_catalog.
  "models",
  "guide",
  "history list",
  "history show",
  "history stats",
  "rerun",
  // The catalogue reads local usage and reviews; remote callers use multix_model_catalog.
  "catalog providers",
  "catalog models",
  "catalog show",
  "catalog compare",
  "catalog usage",
  "catalog recommend",
  "catalog rate",
  "catalog review",
  "catalog reviews list",
  "catalog reviews rm",
  "catalog note add",
  "catalog note list",
  "catalog note edit",
  "catalog note rm",
  // Scene projects live in a local directory across runs; a job container is discarded after each run.
  "scene voice add",
  "scene voice list",
  "scene voice validate",
  "scene plan",
  "scene render",
  "scene approve",
  "scene reject",
  "scene status",
  "scene export",
]);

/** Options no remote command may use: stdin is not available in the container. */
export const GLOBALLY_UNSUPPORTED_OPTIONS: ReadonlySet<string> = new Set(["stdin-ext"]);

/** `--output <path>`: the caller may give a bare file name; it is placed in the job's output directory. */
export const OUTPUT_FILE_OPTION = "output";
/** `--output-dir <dir>`: always the job's output directory. */
export const OUTPUT_DIR_OPTION = "output-dir";

const VIDEO_CAPS: CapRules = { duration: ["duration"], resolution: ["resolution"] };
const OMNI_VIDEO_CAPS: CapRules = { ...VIDEO_CAPS, fillResolution: true };
/** Veo leaves the Gemini API on 2026-10-22 and rejects --duration, which the caps always send. */
const OMNI_MODEL = { model: "gemini-omni-1.1-flash" };
const IMAGE_COUNT: CapRules = { count: ["num-images"] };
const MODEL_IMAGE_COUNT: CapRules = { ...IMAGE_COUNT, countFromModel: true };
const PASS_THROUGH = "the request body is passed to the provider as given";
const SOURCE_LENGTH = "billed by the length of the source media";
const EXTRA_INPUT = ["input"];
/** The video resolution allowlist does not fit image sizes or tiers (1K…4K, WxH). */
const OPENAI_IMAGE_SIZE = ["size", "quality"];
const ATLAS_IMAGE_SIZE = ["size", "resolution"];
const PIXEL_SIZE = ["width", "height"];
const SPEECH_KEY_GROUPS = [
  "gemini",
  "openai",
  "elevenlabs",
  "minimax",
  "atlas",
  "fish",
  "openrouter",
  "fal",
];

export const COMMAND_POLICIES: Readonly<Record<string, CommandPolicy>> = {
  "gemini analyze": { fileOptions: { files: "file" } },
  "gemini transcribe": { fileOptions: { files: "file" } },
  "gemini extract": { fileOptions: { files: "file" } },
  "gemini generate": { caps: IMAGE_COUNT, imageSizeOptions: ["size"] },
  "gemini image-to-image": { fileOptions: { ref: "file" } },
  // Gemini Omni video only (Veo is forced out): when --duration or --resolution
  // is omitted an allowed server value is sent, so the operator caps hold.
  // --no-wait and `video-status`/`video-cancel` run as-is, like runway/replicate.
  "gemini generate-video": {
    forced: OMNI_MODEL,
    fileOptions: { "reference-images": "file" },
    caps: OMNI_VIDEO_CAPS,
  },
  "gemini image-to-video": {
    forced: OMNI_MODEL,
    filePositionals: ["imagePath"],
    fileOptions: { "last-frame": "file" },
    caps: OMNI_VIDEO_CAPS,
  },
  // The source video comes from `inputs` (or --interaction-id of a stored video).
  // An edit has no --duration: its length is the source's (Google limits an
  // uploaded clip to 10 s). An extend is billed for the new continuation only,
  // which --duration caps; the returned video also contains the source.
  // MULTIX_MCP_MAX_VIDEO_SECONDS therefore bounds each call, not a chain:
  // extending a stored interaction again grows the clip past the cap, and an
  // edit of that interaction keeps its full length. The runner cannot see a
  // stored interaction's length (Google stops a chain at 40 s), and every call
  // runs on the caller's own key.
  "gemini edit-video": {
    forced: OMNI_MODEL,
    fileOptions: { video: "file", "reference-images": "file" },
    caps: { resolution: ["resolution"], fillResolution: true },
  },
  "gemini extend-video": {
    forced: OMNI_MODEL,
    fileOptions: { video: "file", "reference-images": "file" },
    caps: OMNI_VIDEO_CAPS,
  },
  "minimax generate": { caps: IMAGE_COUNT },
  "minimax image-to-image": { fileOptions: { ref: "file" }, caps: IMAGE_COUNT },
  "minimax generate-video": { urlOptions: ["first-frame"], caps: VIDEO_CAPS },
  // The Codex drivers need a local ChatGPT login; only the API driver runs remotely.
  "openai generate": {
    forced: { driver: "api" },
    caps: IMAGE_COUNT,
    imageSizeOptions: OPENAI_IMAGE_SIZE,
  },
  "openai image-to-image": {
    forced: { driver: "api" },
    fileOptions: { ref: "file" },
    imageSizeOptions: OPENAI_IMAGE_SIZE,
  },
  "openai transcribe": {
    fileOptions: { input: "file", "known-speaker-reference": "file" },
  },
  "openrouter generate": { caps: IMAGE_COUNT, imageSizeOptions: ["image-size"] },
  "openrouter image-to-image": { fileOptions: { ref: "file" } },
  "openrouter image-to-video": {
    urlOptions: ["image-url", "last-frame-url"],
    caps: VIDEO_CAPS,
  },
  "openrouter tts": { fileOptions: { "text-file": "file", "turns-file": "file" } },
  "openrouter transcribe": { fileOptions: { input: "file" } },
  "fish tts": {
    fileOptions: { "text-file": "file", "turns-file": "file", "dictionary-file": "file" },
    repeatable: ["voice", "dictionary"],
  },
  "fish voice-design": { caps: { count: ["count"] } },
  "fish clone": { fileOptions: { sample: "file", "transcript-file": "file" } },
  "leonardo generate": { caps: { count: ["num"] }, imageSizeOptions: PIXEL_SIZE },
  "leonardo image-to-image": { caps: { count: ["num"] }, imageSizeOptions: PIXEL_SIZE },
  "leonardo upscale": { imageSizeOptions: ["multiplier"] },
  "leonardo video": { caps: { resolution: ["resolution"] } },
  "leonardo image-to-video": { caps: VIDEO_CAPS },
  "byteplus generate": {
    fileOptions: { "input-image": "file" },
    caps: IMAGE_COUNT,
    imageSizeOptions: ["size"],
  },
  "byteplus image-to-image": {
    fileOptions: { ref: "file" },
    caps: IMAGE_COUNT,
    imageSizeOptions: ["size"],
  },
  "byteplus video": { caps: VIDEO_CAPS },
  "byteplus image-to-video": {
    filePositionals: ["image"],
    fileOptions: { "last-frame": "file" },
    caps: VIDEO_CAPS,
  },
  "byteplus reference-to-video": {
    fileOptions: { "ref-image": "file", "ref-video": "file", "ref-audio": "file" },
    caps: VIDEO_CAPS,
  },
  "byteplus generate-3d": { fileOptions: { "input-image": "file" } },
  "cloudflare generate-video": { caps: VIDEO_CAPS },
  "elevenlabs clone": { fileOptions: { files: "file", audio: "file" } },
  "elevenlabs voice-changer": { fileOptions: { input: "file" } },
  "elevenlabs transcribe": { fileOptions: { input: "file" } },
  "elevenlabs music": { fileOptions: { plan: "file" } },
  "elevenlabs dub": {
    uncappedSpend: SOURCE_LENGTH,
    fileOptions: { input: "file" },
    urlOptions: ["source-url"],
    nameOptions: ["target-lang"],
  },
  "elevenlabs dub-status": { nameOptions: ["download"] },
  "elevenlabs voices design": { nameOptions: ["output-prefix"] },
  "elevenlabs isolate": { fileOptions: { input: "file" } },
  "elevenlabs align": { fileOptions: { input: "file", "text-file": "file" } },
  // `--file key=path` maps a model field to a local file and `--receipt` takes
  // a local path; neither is expressible remotely (pass URLs in --input).
  "fal run": { unsupported: ["file", "receipt"], uncappedSpend: PASS_THROUGH },
  "fal upload": { filePositionals: ["file"] },
  "fal image": { caps: IMAGE_COUNT, imageSizeOptions: ["image-size"] },
  "fal video": { urlOptions: ["image-url"], caps: { duration: ["duration"] } },
  // The text file comes from `inputs`; `--receipt` takes a local path (the
  // detached receipt is still printed, and `fal status` / `fal result` resume it).
  // An unlisted model needs --text-field, and then any fal model runs with the
  // --input body as given.
  "fal tts": {
    fileOptions: { "text-file": "file" },
    unsupported: ["receipt"],
    uncappedOptions: ["input", "text-field"],
  },
  // An omitted --num-images leaves the count to the model's schema default.
  "atlas image": { caps: MODEL_IMAGE_COUNT, imageSizeOptions: ATLAS_IMAGE_SIZE },
  "atlas image-to-image": {
    fileOptions: { ref: "file" },
    caps: MODEL_IMAGE_COUNT,
    imageSizeOptions: ATLAS_IMAGE_SIZE,
  },
  "atlas video": { caps: VIDEO_CAPS },
  "atlas image-to-video": { fileOptions: { ref: "file" }, caps: VIDEO_CAPS },
  "atlas audio": { fileOptions: { audio: "file" } },
  "atlas 3d": { fileOptions: { ref: "file" } },
  "atlas upload": { filePositionals: ["file"] },
  "atlas run": { uncappedSpend: PASS_THROUGH },
  // `--file key=path` maps a model field to a local file; not expressible remotely.
  "replicate run": { unsupported: ["file"], uncappedSpend: PASS_THROUGH },
  // --input merges any model field (num_outputs, num_frames, …) under the flags.
  "replicate image": {
    caps: { count: ["num-outputs"], countFromModel: true },
    uncappedOptions: EXTRA_INPUT,
  },
  "replicate video": {
    fileOptions: { image: "file" },
    caps: VIDEO_CAPS,
    uncappedOptions: EXTRA_INPUT,
  },
  // --ratio is checked against each model's fixed list by the CLI (at most 1920x1080).
  "runway video": { fileOptions: { image: "file" }, caps: { duration: ["duration"] } },
  "runway image": {
    fileOptions: { reference: "file" },
    repeatable: ["reference", "reference-tag"],
  },
  "heygen video-agent": {
    uncappedSpend: "the agent decides the video length",
    fileOptions: { file: "file" },
    assetRefOptions: ["file"],
    repeatable: ["file"],
    urlOptions: ["callback-url"],
  },
  "heygen video": {
    uncappedSpend: "billed by the length of the script or audio",
    fileOptions: { audio: "file", "background-image": "file" },
    assetRefOptions: ["audio", "background-image"],
    urlOptions: ["callback-url"],
    caps: { resolution: ["resolution"] },
  },
  "heygen translate": {
    uncappedSpend: SOURCE_LENGTH,
    filePositionals: ["source"],
    fileOptions: { audio: "file" },
    assetRefOptions: ["source", "audio"],
    urlOptions: ["callback-url"],
  },
  "heygen lipsync": {
    uncappedSpend: SOURCE_LENGTH,
    fileOptions: { video: "file", audio: "file" },
    assetRefOptions: ["video", "audio"],
    urlOptions: ["callback-url"],
  },
  "heygen model-video": {
    fileOptions: {
      image: "file",
      "reference-image": "file",
      "reference-video": "file",
      "reference-audio": "file",
    },
    assetRefOptions: ["image", "reference-image", "reference-video", "reference-audio"],
    repeatable: ["reference-image", "reference-video", "reference-audio"],
    urlOptions: ["callback-url"],
    caps: VIDEO_CAPS,
  },
  "heygen template": { uncappedSpend: "the template decides the video length" },
  "heygen run": { uncappedSpend: PASS_THROUGH },
  "media optimize": { fileOptions: { input: "file" } },
  "media split": { fileOptions: { input: "file" } },
  "media batch": { fileOptions: { "input-dir": "dir" } },
  "media inspect": { filePositionals: ["file"] },
  // Custom rules run local code and the cache and receipt paths are local state: not remote.
  "media verify": {
    filePositionals: ["file"],
    fileOptions: { "profile-file": "file" },
    unsupported: ["rule", "cache-dir", "receipt-out"],
    repeatable: ["allow-black", "allow-freeze", "allow-silence"],
  },
  "media frames": { filePositionals: ["file"] },
  "media check-receipt": { filePositionals: ["receipt", "file"] },
  "doc convert": { fileOptions: { input: "file" } },
  // One façade over several providers: only the routed providers' keys reach the job.
  "speech generate": {
    fileOptions: { "text-file": "file" },
    repeatable: ["extra"],
    keyOptions: { options: ["provider", "fallback"], groups: SPEECH_KEY_GROUPS },
  },
  // Readiness would describe the container, not the caller's saved keys (multix_catalog does).
  "speech models": { unsupported: ["ready"], keyOptions: { options: [], groups: [] } },
};

/**
 * Key env names each command group reads. Only these of the caller's keys are
 * handed to the job; groups not listed (media) get none.
 */
export const GROUP_KEYS: Readonly<Record<string, readonly ProviderSecretName[]>> = {
  gemini: ["GEMINI_API_KEY"],
  doc: ["GEMINI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  leonardo: ["LEONARDO_API_KEY"],
  byteplus: ["BYTEPLUS_API_KEY", "ARK_API_KEY"],
  cloudflare: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_AI_GATEWAY_ID"],
  elevenlabs: ["ELEVENLABS_API_KEY"],
  fal: ["FAL_KEY"],
  atlas: ["ATLASCLOUD_API_KEY"],
  fish: ["FISH_API_KEY"],
  replicate: ["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"],
  runway: ["RUNWAYML_API_SECRET"],
  heygen: ["HEYGEN_API_KEY"],
  // Readiness only: a speech job gets the keys of the providers it routes to (keyOptions).
  speech: [
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ELEVENLABS_API_KEY",
    "MINIMAX_API_KEY",
    "ATLASCLOUD_API_KEY",
    "FISH_API_KEY",
    "OPENROUTER_API_KEY",
    "FAL_KEY",
  ],
};

/** Names that must all be set for a group to be usable (the rest are fallbacks or optional). */
export const GROUP_REQUIRED_KEYS: Readonly<
  Record<string, readonly (readonly ProviderSecretName[])[]>
> = {
  // Any one of a row satisfies it.
  byteplus: [["BYTEPLUS_API_KEY", "ARK_API_KEY"]],
  replicate: [["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"]],
  cloudflare: [["CLOUDFLARE_ACCOUNT_ID"], ["CLOUDFLARE_API_TOKEN"]],
  speech: [
    [
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "ELEVENLABS_API_KEY",
      "MINIMAX_API_KEY",
      "ATLASCLOUD_API_KEY",
      "FISH_API_KEY",
      "OPENROUTER_API_KEY",
      "FAL_KEY",
    ],
  ],
};

export function policyFor(command: string): CommandPolicy {
  return COMMAND_POLICIES[command] ?? {};
}
