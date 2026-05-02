/**
 * OpenRouter video API client.
 * Endpoints (per https://openrouter.ai/docs/guides/overview/multimodal/video-generation):
 *   POST /api/v1/videos              → submit job  → returns { id, polling_url, status }
 *   GET  /api/v1/videos/{jobId}      → poll       → returns { id, status, unsigned_urls[], usage }
 *   GET  /api/v1/videos/{jobId}/content → download (binary)
 *   GET  /api/v1/videos/models       → list video models
 *
 * Auth: Bearer OPENROUTER_API_KEY. Image inputs are URL-only (no base64/upload).
 */

import { resolveKey } from "../../core/env-loader.js";
import { httpJson } from "../../core/http-client.js";
import { requireOpenRouterKey } from "./client.js";

export const OPENROUTER_VIDEOS_URL = "https://openrouter.ai/api/v1/videos";

export interface OpenRouterVideoSubmitResponse {
  id: string;
  polling_url?: string;
  status: string;
}

export interface OpenRouterVideoPollResponse {
  id: string;
  generation_id?: string;
  polling_url?: string;
  status: "pending" | "in_progress" | "completed" | "failed" | string;
  unsigned_urls?: string[];
  usage?: { cost?: number; is_byok?: boolean };
  error?: unknown;
}

export interface OpenRouterVideoModel {
  id: string;
  name?: string;
  [k: string]: unknown;
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const referer = resolveKey("OPENROUTER_SITE_URL");
  const title = resolveKey("OPENROUTER_APP_NAME") ?? "multix";
  if (referer) headers["HTTP-Referer"] = referer;
  if (title) headers["X-Title"] = title;
  return headers;
}

export async function submitVideoJob(
  body: Record<string, unknown>,
  apiKey: string = requireOpenRouterKey(),
): Promise<OpenRouterVideoSubmitResponse> {
  return httpJson<OpenRouterVideoSubmitResponse>({
    url: OPENROUTER_VIDEOS_URL,
    method: "POST",
    headers: authHeaders(apiKey),
    body,
    timeoutMs: 120_000,
  });
}

export async function pollVideoJob(
  jobId: string,
  apiKey: string = requireOpenRouterKey(),
): Promise<OpenRouterVideoPollResponse> {
  return httpJson<OpenRouterVideoPollResponse>({
    url: `${OPENROUTER_VIDEOS_URL}/${jobId}`,
    headers: authHeaders(apiKey),
  });
}

export function videoContentUrl(jobId: string): string {
  return `${OPENROUTER_VIDEOS_URL}/${jobId}/content`;
}

export async function listVideoModels(
  apiKey: string = requireOpenRouterKey(),
): Promise<{ data?: OpenRouterVideoModel[]; models?: OpenRouterVideoModel[] }> {
  return httpJson({
    url: `${OPENROUTER_VIDEOS_URL}/models`,
    headers: authHeaders(apiKey),
  });
}
