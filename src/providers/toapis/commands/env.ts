/**
 * Node-side wiring for ToAPIs: key, base URL and model defaults from the
 * environment, local-file references uploaded before submit, and a logger
 * that keeps stdout for machine-readable results.
 */

import { openAsBlob } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveKey, resolveProviderBaseUrl, resolveRoutedKey } from "../../../core/env-loader.js";
import { ConfigError, ValidationError } from "../../../core/errors.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { redactUrl } from "../../../core/redact.js";
import { checkBaseUrl } from "../../../core/url-safety.js";
import { ToapisClient } from "../client.js";
import {
  DEFAULT_TOAPIS_IMAGE_MODEL,
  DEFAULT_TOAPIS_VIDEO_MODEL,
  TOAPIS_DASHBOARD_LINK,
  TOAPIS_IMAGE_MODEL_ENV,
  TOAPIS_ROUTING,
  TOAPIS_VIDEO_MODEL_ENV,
} from "../models.js";
import type { ToapisMediaKind, ToapisUploadKind } from "../types.js";

export function toapisDefaultModel(kind: ToapisMediaKind): string {
  const env = kind === "image" ? TOAPIS_IMAGE_MODEL_ENV : TOAPIS_VIDEO_MODEL_ENV;
  const fallback = kind === "image" ? DEFAULT_TOAPIS_IMAGE_MODEL : DEFAULT_TOAPIS_VIDEO_MODEL;
  return resolveKey(env)?.trim() || fallback;
}

export function createToapisClientFromEnv(): ToapisClient {
  const apiKey = resolveRoutedKey(TOAPIS_ROUTING);
  if (!apiKey) {
    throw new ConfigError(`TOAPIS_API_KEY is not set. Create one at ${TOAPIS_DASHBOARD_LINK}`);
  }
  // https only, except http on loopback for local mocks.
  const baseUrl = checkBaseUrl(resolveProviderBaseUrl(TOAPIS_ROUTING), TOAPIS_ROUTING.name);
  return new ToapisClient({ apiKey, baseUrl });
}

/** Base URL for the keyless price quote (same trust rules as the client). */
export function toapisBaseUrlFromEnv(): string {
  return checkBaseUrl(resolveProviderBaseUrl(TOAPIS_ROUTING), TOAPIS_ROUTING.name);
}

/** Upload limits from https://docs.toapis.com/docs/en/api-reference/uploads/*. */
const UPLOAD_TYPES: Record<string, { kind: ToapisUploadKind; mime: string; maxMb: number }> = {
  ".jpg": { kind: "images", mime: "image/jpeg", maxMb: 30 },
  ".jpeg": { kind: "images", mime: "image/jpeg", maxMb: 30 },
  ".png": { kind: "images", mime: "image/png", maxMb: 30 },
  ".webp": { kind: "images", mime: "image/webp", maxMb: 30 },
  ".gif": { kind: "images", mime: "image/gif", maxMb: 30 },
  ".mp4": { kind: "videos", mime: "video/mp4", maxMb: 50 },
  ".webm": { kind: "videos", mime: "video/webm", maxMb: 50 },
  ".mov": { kind: "videos", mime: "video/quicktime", maxMb: 50 },
  ".mp3": { kind: "audios", mime: "audio/mpeg", maxMb: 50 },
  ".wav": { kind: "audios", mime: "audio/wav", maxMb: 50 },
  ".m4a": { kind: "audios", mime: "audio/mp4", maxMb: 50 },
};

/** Upload one local media file and return its public URL. */
export async function uploadLocalFile(
  client: ToapisClient,
  file: string,
  logger: Logger,
): Promise<string> {
  let abs: string;
  try {
    // Check the real target, so a media-named link to a secret file is refused.
    abs = await fs.realpath(path.resolve(file.trim()));
  } catch {
    throw new ValidationError(`File not found: ${file}`);
  }
  const name = path.basename(abs);
  // Only media leaves the machine: a stray `--image .env` must not become a public URL.
  const type = UPLOAD_TYPES[path.extname(name).toLowerCase()];
  if (!type) {
    throw new ValidationError(
      `Refusing to upload ${file}: not a supported media file. Allowed: ${Object.keys(UPLOAD_TYPES).join(", ")}`,
    );
  }
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new ValidationError(`File not found: ${file}`);
  }
  if (!stat.isFile() || stat.size === 0) throw new ValidationError(`Not a non-empty file: ${file}`);
  if (stat.size > type.maxMb * 1024 * 1024) {
    throw new ValidationError(
      `${file} is above the ${type.maxMb} MB ToAPIs upload limit; pass a public URL instead`,
    );
  }
  logger.info(`Uploading ${name} (${Math.ceil(stat.size / 1024)} KB) to ToAPIs...`);
  const blob = await openAsBlob(abs, { type: type.mime });
  const uploaded = await client.upload(type.kind, blob, name, type.mime);
  logger.debug(`Uploaded ${name} -> ${redactUrl(uploaded.url)}`);
  return uploaded.url;
}

/** http(s) URLs pass through; local files are uploaded (ToAPIs takes no base64). */
export async function resolveRef(
  client: ToapisClient,
  ref: string | undefined,
  logger: Logger,
): Promise<string | undefined> {
  if (ref === undefined) return undefined;
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^data:/i.test(trimmed)) {
    throw new ValidationError("ToAPIs does not accept data: URIs; pass a file path or a URL");
  }
  return uploadLocalFile(client, trimmed, logger);
}

/** Logger whose progress lines go to stderr when stdout carries the result. */
export function createToapisLogger(opts: { verbose?: boolean; stdoutReserved?: boolean }): Logger {
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
