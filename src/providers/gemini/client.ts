/**
 * GeminiClient — thin REST wrapper around Gemini generateContent + Files API.
 * Uses httpJson from core (undici fetch). No google-genai SDK dependency.
 *
 * Auth: x-goog-api-key header (preferred over ?key= query param).
 * Base: https://generativelanguage.googleapis.com
 */

import fs from "node:fs";
import path from "node:path";
import { httpJson, downloadFile } from "../../core/http-client.js";
import { ConfigError, ProviderError } from "../../core/errors.js";
import { resolveKey } from "../../core/env-loader.js";
import { getMimeType, requiresProcessingWait } from "./task-resolver.js";
import type { Logger } from "../../core/logger.js";

const BASE = "https://generativelanguage.googleapis.com";
const FILES_BASE = `${BASE}/upload/v1beta/files`;
const GENERATE_BASE = `${BASE}/v1beta/models`;

/** Uploaded file reference returned by Files API. */
export interface FileRef {
  name: string;
  uri: string;
  state: "PROCESSING" | "ACTIVE" | "FAILED";
  mimeType: string;
}

/** Part of a generateContent request. */
export type ContentPart =
  | { text: string }
  | { fileData: { mimeType: string; fileUri: string } }
  | { inlineData: { mimeType: string; data: string } };

export interface GenerateContentRequest {
  model: string;
  contents: Array<{ role?: string; parts: ContentPart[] }>;
  generationConfig?: Record<string, unknown>;
}

export interface GenerateContentResponse {
  candidates?: Array<{
    content: {
      parts: Array<{
        text?: string;
        inlineData?: { mimeType: string; data: string };
      }>;
    };
  }>;
}

export interface ImageGenerationResponse {
  images?: Array<{ imageBytes: string; mimeType: string }>;
}

/** Resolve and validate GEMINI_API_KEY. */
function requireApiKey(): string {
  const key = resolveKey("GEMINI_API_KEY");
  if (!key) throw new ConfigError("GEMINI_API_KEY is not set. Get one at https://aistudio.google.com/apikey");
  return key;
}

function authHeaders(apiKey: string): Record<string, string> {
  return { "x-goog-api-key": apiKey };
}

/**
 * Upload a local file to the Gemini Files API via multipart/form-data.
 * Polls until ACTIVE for audio/video files.
 */
export async function uploadFile(
  filePath: string,
  opts: { timeoutMs?: number; logger?: Logger } = {},
): Promise<FileRef> {
  const apiKey = requireApiKey();
  const { timeoutMs = 300_000, logger } = opts;

  const mimeType = getMimeType(filePath);
  const fileBytes = fs.readFileSync(filePath);
  const displayName = path.basename(filePath);

  // Multipart upload: metadata part + media part
  const boundary = `multix_${Date.now()}`;
  const metaJson = JSON.stringify({ file: { displayName, mimeType } });

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    ),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  logger?.debug(`Uploading ${displayName} (${(fileBytes.length / 1024 / 1024).toFixed(2)} MB)`);

  // Use globalThis.fetch for binary body (httpJson would re-stringify)
  const resp = await globalThis.fetch(FILES_BASE, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": `multipart/related; boundary=${boundary}`,
      "Content-Length": String(body.length),
      "X-Goog-Upload-Protocol": "multipart",
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new ProviderError(`File upload failed (HTTP ${resp.status}): ${txt.slice(0, 500)}`, "gemini");
  }

  // biome-ignore lint/suspicious/noExplicitAny: dynamic API response
  const data = (await resp.json()) as any;
  let fileRef: FileRef = data.file as FileRef;

  // Poll for audio/video processing
  if (requiresProcessingWait(mimeType)) {
    const deadline = Date.now() + timeoutMs;
    while (fileRef.state === "PROCESSING" && Date.now() < deadline) {
      await sleep(2000);
      fileRef = await httpJson<{ file: FileRef }>({
        url: `${BASE}/v1beta/${fileRef.name}`,
        headers: authHeaders(apiKey),
      }).then((r) => r.file);
      logger?.debug(`Processing... state=${fileRef.state}`);
    }
    if (fileRef.state === "FAILED") throw new ProviderError(`File processing failed: ${filePath}`, "gemini");
    if (fileRef.state === "PROCESSING") throw new ProviderError(`Processing timeout: ${filePath}`, "gemini");
  }

  logger?.debug(`Uploaded: ${fileRef.name} (${fileRef.uri})`);
  return fileRef;
}

/**
 * Call generateContent endpoint and return the full response.
 */
export async function generateContent(req: GenerateContentRequest): Promise<GenerateContentResponse> {
  const apiKey = requireApiKey();
  return httpJson<GenerateContentResponse>({
    url: `${GENERATE_BASE}/${req.model}:generateContent`,
    method: "POST",
    headers: authHeaders(apiKey),
    body: {
      contents: req.contents,
      ...(req.generationConfig ? { generationConfig: req.generationConfig } : {}),
    },
  });
}

/**
 * Extract text from a generateContent response.
 */
export function extractText(resp: GenerateContentResponse): string {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.text !== undefined)
    .map((p) => p.text ?? "")
    .join("");
}

/**
 * Extract inline image data from a generateContent response.
 * Returns array of { mimeType, data } (base64).
 */
export function extractImages(resp: GenerateContentResponse): Array<{ mimeType: string; data: string }> {
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((p) => p.inlineData !== undefined)
    .map((p) => ({ mimeType: p.inlineData!.mimeType, data: p.inlineData!.data }));
}

/**
 * List available Gemini models — used for connectivity check.
 */
export async function listModels(timeoutMs = 10_000): Promise<string[]> {
  const apiKey = requireApiKey();
  // biome-ignore lint/suspicious/noExplicitAny: dynamic API
  const resp = await httpJson<any>({
    url: `${BASE}/v1beta/models?key=${apiKey}`,
    timeoutMs,
  });
  // biome-ignore lint/suspicious/noExplicitAny: dynamic API
  return ((resp.models ?? []) as any[]).map((m: any) => m.name as string);
}

/**
 * Build a ContentPart for an inline file (< 20 MB).
 */
export function inlinePart(filePath: string): ContentPart {
  const data = fs.readFileSync(filePath).toString("base64");
  const mimeType = getMimeType(filePath);
  return { inlineData: { mimeType, data } };
}

/** True if file should use Files API (> 20 MB). */
export function shouldUseFileApi(filePath: string): boolean {
  const stat = fs.statSync(filePath);
  return stat.size > 20 * 1024 * 1024;
}

/**
 * Download a generated video from the Files API to a local path.
 */
export async function downloadGeneratedFile(fileUri: string, dest: string): Promise<void> {
  await downloadFile(fileUri, dest);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
