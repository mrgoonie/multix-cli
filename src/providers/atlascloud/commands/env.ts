/**
 * Node-side wiring for Atlas Cloud: credentials, base URL and model defaults
 * from the environment, and local-file references uploaded via uploadMedia.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveKey } from "../../../core/env-loader.js";
import { ConfigError, ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { redactUrl } from "../../../core/redact.js";
import { AtlasCloudClient } from "../client.js";
import { ATLAS_DEFAULT_MODELS, type AtlasDefaultModelKey } from "../models.js";
import { guessUploadMimeType } from "../upload-mime.js";

export const ATLAS_KEY_URL = "https://www.atlascloud.ai/console/api-keys";

const MODEL_ENV: Record<AtlasDefaultModelKey, string> = {
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
  return resolveKey(MODEL_ENV[key])?.trim() || ATLAS_DEFAULT_MODELS[key];
}

export function createAtlasClientFromEnv(): AtlasCloudClient {
  const apiKey = resolveKey("ATLASCLOUD_API_KEY")?.trim();
  if (!apiKey) {
    throw new ConfigError(`ATLASCLOUD_API_KEY is not set. Get one at ${ATLAS_KEY_URL}`);
  }
  return new AtlasCloudClient({ apiKey, baseUrl: resolveKey("ATLASCLOUD_BASE_URL") });
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
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new ValidationError(`Reference file not found: ${trimmed}`);
  }
  if (!stat.isFile()) throw new ValidationError(`Reference is not a file: ${trimmed}`);
  if (stat.size === 0) throw new ValidationError(`Reference file is empty: ${trimmed}`);

  const name = path.basename(abs);
  const mime = guessUploadMimeType(name);
  const bytes = await fs.readFile(abs);
  logger.info(`Uploading ${name} (${Math.ceil(bytes.byteLength / 1024)} KB) to Atlas Cloud...`);
  const uploaded = await client.uploadMedia(new Blob([bytes], { type: mime }), name, mime);
  logger.debug(`Uploaded ${name} -> ${redactUrl(uploaded.url)}`);
  return uploaded.url;
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
