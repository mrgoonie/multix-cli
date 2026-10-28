/**
 * Node-side wiring for Sume: credentials and base URL from the environment,
 * a stderr logger for commands whose stdout is a result, and local media
 * uploaded through Sume's pre-signed upload URLs.
 */

import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveProviderBaseUrl, resolveRoutedKey } from "../../../core/env-loader.js";
import { ConfigError, ValidationError } from "../../../core/errors.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { checkBaseUrl } from "../../../core/url-safety.js";
import { UPLOAD_EXTENSIONS, uploadMimeTypeFor } from "../../atlascloud/upload-mime.js";
import { SumeClient } from "../client.js";
import { SUME_KEY_URL, SUME_ROUTING } from "../models.js";

/** Documented upload limit: up to 2 GiB per file. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function optionalSumeKey(): string | undefined {
  return resolveRoutedKey(SUME_ROUTING);
}

export function requireSumeKey(): string {
  const apiKey = optionalSumeKey();
  if (!apiKey) {
    throw new ConfigError(`SUME_API_KEY is not set. Create a key as described at ${SUME_KEY_URL}`);
  }
  return apiKey;
}

/** SUME_BASE_URL (https only, except http on loopback for local mocks), else the default. */
export function sumeBaseUrl(): string {
  return checkBaseUrl(resolveProviderBaseUrl(SUME_ROUTING), "SUME_BASE_URL");
}

export function createSumeClientFromEnv(fetch?: typeof globalThis.fetch): SumeClient {
  const apiKey = requireSumeKey();
  return new SumeClient({ apiKey, baseUrl: sumeBaseUrl(), ...(fetch ? { fetch } : {}) });
}

/** Progress on stderr when stdout carries the result (`--async` prints the job id). */
export function createSumeLogger(opts: { verbose?: boolean; stdoutReserved?: boolean }): Logger {
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

export function isRemoteRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref.trim());
}

/** Reject a non-https URL before anything is sent: Sume fetches inputs over public HTTPS only. */
export function checkRemoteRef(ref: string): void {
  if (/^http:\/\//i.test(ref.trim())) {
    throw new ValidationError(`Sume takes media as public https URLs, got an http URL: ${ref}`);
  }
}

/** A local media file checked for upload: allowed extension, regular file, non-empty, under the limit. */
export async function checkLocalMedia(
  ref: string,
): Promise<{ abs: string; mime: string; size: number }> {
  const abs = path.resolve(ref.trim());
  const name = path.basename(abs);
  // Only media leaves the machine: a stray `--image .env` must not become a public URL.
  const mime = uploadMimeTypeFor(name);
  if (!mime) {
    throw new ValidationError(
      `Refusing to upload ${ref}: not a supported media file. Allowed extensions: ${UPLOAD_EXTENSIONS.join(", ")}`,
    );
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new ValidationError(`Input file not found: ${ref}`);
  }
  if (!stat.isFile()) throw new ValidationError(`Input is not a file: ${ref}`);
  if (stat.size === 0) throw new ValidationError(`Input file is empty: ${ref}`);
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new ValidationError(`${ref} is larger than Sume's 2 GiB upload limit`);
  }
  return { abs, mime, size: stat.size };
}

/**
 * Turn a media argument into a URL Sume can fetch: an https URL passes
 * through; a local file is uploaded (POST /v1/files/generate-upload-url, then
 * PUT to the pre-signed URL, which is never logged) and its public URL used.
 */
export async function resolveSumeMedia(
  client: SumeClient,
  ref: string,
  logger: Logger,
): Promise<string> {
  const trimmed = ref.trim();
  checkRemoteRef(trimmed);
  if (isRemoteRef(trimmed)) return trimmed;
  const file = await checkLocalMedia(trimmed);
  const name = path.basename(file.abs);
  logger.info(`Uploading ${name} (${Math.ceil(file.size / 1024)} KB) to Sume...`);
  const target = await client.createUpload({
    contentType: file.mime,
    sizeBytes: file.size,
    filename: name,
  });
  // openAsBlob streams the file instead of buffering it.
  await client.putUpload(target, await openAsBlob(file.abs, { type: file.mime }));
  logger.debug(`Uploaded ${name} as asset ${target.asset_id ?? "?"}`);
  return target.public_url;
}
