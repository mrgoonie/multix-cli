/**
 * OpenRouter dedicated image endpoint (`POST /api/v1/images`).
 *
 * Image-only models (for example openai/gpt-image-2.6-flare and the Seedream 5
 * family) are rejected by chat completions with a 404 that points at this
 * endpoint. The chat route stays the first attempt because it serves the models
 * that already work there; this route is the fallback.
 *
 * Runtime-neutral: no node:* imports.
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 */

import { HttpError } from "../../core/errors.js";
import { httpJson } from "../../core/http-client.js";
import { type ParsedImageResponse, buildOpenRouterHeaders } from "./payload.js";

export const OPENROUTER_IMAGES_API_URL = "https://openrouter.ai/api/v1/images";

/**
 * True when OpenRouter refused a chat-completions request because the model
 * only serves the images endpoint.
 */
export function isImagesEndpointRequired(err: unknown): boolean {
  if (!(err instanceof HttpError) || err.status !== 404) return false;
  const text = `${err.snippet} ${err.message}`.toLowerCase();
  return text.includes("/api/v1/images") || text.includes("image generation model");
}

export interface ImagesEndpointRequest {
  prompt: string;
  model: string;
  aspectRatio?: string;
  /** Resolution tier such as 1K, 2K, 4K. */
  imageSize?: string;
  /** Reference images as http(s) URLs or data URLs (image-to-image). */
  refs?: string[];
}

export function buildImagesPayload(req: ImagesEndpointRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = { model: req.model, prompt: req.prompt };
  if (req.aspectRatio) payload.aspect_ratio = req.aspectRatio;
  if (req.imageSize) payload.resolution = req.imageSize;
  if (req.refs && req.refs.length > 0) {
    payload.input_references = req.refs.map((url) => ({ type: "image_url", image_url: { url } }));
  }
  return payload;
}

/** Convert a `/images` response into data URLs, matching the chat parser's shape. */
export function extractImagesFromImagesResponse(data: unknown): ParsedImageResponse {
  const out: ParsedImageResponse = { urls: [] };
  const items = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.b64_json === "string" && rec.b64_json) {
      const mime = typeof rec.media_type === "string" ? rec.media_type : "image/png";
      out.urls.push(`data:${mime};base64,${rec.b64_json}`);
    } else if (typeof rec.url === "string" && rec.url) {
      out.urls.push(rec.url);
    }
  }
  return out;
}

/** Generate (or edit, when refs are set) through `/api/v1/images`. */
export async function requestOpenRouterImages(
  apiKey: string,
  req: ImagesEndpointRequest,
): Promise<ParsedImageResponse> {
  const data = await httpJson<unknown>({
    url: OPENROUTER_IMAGES_API_URL,
    method: "POST",
    headers: buildOpenRouterHeaders(apiKey),
    body: buildImagesPayload(req),
    timeoutMs: 240_000,
  });
  const parsed = extractImagesFromImagesResponse(data);
  parsed.model = req.model;
  return parsed;
}
