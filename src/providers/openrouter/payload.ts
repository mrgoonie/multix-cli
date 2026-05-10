/**
 * Shared OpenRouter payload helpers.
 *
 * - resolveModalities: picks `["image","text"]` (default) or `["image"]` for
 *   known image-only model families (Flux, Sourceful). Most OpenRouter image
 *   models — Gemini, OpenAI gpt-image, Recraft — return text + image, so the
 *   default IS `["image","text"]`. Only image-only families need the override.
 * - buildOpenRouterHeaders: Authorization + optional HTTP-Referer + X-Title.
 * - extractImagesFromResponse: tolerant parser that accepts the canonical
 *   `message.images[]` shape AND a fallback where image parts appear inside
 *   `message.content[]` (per OpenRouter docs the canonical path is the former,
 *   but the fallback guards against future model quirks).
 * - formatNoImagesError: rich diagnostic when no images come back.
 * - buildI2IPayload: builds the i2i chat-completions body used by the i2i
 *   command. Optionally emits `image_config.strength` (Recraft) and routes
 *   through `models: [...]` when fallbacks are configured.
 */

import { resolveKey } from "../../core/env-loader.js";

/**
 * Model id prefixes that only output images (no text channel).
 *
 * Verified live against OpenRouter:
 * - `black-forest-labs/` — Flux family (flux.2-pro, flux.2-max, flux.2-flex)
 * - `bytedance-seed/seedream` — Seedream image models (seedream-4.5)
 * - `sourceful/` — kept per OpenRouter docs (currently no public catalog entry)
 *
 * NOTE: `bytedance-seed/` is NOT a blanket match — that org also publishes
 * chat LLMs (seed-1.6, seed-2.0-lite). Match the seedream sub-prefix only.
 */
export const IMAGE_ONLY_MODEL_PREFIXES: readonly string[] = [
  "black-forest-labs/",
  "bytedance-seed/seedream",
  "sourceful/",
];

/** Pick OpenRouter `modalities` array based on model family. */
export function resolveModalities(model: string): string[] {
  const lower = model.toLowerCase();
  return IMAGE_ONLY_MODEL_PREFIXES.some((p) => lower.startsWith(p)) ? ["image"] : ["image", "text"];
}

/** Build standard OpenRouter request headers. */
export function buildOpenRouterHeaders(apiKey: string): Record<string, string> {
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

export interface ParsedImageResponse {
  /** All image URLs / data URLs found in the response. */
  urls: string[];
  /** Plain text content from the assistant message, if any (for diagnostics). */
  textContent?: string;
  /** finish_reason from the first choice, if present. */
  finishReason?: string;
  /** Top-level model id echoed by the response. */
  model?: string;
}

/** Extract image URLs from an OpenRouter chat-completions response. Tolerant. */
export function extractImagesFromResponse(data: unknown): ParsedImageResponse {
  const out: ParsedImageResponse = { urls: [] };
  if (!data || typeof data !== "object") return out;

  const root = data as Record<string, unknown>;
  if (typeof root.model === "string") out.model = root.model;

  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return out;

  const choice = first as Record<string, unknown>;
  if (typeof choice.finish_reason === "string") out.finishReason = choice.finish_reason;

  const message = choice.message as Record<string, unknown> | undefined;
  if (!message) return out;

  // Primary path: message.images[].image_url.url
  const images = message.images;
  if (Array.isArray(images)) {
    for (const item of images) {
      const url = readImageUrl(item);
      if (url) out.urls.push(url);
    }
  }

  // Fallback: scan message.content[] for image_url parts
  const content = message.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      const url = readImageUrl(part);
      if (url) out.urls.push(url);
    }
  } else if (typeof content === "string") {
    out.textContent = content;
  }

  return out;
}

function readImageUrl(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  if (rec.type !== undefined && rec.type !== "image_url") return undefined;
  const inner = rec.image_url as Record<string, unknown> | undefined;
  const url = inner?.url;
  return typeof url === "string" ? url : undefined;
}

/** Build a rich error message when the response had no images. */
export function formatNoImagesError(model: string, parsed: ParsedImageResponse): string {
  const parts: string[] = [
    `No images returned by '${model}' (finish_reason=${parsed.finishReason ?? "n/a"}).`,
  ];
  if (parsed.textContent) {
    parts.push(`Model said: "${truncate(parsed.textContent, 200)}".`);
  }
  parts.push(
    "Hint: verify the model supports image output and that 'modalities' includes 'image'.",
  );
  return parts.join(" ");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export interface BuildI2IPayloadOptions {
  prompt: string;
  model: string;
  refs: string[];
  /** Optional Recraft init-image strength, range 0..1. */
  strength?: number;
  /** Fallback model ids from OPENROUTER_FALLBACK_MODELS. */
  fallbackModels: string[];
}

/** Build the OpenRouter chat-completions payload for image-to-image. */
export function buildI2IPayload(opts: BuildI2IPayloadOptions): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = opts.refs.map((url) => ({
    type: "image_url",
    image_url: { url },
  }));
  content.push({ type: "text", text: opts.prompt });

  const payload: Record<string, unknown> = {
    messages: [{ role: "user", content }],
    modalities: resolveModalities(opts.model),
  };

  if (typeof opts.strength === "number") {
    payload.image_config = { strength: opts.strength };
  }

  if (opts.fallbackModels.length > 0) {
    payload.models = [opts.model, ...opts.fallbackModels];
  } else {
    payload.model = opts.model;
  }

  return payload;
}
