/**
 * Node-side wiring for Atlas Cloud: credentials, base URL and model defaults
 * from the environment, and local-file references uploaded via uploadMedia.
 */

import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveKey, resolveProviderBaseUrl, resolveRoutedKey } from "../../../core/env-loader.js";
import { ConfigError, ValidationError } from "../../../core/errors.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { redactUrl } from "../../../core/redact.js";
import { UPLOAD_EXTENSIONS, uploadMimeTypeFor } from "../../../core/upload-mime.js";
import { checkBaseUrl } from "../../../core/url-safety.js";
import { AtlasCloudClient } from "../client.js";
import { ATLAS_DEFAULT_MODELS, ATLAS_ROUTING, type AtlasDefaultModelKey } from "../models.js";

export const ATLAS_KEY_URL = "https://www.atlascloud.ai/console/api-keys";

/** Env var that overrides the default model of each Atlas Cloud task. */
export const ATLAS_MODEL_ENV: Readonly<Record<AtlasDefaultModelKey, string>> = {
  image: "ATLASCLOUD_IMAGE_MODEL",
  imageEdit: "ATLASCLOUD_IMAGE_EDIT_MODEL",
  video: "ATLASCLOUD_VIDEO_MODEL",
  imageToVideo: "ATLASCLOUD_IMAGE_TO_VIDEO_MODEL",
  tts: "ATLASCLOUD_TTS_MODEL",
  stt: "ATLASCLOUD_STT_MODEL",
  textTo3d: "ATLASCLOUD_TEXT_TO_3D_MODEL",
  imageTo3d: "ATLASCLOUD_IMAGE_TO_3D_MODEL",
};

/** Default model id for a task, honouring its ATLASCLOUD_*_MODEL override. */
export function atlasDefaultModel(key: AtlasDefaultModelKey): string {
  return resolveKey(ATLAS_MODEL_ENV[key])?.trim() || ATLAS_DEFAULT_MODELS[key];
}

export function requireAtlasKey(): string {
  const apiKey = resolveRoutedKey(ATLAS_ROUTING);
  if (!apiKey) {
    throw new ConfigError(`ATLASCLOUD_API_KEY is not set. Get one at ${ATLAS_KEY_URL}`);
  }
  return apiKey;
}

export function createAtlasClientFromEnv(): AtlasCloudClient {
  const apiKey = requireAtlasKey();
  // https only, except http on loopback for local mocks.
  const baseUrl = checkBaseUrl(resolveProviderBaseUrl(ATLAS_ROUTING), "ATLASCLOUD_BASE_URL");
  return new AtlasCloudClient({ apiKey, baseUrl });
}

/**
 * Turn a `--ref`/`--audio` argument into a URL the model can fetch.
 * http(s) and data: URIs pass through; local files are uploaded first.
 */
export async function resolveMediaRef(
  client: AtlasCloudClient,
  ref: string,
  logger: Logger,
): Promise<string> {
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed)) return trimmed;

  const abs = path.resolve(trimmed);
  const name = path.basename(abs);
  // Only media leaves the machine: a stray `--ref .env` must not become a public URL.
  const mime = uploadMimeTypeFor(name);
  if (!mime) {
    throw new ValidationError(
      `Refusing to upload ${trimmed}: not a supported media file. Allowed extensions: ${UPLOAD_EXTENSIONS.join(", ")}`,
    );
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new ValidationError(`Reference file not found: ${trimmed}`);
  }
  if (!stat.isFile()) throw new ValidationError(`Reference is not a file: ${trimmed}`);
  if (stat.size === 0) throw new ValidationError(`Reference file is empty: ${trimmed}`);
  const maxBytes = maxUploadBytes();
  if (stat.size > maxBytes) {
    throw new ValidationError(
      `${trimmed} is ${formatMb(stat.size)}, above the ${formatMb(maxBytes)} upload limit (set ${MAX_UPLOAD_ENV} to change it)`,
    );
  }

  logger.info(`Uploading ${name} (${Math.ceil(stat.size / 1024)} KB) to Atlas Cloud...`);
  // openAsBlob streams the file into the multipart body instead of buffering it.
  const blob = await openAsBlob(abs, { type: mime });
  const uploaded = await client.uploadMedia(blob, name, mime);
  logger.debug(`Uploaded ${name} -> ${redactUrl(uploaded.url)}`);
  return uploaded.url;
}

export const MAX_UPLOAD_ENV = "ATLASCLOUD_MAX_UPLOAD_MB";
const DEFAULT_MAX_UPLOAD_MB = 200;

/** Upload size cap in bytes: ATLASCLOUD_MAX_UPLOAD_MB, default 200 MB. */
export function maxUploadBytes(): number {
  const raw = resolveKey(MAX_UPLOAD_ENV)?.trim();
  if (!raw) return DEFAULT_MAX_UPLOAD_MB * 1024 * 1024;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) {
    throw new ConfigError(`${MAX_UPLOAD_ENV} must be a positive number of megabytes, got "${raw}"`);
  }
  return Math.floor(mb * 1024 * 1024);
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Logger for commands whose stdout is a machine-readable result (`--async`
 * prints the prediction id, `upload` prints the URL): every progress line goes
 * to stderr so `id=$(multix atlas ... --async)` captures only the result.
 */
export function createAtlasLogger(opts: { verbose?: boolean; stdoutReserved?: boolean }): Logger {
  const verbose = opts.verbose ?? false;
  const base = createLogger({ verbose });
  if (!opts.stdoutReserved) return base;
  return {
    ...base,
    info: (msg) => console.error(`  ${msg}`),
    success: (msg) => console.error(`✓ ${msg}`),
    debug: (msg) => {
      if (verbose) console.error(`  [debug] ${msg}`);
    },
    header: (msg) => console.error(msg),
  };
}

export async function resolveMediaRefs(
  client: AtlasCloudClient,
  refs: string[],
  logger: Logger,
): Promise<string[]> {
  const urls: string[] = [];
  for (const ref of refs) urls.push(await resolveMediaRef(client, ref, logger));
  return urls;
}
