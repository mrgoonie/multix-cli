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
  /** Video resolution: must normalise to one of `allowedResolutions`. */
  resolution?: string[];
  /**
   * Resolution the CLI uses when the caller gives none and the catalog has no
   * default (it depends on the model), checked like a caller value.
   */
  implicitResolution?: string;
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
}

/** Commands that act on the local machine or need an interactive login. */
export const EXCLUDED_COMMANDS: ReadonlySet<string> = new Set(["check", "update"]);

/** Options no remote command may use: stdin is not available in the container. */
export const GLOBALLY_UNSUPPORTED_OPTIONS: ReadonlySet<string> = new Set(["stdin-ext"]);

/** `--output <path>`: the caller may give a bare file name; it is placed in the job's output directory. */
export const OUTPUT_FILE_OPTION = "output";
/** `--output-dir <dir>`: always the job's output directory. */
export const OUTPUT_DIR_OPTION = "output-dir";

const VIDEO_CAPS: CapRules = { duration: ["duration"], resolution: ["resolution"] };
const IMAGE_COUNT: CapRules = { count: ["num-images"] };

export const COMMAND_POLICIES: Readonly<Record<string, CommandPolicy>> = {
  "gemini analyze": { fileOptions: { files: "file" } },
  "gemini transcribe": { fileOptions: { files: "file" } },
  "gemini extract": { fileOptions: { files: "file" } },
  "gemini generate": { caps: IMAGE_COUNT },
  "gemini image-to-image": { fileOptions: { ref: "file" } },
  // Omni defaults to 720p, Veo to 1080p: check the larger when none is given.
  "gemini generate-video": {
    fileOptions: { "reference-images": "file" },
    caps: { resolution: ["resolution"], implicitResolution: "1080p" },
  },
  "gemini image-to-video": {
    filePositionals: ["imagePath"],
    fileOptions: { "last-frame": "file" },
    caps: { resolution: ["resolution"], implicitResolution: "1080p" },
  },
  // Omni follow-ups: --session is the *.interaction.json written by an earlier run.
  "gemini edit-video": {
    fileOptions: { video: "file", session: "file", "reference-images": "file" },
    caps: { resolution: ["resolution"], implicitResolution: "720p" },
  },
  "gemini extend-video": {
    fileOptions: { video: "file", session: "file", "reference-images": "file" },
    caps: { resolution: ["resolution"], implicitResolution: "720p" },
  },
  "gemini video-status": { fileOptions: { session: "file" } },
  "gemini omni-video": { fileOptions: { image: "file", video: "file" } },
  "minimax generate": { caps: IMAGE_COUNT },
  "minimax image-to-image": { fileOptions: { ref: "file" }, caps: IMAGE_COUNT },
  "minimax generate-video": { urlOptions: ["first-frame"], caps: VIDEO_CAPS },
  // The Codex drivers need a local ChatGPT login; only the API driver runs remotely.
  "openai generate": { forced: { driver: "api" }, caps: IMAGE_COUNT },
  "openai image-to-image": { forced: { driver: "api" }, fileOptions: { ref: "file" } },
  "openai transcribe": {
    fileOptions: { input: "file", "known-speaker-reference": "file" },
  },
  "openrouter generate": { caps: IMAGE_COUNT },
  "openrouter image-to-image": { fileOptions: { ref: "file" } },
  "openrouter image-to-video": {
    urlOptions: ["image-url", "last-frame-url"],
    caps: VIDEO_CAPS,
  },
  "leonardo generate": { caps: { count: ["num"] } },
  "leonardo image-to-image": { caps: { count: ["num"] } },
  "leonardo video": { caps: { resolution: ["resolution"] } },
  "leonardo image-to-video": { caps: VIDEO_CAPS },
  "byteplus generate": { fileOptions: { "input-image": "file" }, caps: IMAGE_COUNT },
  "byteplus image-to-image": { fileOptions: { ref: "file" }, caps: IMAGE_COUNT },
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
    fileOptions: { input: "file" },
    urlOptions: ["source-url"],
    nameOptions: ["target-lang"],
  },
  "elevenlabs dub-status": { nameOptions: ["download"] },
  "elevenlabs voices design": { nameOptions: ["output-prefix"] },
  "elevenlabs isolate": { fileOptions: { input: "file" } },
  "elevenlabs align": { fileOptions: { input: "file", "text-file": "file" } },
  "fal image": { caps: IMAGE_COUNT },
  "fal video": { urlOptions: ["image-url"], caps: { duration: ["duration"] } },
  "atlas image": { caps: IMAGE_COUNT },
  "atlas image-to-image": { fileOptions: { ref: "file" }, caps: IMAGE_COUNT },
  "atlas video": { caps: VIDEO_CAPS },
  "atlas image-to-video": { fileOptions: { ref: "file" }, caps: VIDEO_CAPS },
  "atlas audio": { fileOptions: { audio: "file" } },
  "atlas 3d": { fileOptions: { ref: "file" } },
  "atlas upload": { filePositionals: ["file"] },
  // `--file key=path` maps a model field to a local file; not expressible remotely.
  "replicate run": { unsupported: ["file"] },
  "replicate image": { caps: { count: ["num-outputs"] } },
  "replicate video": { fileOptions: { image: "file" }, caps: VIDEO_CAPS },
  // --ratio is checked against each model's fixed list by the CLI (at most 1920x1080).
  "runway video": { fileOptions: { image: "file" }, caps: { duration: ["duration"] } },
  "runway image": {
    fileOptions: { reference: "file" },
    repeatable: ["reference", "reference-tag"],
  },
  "heygen video-agent": {
    fileOptions: { file: "file" },
    assetRefOptions: ["file"],
    repeatable: ["file"],
    urlOptions: ["callback-url"],
  },
  "heygen video": {
    fileOptions: { audio: "file", "background-image": "file" },
    assetRefOptions: ["audio", "background-image"],
    urlOptions: ["callback-url"],
    caps: { resolution: ["resolution"] },
  },
  "heygen translate": {
    filePositionals: ["source"],
    fileOptions: { audio: "file" },
    assetRefOptions: ["source", "audio"],
    urlOptions: ["callback-url"],
  },
  "heygen lipsync": {
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
  "media optimize": { fileOptions: { input: "file" } },
  "media split": { fileOptions: { input: "file" } },
  "media batch": { fileOptions: { "input-dir": "dir" } },
  "doc convert": { fileOptions: { input: "file" } },
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
  replicate: ["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"],
  runway: ["RUNWAYML_API_SECRET"],
  heygen: ["HEYGEN_API_KEY"],
};

/** Names that must all be set for a group to be usable (the rest are fallbacks or optional). */
export const GROUP_REQUIRED_KEYS: Readonly<
  Record<string, readonly (readonly ProviderSecretName[])[]>
> = {
  // Any one of a row satisfies it.
  byteplus: [["BYTEPLUS_API_KEY", "ARK_API_KEY"]],
  replicate: [["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"]],
  cloudflare: [["CLOUDFLARE_ACCOUNT_ID"], ["CLOUDFLARE_API_TOKEN"]],
};

export function policyFor(command: string): CommandPolicy {
  return COMMAND_POLICIES[command] ?? {};
}
