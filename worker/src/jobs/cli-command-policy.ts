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
 *   `priceOptions`, `countFromModel`, `resolutionFromModel`) and goes through
 *   MULTIX_MCP_UNCAPPED_SPEND instead.
 *
 * Option names are long flags without the leading `--`.
 */

import { BYTEPLUS_3D_MODELS } from "../../../src/providers/byteplus/models.js";
import type { ProviderSecretName } from "../provider-secret-names.js";

/** `file`: one or more downloaded files (repeatable when the CLI option is). `dir`: a directory of them. */
export type FileInputKind = "file" | "dir";

export interface CapRules {
  /** Video length in seconds: at most `maxVideoSeconds`. */
  duration?: string[];
  /**
   * The command has no length option and always renders up to this many
   * seconds: refused when it is above `maxVideoSeconds`.
   */
  fixedSeconds?: number;
  /** Generated audio length: at most `maxAudioSeconds`. */
  audioLength?: AudioLengthRule[];
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
  /**
   * When the resolution is omitted the model's own default applies, which
   * can be above `allowedResolutions`: such a run is uncapped.
   */
  resolutionFromModel?: boolean;
}

export interface AudioLengthRule {
  option: string;
  /** Option units in one second: 1 for seconds, 1000 for milliseconds. */
  unitsPerSecond: number;
  /**
   * Longest length the provider produces when the option is omitted; above
   * the cap, the server sends the cap instead.
   */
  omittedSeconds: number;
  /** Options with which the provider rejects this one: no value is filled when one is given. */
  notWith?: string[];
  /** Smallest value below 1 the CLI keeps (it parses the option with parseFloat). */
  min?: number;
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
  /**
   * Options the CLI writes into the prompt text, where the provider reads
   * `--name value` tokens as model parameters (BytePlus Seedance's default
   * encoding). A value with such a token is refused, so it cannot override a
   * capped duration or resolution.
   */
  promptFlagOptions?: string[];
  /** Options whose value must be one of the listed ones (e.g. models the caps were written for). */
  allowedValues?: Record<string, readonly string[]>;
  /** Options the CLI collects when repeated but the catalog cannot tell (custom parser, no array default). */
  repeatable?: string[];
  caps?: CapRules;
  /**
   * Why the caps cannot bound this command's spend (a pass-through request
   * body, a price set by the length of the source media). Every run of it is
   * subject to MULTIX_MCP_UNCAPPED_SPEND.
   */
  uncappedSpend?: string;
  /** Options that make a run uncapped when given (a raw request body or raw model flags). */
  uncappedOptions?: string[];
  /**
   * Options that set the price of each output (image size, quality or
   * resolution tier, upscale factor, a dearer mode flag), which no operator
   * cap bounds. A value other than the catalog default makes the run
   * uncapped; omitting the option leaves the CLI or model default, which
   * stays allowed.
   */
  priceOptions?: string[];
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
  // A live WebSocket session steered while it plays; it does not fit one remote request.
  "gemini music-live",
]);

/** Options no remote command may use: stdin is not available in the container. */
export const GLOBALLY_UNSUPPORTED_OPTIONS: ReadonlySet<string> = new Set(["stdin-ext"]);

/** `--output <path>`: the caller may give a bare file name; it is placed in the job's output directory. */
export const OUTPUT_FILE_OPTION = "output";
/** `--output-dir <dir>`: always the job's output directory. */
export const OUTPUT_DIR_OPTION = "output-dir";

const VIDEO_CAPS: CapRules = { duration: ["duration"], resolution: ["resolution"] };
/** Seedance puts these into the prompt text with `--rs`, `--dur`, `--rt` … appended. */
const SEEDANCE_PROMPT_FLAGS = ["prompt", "negative", "aspect-ratio"];
const OMNI_VIDEO_CAPS: CapRules = { ...VIDEO_CAPS, fillResolution: true };
/** The resolution values are model-dependent, so none can be filled in: an omitted one is uncapped. */
const MODEL_VIDEO_CAPS: CapRules = { ...VIDEO_CAPS, resolutionFromModel: true };
/** Veo leaves the Gemini API on 2026-10-22 and rejects --duration, which the caps always send. */
const OMNI_MODEL = { model: "gemini-omni-1.1-flash" };
const IMAGE_COUNT: CapRules = { count: ["num-images"] };
const IMAGE_SIZE = ["size"];
const OPENAI_IMAGE_PRICE = ["size", "quality"];
const ATLAS_IMAGE_PRICE = ["size", "resolution"];
const LEONARDO_IMAGE_SIZE = ["width", "height"];
const MODEL_IMAGE_COUNT: CapRules = { ...IMAGE_COUNT, countFromModel: true };
const PASS_THROUGH = "the request body is passed to the provider as given";
const SOURCE_LENGTH = "billed by the length of the source media";
const SCRIPT_LENGTH = "billed by the length of the script or audio";
/** m2v's --video-length-type picks a 15-60 s range, past what the duration cap can bound. */
const M2V_LENGTH = "the video runs 15-60 s (--video-length-type), longer than the duration cap";
const EXTRA_INPUT = ["input"];
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
  "gemini generate": { caps: IMAGE_COUNT, priceOptions: IMAGE_SIZE },
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
  // One flat charge per song. The default lyria-3-clip-preview always returns
  // 30 s; lyria-3.5 runs a couple of minutes (set by the prompt, which no cap
  // can bound), so choosing a model makes the run uncapped. --interaction-id
  // re-reads a stored song without a new charge.
  "gemini generate-music": {
    fileOptions: { image: "file", "lyrics-file": "file" },
    uncappedOptions: ["model"],
  },
  "minimax generate": { caps: IMAGE_COUNT },
  "minimax image-to-image": { fileOptions: { ref: "file" }, caps: IMAGE_COUNT },
  "minimax generate-video": { urlOptions: ["first-frame"], caps: VIDEO_CAPS },
  // The Codex drivers need a local ChatGPT login; only the API driver runs remotely.
  "openai generate": {
    forced: { driver: "api" },
    caps: IMAGE_COUNT,
    priceOptions: OPENAI_IMAGE_PRICE,
  },
  "openai image-to-image": {
    forced: { driver: "api" },
    fileOptions: { ref: "file" },
    priceOptions: OPENAI_IMAGE_PRICE,
  },
  "openai transcribe": {
    fileOptions: { input: "file", "known-speaker-reference": "file" },
  },
  "openrouter generate": { caps: IMAGE_COUNT, priceOptions: ["image-size"] },
  "openrouter image-to-image": { fileOptions: { ref: "file" } },
  "openrouter image-to-video": {
    urlOptions: ["image-url", "last-frame-url"],
    caps: MODEL_VIDEO_CAPS,
  },
  // --provider-options merges any provider field into the request.
  "openrouter tts": {
    fileOptions: { "text-file": "file", "turns-file": "file" },
    uncappedOptions: ["provider-options"],
  },
  "openrouter transcribe": { fileOptions: { input: "file" } },
  "fish tts": {
    fileOptions: { "text-file": "file", "turns-file": "file", "dictionary-file": "file" },
    repeatable: ["voice", "dictionary"],
  },
  "fish voice-design": { caps: { count: ["count"] } },
  "fish clone": { fileOptions: { sample: "file", "transcript-file": "file" } },
  "leonardo generate": {
    caps: { count: ["num"] },
    // --quality defaults to HIGH, the dearest tier, so it is not listed.
    priceOptions: [...LEONARDO_IMAGE_SIZE, "alchemy", "ultra"],
  },
  "leonardo image-to-image": { caps: { count: ["num"] }, priceOptions: LEONARDO_IMAGE_SIZE },
  "leonardo upscale": { priceOptions: ["multiplier"] },
  // No --duration: a v2 model gets duration: 8 and a v1 model picks its own length
  // (Leonardo documents Kling 2.1 and 2.5 at 5 or 10 s), so a run can reach 10 s.
  "leonardo video": { caps: { resolution: ["resolution"], fixedSeconds: 10 } },
  "leonardo image-to-video": { caps: VIDEO_CAPS },
  "byteplus generate": {
    fileOptions: { "input-image": "file" },
    caps: IMAGE_COUNT,
    priceOptions: IMAGE_SIZE,
  },
  "byteplus image-to-image": {
    fileOptions: { ref: "file" },
    caps: IMAGE_COUNT,
    priceOptions: IMAGE_SIZE,
  },
  "byteplus video": { caps: VIDEO_CAPS, promptFlagOptions: SEEDANCE_PROMPT_FLAGS },
  "byteplus image-to-video": {
    filePositionals: ["image"],
    fileOptions: { "last-frame": "file" },
    caps: VIDEO_CAPS,
    promptFlagOptions: SEEDANCE_PROMPT_FLAGS,
  },
  "byteplus reference-to-video": {
    fileOptions: { "ref-image": "file", "ref-video": "file", "ref-audio": "file" },
    caps: VIDEO_CAPS,
    promptFlagOptions: SEEDANCE_PROMPT_FLAGS,
  },
  "byteplus generate-3d": {
    fileOptions: { "input-image": "file" },
    // The 3D models only: the same tasks endpoint runs Seedance, and --flags
    // goes into the prompt raw, so any other model could make an uncapped video.
    allowedValues: { model: BYTEPLUS_3D_MODELS.map((m) => m.id) },
    // --flags appends raw model flags (`--resolution 1536pro`, `--hd_texture true`) to the prompt.
    uncappedOptions: ["flags"],
  },
  "cloudflare generate-video": { caps: VIDEO_CAPS },
  "elevenlabs clone": { fileOptions: { files: "file", audio: "file" } },
  "elevenlabs voice-changer": { fileOptions: { input: "file" } },
  "elevenlabs transcribe": { fileOptions: { input: "file" } },
  // Billed by length: --music-length-ms sets it (the model picks up to 10 min
  // when omitted, so the cap is sent), or a --plan's section durations, which
  // the caps cannot see and with which the API rejects a length.
  "elevenlabs music": {
    fileOptions: { plan: "file" },
    uncappedOptions: ["plan"],
    caps: {
      audioLength: [
        { option: "music-length-ms", unitsPerSecond: 1000, omittedSeconds: 600, notWith: ["plan"] },
      ],
    },
  },
  // An omitted --duration-seconds lets the model pick, up to ElevenLabs' 30 s.
  "elevenlabs sfx": {
    caps: {
      audioLength: [
        { option: "duration-seconds", unitsPerSecond: 1, omittedSeconds: 30, min: 0.5 },
      ],
    },
  },
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
  "fal image": { caps: IMAGE_COUNT, priceOptions: ["image-size"] },
  "fal video": {
    uncappedSpend: "the model picks the resolution (fal video has no --resolution)",
    urlOptions: ["image-url"],
    caps: { duration: ["duration"] },
  },
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
  "atlas image": { caps: MODEL_IMAGE_COUNT, priceOptions: ATLAS_IMAGE_PRICE },
  "atlas image-to-image": {
    fileOptions: { ref: "file" },
    caps: MODEL_IMAGE_COUNT,
    priceOptions: ATLAS_IMAGE_PRICE,
  },
  "atlas video": { caps: MODEL_VIDEO_CAPS },
  "atlas image-to-video": { fileOptions: { ref: "file" }, caps: MODEL_VIDEO_CAPS },
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
    caps: MODEL_VIDEO_CAPS,
    uncappedOptions: EXTRA_INPUT,
  },
  // --ratio is checked against each model's fixed list by the CLI (at most 1920x1080).
  "runway video": { fileOptions: { image: "file" }, caps: { duration: ["duration"] } },
  "runway image": {
    fileOptions: { reference: "file" },
    repeatable: ["reference", "reference-tag"],
    // 1080p-tier ratios cost more than the 1280:720 default.
    priceOptions: ["ratio"],
  },
  "heygen video-agent": {
    uncappedSpend: "the agent decides the video length",
    fileOptions: { file: "file" },
    assetRefOptions: ["file"],
    repeatable: ["file"],
    urlOptions: ["callback-url"],
  },
  "heygen video": {
    uncappedSpend: SCRIPT_LENGTH,
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
    caps: MODEL_VIDEO_CAPS,
  },
  "heygen template": { uncappedSpend: "the template decides the video length" },
  "heygen run": { uncappedSpend: PASS_THROUGH },
  // An omitted --num-images leaves the count to the model's catalog default;
  // --param sets any other request field the model's catalog row lists.
  "sume image": {
    fileOptions: { image: "file" },
    repeatable: ["image", "param"],
    caps: { count: ["num-images"], countFromModel: true },
    uncappedOptions: ["param"],
  },
  "sume video": {
    fileOptions: {
      image: "file",
      "end-image": "file",
      "reference-image": "file",
      video: "file",
      audio: "file",
    },
    repeatable: ["image", "reference-image", "param"],
    // No duration cap: a filled --duration is refused by models without one and
    // means the audio length on lip-sync models.
    uncappedSpend:
      "the model's catalog row sets the price; lip-sync and captions bill by the length of the source media",
    caps: { resolution: ["resolution"] },
  },
  // A quote takes only public URLs: nothing is uploaded or billed.
  "sume estimate": {
    urlOptions: ["image", "end-image", "reference-image", "video", "audio"],
    repeatable: ["image", "reference-image", "param"],
  },
  // The product page URL is sent as given; the CLI accepts only http(s).
  "topview url-to-video": {
    uncappedSpend: M2V_LENGTH,
    fileOptions: { logo: "file", music: "file" },
  },
  "topview materials-to-video": {
    uncappedSpend: M2V_LENGTH,
    fileOptions: { file: "file", logo: "file", music: "file" },
    repeatable: ["file"],
  },
  "topview video-avatar": {
    uncappedSpend: SCRIPT_LENGTH,
    fileOptions: { video: "file", image: "file", audio: "file" },
  },
  "topview product-avatar": {
    uncappedSpend: SCRIPT_LENGTH,
    fileOptions: { "product-image": "file", "template-image": "file", audio: "file" },
  },
  "topview product-anyshoot": {
    fileOptions: {
      "product-image": "file",
      "product-mask": "file",
      "template-image": "file",
      "template-mask": "file",
    },
    // try-on bills each generated image (--count 1-4).
    caps: { count: ["count"] },
  },
  "topview upload": { filePositionals: ["file"] },
  "topview run": { uncappedSpend: PASS_THROUGH },
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
  sume: ["SUME_API_KEY"],
  topview: ["TOPVIEW_API_KEY", "TOPVIEW_UID", "TOPVIEW_PLATFORM_API_KEY"],
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
  // Legacy commands need TOPVIEW_API_KEY and TOPVIEW_UID; platform commands need the platform key.
  topview: [["TOPVIEW_API_KEY", "TOPVIEW_PLATFORM_API_KEY"]],
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
