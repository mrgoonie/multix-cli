/**
 * Node-side wiring for TopView: keys and base URLs from the environment, and
 * local files uploaded before a task references them. The legacy API and the
 * API Platform never share a key and never fall back to each other.
 */

import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveKey, resolveProviderBaseUrl, resolveRoutedKey } from "../../../core/env-loader.js";
import { ConfigError, ValidationError } from "../../../core/errors.js";
import type { Logger } from "../../../core/logger.js";
import { checkBaseUrl } from "../../../core/url-safety.js";
import { TopviewLegacyClient } from "../legacy-client.js";
import {
  LEGACY_UPLOAD_FORMATS,
  PLATFORM_MAX_UPLOAD_BYTES,
  PLATFORM_UPLOAD_KINDS,
  TOPVIEW_KEY_URL,
  TOPVIEW_LEGACY_ROUTING,
  TOPVIEW_PLATFORM_KEY_URL,
  TOPVIEW_PLATFORM_ROUTING,
  TOPVIEW_UID_ENV,
} from "../models.js";
import { TopviewPlatformClient } from "../platform-client.js";
import type { PlatformAsset } from "../types.js";

/** Largest local file sent to the legacy upload (no documented limit; matches common caps). */
const LEGACY_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const ASSET_REF = /^asset:([A-Za-z0-9_-]{1,128})$/;

export function createLegacyClientFromEnv(): TopviewLegacyClient {
  const apiKey = resolveRoutedKey(TOPVIEW_LEGACY_ROUTING);
  if (!apiKey) {
    throw new ConfigError(
      `TOPVIEW_API_KEY is not set (legacy API, topview.ai plan credits). Get the key and ${TOPVIEW_UID_ENV} under API Settings at ${TOPVIEW_KEY_URL}`,
    );
  }
  const uid = resolveKey(TOPVIEW_UID_ENV)?.trim();
  if (!uid) {
    throw new ConfigError(
      `${TOPVIEW_UID_ENV} is not set; the legacy API sends it with TOPVIEW_API_KEY. Find it under API Settings at ${TOPVIEW_KEY_URL}`,
    );
  }
  const baseUrl = checkBaseUrl(resolveProviderBaseUrl(TOPVIEW_LEGACY_ROUTING), "TOPVIEW_BASE_URL");
  return new TopviewLegacyClient({ apiKey, uid, baseUrl });
}

export function createPlatformClientFromEnv(): TopviewPlatformClient {
  const apiKey = resolveRoutedKey(TOPVIEW_PLATFORM_ROUTING);
  if (!apiKey) {
    throw new ConfigError(
      `TOPVIEW_API_PLATFORM_KEY is not set (API Platform, separate USD balance). Create one under API keys at ${TOPVIEW_PLATFORM_KEY_URL}`,
    );
  }
  const baseUrl = checkBaseUrl(
    resolveProviderBaseUrl(TOPVIEW_PLATFORM_ROUTING),
    "TOPVIEW_PLATFORM_BASE_URL",
  );
  return new TopviewPlatformClient({ apiKey, baseUrl });
}

/** A local file checked for existence, size and an allowed extension. */
async function localMedia(
  ref: string,
  allowed: readonly string[],
  maxBytes: number,
): Promise<{ abs: string; name: string; ext: string; size: number }> {
  const abs = path.resolve(ref);
  const name = path.basename(abs);
  const ext = path.extname(name).slice(1).toLowerCase();
  // Only media leaves the machine: a stray `--file .env` must never be uploaded.
  if (!allowed.includes(ext)) {
    throw new ValidationError(
      `Refusing to upload ${ref}: not a supported media file. Allowed extensions: ${allowed.join(", ")}`,
    );
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new ValidationError(`File not found: ${ref}`);
  }
  if (!stat.isFile()) throw new ValidationError(`Not a file: ${ref}`);
  if (stat.size === 0) throw new ValidationError(`File is empty: ${ref}`);
  if (stat.size > maxBytes) {
    throw new ValidationError(
      `${ref} is ${(stat.size / 1048576).toFixed(1)} MB, above the ${Math.round(maxBytes / 1048576)} MB upload limit`,
    );
  }
  return { abs, name, ext, size: stat.size };
}

/**
 * Turn a file argument into a legacy file id: `asset:<fileId>` passes an
 * already uploaded file through; a local path is uploaded first.
 */
export async function resolveLegacyFile(
  client: TopviewLegacyClient,
  ref: string,
  logger: Logger,
): Promise<string> {
  const trimmed = ref.trim();
  const asset = ASSET_REF.exec(trimmed);
  if (asset?.[1]) return asset[1];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new ValidationError(
      `TopView takes uploaded files, not URLs: pass a local file or asset:<fileId> (got ${trimmed.split("?")[0]})`,
    );
  }
  const file = await localMedia(trimmed, LEGACY_UPLOAD_FORMATS, LEGACY_MAX_UPLOAD_BYTES);
  logger.info(`Uploading ${file.name} (${Math.ceil(file.size / 1024)} KB) to TopView...`);
  const blob = await openAsBlob(file.abs);
  const fileId = await client.uploadFile(blob, file.ext);
  logger.debug(`Uploaded ${file.name} -> file ${fileId}`);
  return fileId;
}

/** resolveLegacyFile for an optional flag. */
export function optionalFile(
  client: TopviewLegacyClient,
  ref: string | undefined,
  logger: Logger,
): Promise<string | undefined> {
  return ref === undefined ? Promise.resolve(undefined) : resolveLegacyFile(client, ref, logger);
}

/** Upload a local file as a Platform workspace asset. */
export async function uploadPlatformAsset(
  client: TopviewPlatformClient,
  ref: string,
  logger: Logger,
): Promise<PlatformAsset> {
  const file = await localMedia(
    ref.trim(),
    Object.keys(PLATFORM_UPLOAD_KINDS),
    PLATFORM_MAX_UPLOAD_BYTES,
  );
  const kind = PLATFORM_UPLOAD_KINDS[file.ext];
  if (!kind) throw new ValidationError(`Unsupported file type: .${file.ext}`);
  logger.info(
    `Uploading ${file.name} (${Math.ceil(file.size / 1024)} KB) to the TopView Platform...`,
  );
  const blob = await openAsBlob(file.abs);
  return client.uploadAsset(blob, file.name, kind);
}

/** Same stderr-only progress logger Atlas uses for commands that print a result on stdout. */
export { createAtlasLogger as createTopviewLogger } from "../../atlascloud/commands/env.js";
