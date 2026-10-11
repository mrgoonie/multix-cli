/**
 * Veo video generation over the Gemini REST API.
 * Contract (https://ai.google.dev/gemini-api/docs/veo):
 *   POST /v1beta/models/{model}:predictLongRunning
 *     { instances: [{ prompt, image?, lastFrame? }], parameters: { aspectRatio, resolution } }
 *   Images use { bytesBase64Encoded, mimeType }, the shape Google's official
 *   js-genai SDK sends to this endpoint.
 *   GET  /v1beta/{operation.name} until done
 *   video URI at response.generateVideoResponse.generatedSamples[0].video.uri,
 *   downloaded with the same x-goog-api-key header.
 */

import fs from "node:fs";
import { pollUntil } from "../../core/async-poll.js";
import { ProviderError, ValidationError } from "../../core/errors.js";
import { downloadFile, httpJson } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { getMimeType } from "./task-resolver.js";

const API_HOST = "generativelanguage.googleapis.com";
const BASE = `https://${API_HOST}/v1beta`;
const VEO_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VEO_TIMEOUT_MS = 10 * 60 * 1000;

export interface VeoImage {
  bytesBase64Encoded: string;
  mimeType: string;
}

export interface VeoRequestOptions {
  prompt: string;
  image?: VeoImage;
  lastFrame?: VeoImage;
  aspectRatio: string;
  resolution: string;
}

export interface VeoOperation {
  name: string;
  done?: boolean;
  error?: unknown;
  response?: Record<string, unknown>;
}

/** Read a local image as a Veo inlineData part. */
export function veoImageFromFile(imgPath: string): VeoImage {
  if (!fs.existsSync(imgPath)) throw new ValidationError(`Image not found: ${imgPath}`);
  const detected = getMimeType(imgPath);
  // Unknown extensions keep the historical JPEG assumption; known non-images are rejected.
  const mimeType = detected === "application/octet-stream" ? "image/jpeg" : detected;
  if (!VEO_IMAGE_TYPES.has(mimeType)) {
    throw new ValidationError(`Veo accepts JPEG, PNG or WebP images: ${imgPath} (${mimeType})`);
  }
  return { bytesBase64Encoded: fs.readFileSync(imgPath).toString("base64"), mimeType };
}

/** Map `--reference-images` to opening/closing frames (at most two). */
export function veoFramesFromPaths(paths: string[] = []): {
  image?: VeoImage;
  lastFrame?: VeoImage;
} {
  if (paths.length > 2) {
    throw new ValidationError(
      "--reference-images accepts at most two images (opening frame, closing frame)",
    );
  }
  const [first, last] = paths;
  return {
    image: first ? veoImageFromFile(first) : undefined,
    lastFrame: last ? veoImageFromFile(last) : undefined,
  };
}

/** Accept both "veo-3.1-…" and "models/veo-3.1-…". */
function modelPath(model: string): string {
  return model.replace(/^models\//, "");
}

export function buildVeoRequest(opts: VeoRequestOptions): Record<string, unknown> {
  const instance: Record<string, unknown> = { prompt: opts.prompt };
  if (opts.image) instance.image = opts.image;
  if (opts.lastFrame) instance.lastFrame = opts.lastFrame;
  return {
    instances: [instance],
    parameters: { aspectRatio: opts.aspectRatio, resolution: opts.resolution },
  };
}

/** Video URI from a finished operation; tolerates the SDK-style shapes too. */
export function extractVeoVideoUri(op: VeoOperation): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic API response
  const r = (op.response ?? {}) as any;
  return (
    r.generateVideoResponse?.generatedSamples?.[0]?.video?.uri ??
    r.generatedSamples?.[0]?.video?.uri ??
    r.generatedVideos?.[0]?.video?.uri
  );
}

function headers(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}

export async function submitVeo(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
): Promise<VeoOperation> {
  try {
    return await httpJson<VeoOperation>({
      url: `${BASE}/models/${modelPath(model)}:predictLongRunning`,
      method: "POST",
      headers: headers(apiKey),
      body,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ProviderError(`Veo submit failed: ${msg}`, "gemini");
  }
}

/** Poll an operation to completion (bounded), returning the finished operation. */
export async function waitForVeo(
  apiKey: string,
  operation: VeoOperation,
  logger: Logger,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<VeoOperation> {
  if (operation.done) return checkVeoResult(operation);
  const finalOp = await pollUntil<VeoOperation>({
    fetchStatus: ({ remainingMs }) =>
      httpJson<VeoOperation>({
        url: `${BASE}/${operation.name}`,
        headers: headers(apiKey),
        timeoutMs: Math.min(remainingMs, 60_000),
      }),
    isTerminal: (op) => op.done === true,
    timeoutMs: opts.timeoutMs ?? VEO_TIMEOUT_MS,
    intervalMs: opts.intervalMs ?? 10_000,
    maxIntervalMs: 20_000,
    sleep: opts.sleep,
    onPoll: (op, attempt) => {
      if (!op.done) logger.debug(`Still generating... (poll ${attempt})`);
    },
    resumeHint: `Operation (still running server-side): ${operation.name}`,
  });
  return checkVeoResult(finalOp);
}

function checkVeoResult(op: VeoOperation): VeoOperation {
  if (op.error) throw new ProviderError(`Veo error: ${JSON.stringify(op.error)}`, "gemini");
  return op;
}

/**
 * Download the generated video. Gemini file URIs require the API key header;
 * it is only attached for the Gemini API host so the key never goes elsewhere.
 */
export async function downloadVeoVideo(apiKey: string, uri: string, dest: string): Promise<void> {
  let host = "";
  try {
    host = new URL(uri).hostname;
  } catch {
    throw new ProviderError("Veo returned an invalid video URI", "gemini");
  }
  await downloadFile(uri, dest, 300_000, host === API_HOST ? headers(apiKey) : undefined);
}

/** Submit, wait, and download to `dest`. Returns the finished operation. */
export async function runVeo(
  apiKey: string,
  model: string,
  request: VeoRequestOptions,
  dest: string,
  logger: Logger,
): Promise<VeoOperation> {
  const operation = await submitVeo(apiKey, model, buildVeoRequest(request));
  logger.debug(`Operation: ${operation.name}`);
  const finalOp = await waitForVeo(apiKey, operation, logger);
  const uri = extractVeoVideoUri(finalOp);
  if (!uri) {
    throw new ProviderError(
      `Unexpected Veo response structure: ${JSON.stringify(finalOp.response)}`,
      "gemini",
    );
  }
  await downloadVeoVideo(apiKey, uri, dest);
  return finalOp;
}
