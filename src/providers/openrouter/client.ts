/**
 * OpenRouter client for image generation via chat completions API.
 * Mirrors openrouter_generate.py exactly.
 * Docs: https://openrouter.ai/docs/guides/overview/multimodal/image-generation
 */

import fs from "node:fs";
import path from "node:path";
import { resolveKey } from "../../core/env-loader.js";
import { ConfigError, ProviderError } from "../../core/errors.js";
import { fetchBytes, httpJson } from "../../core/http-client.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import {
  buildOpenRouterHeaders,
  extractImagesFromResponse,
  formatNoImagesError,
  resolveModalities,
} from "./payload.js";

export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3.1-flash-image-preview";

/** Heuristic: model id contains "/" and is not a URL. */
export function isOpenRouterModel(model: string): boolean {
  return model.includes("/") && !model.startsWith("http://") && !model.startsWith("https://");
}

/** Resolve OPENROUTER_API_KEY or throw. */
export function requireOpenRouterKey(): string {
  const key = resolveKey("OPENROUTER_API_KEY");
  if (!key) {
    throw new ConfigError(
      "OPENROUTER_API_KEY is not set. Get one at https://openrouter.ai/settings/keys",
    );
  }
  return key;
}

export interface GeneratePayload {
  prompt: string;
  model: string;
  aspectRatio: string;
  imageSize?: string;
  fallbackModels: string[];
}

function buildPayload(opts: GeneratePayload): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    messages: [{ role: "user", content: opts.prompt }],
    modalities: resolveModalities(opts.model),
    image_config: { aspect_ratio: opts.aspectRatio },
  };

  if (opts.imageSize) {
    (payload.image_config as Record<string, string>).image_size = opts.imageSize;
  }

  if (opts.fallbackModels.length > 0) {
    payload.models = [opts.model, ...opts.fallbackModels];
  } else {
    payload.model = opts.model;
  }

  return payload;
}

export interface GenerateImageResult {
  status: "success" | "error";
  generatedImages?: string[];
  model?: string;
  error?: string;
}

/**
 * Generate one or more images with OpenRouter.
 * Loops until numImages are collected (one request per image as per Python source).
 */
export async function generateOpenRouterImage(opts: {
  prompt: string;
  model: string;
  aspectRatio?: string;
  imageSize?: string;
  numImages?: number;
  output?: string;
  logger?: Logger;
}): Promise<GenerateImageResult> {
  const { prompt, model, aspectRatio = "1:1", imageSize, numImages = 1, output, logger } = opts;

  const apiKey = requireOpenRouterKey();
  const fallbackModels = (resolveKey("OPENROUTER_FALLBACK_MODELS") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  const imageUrls: string[] = [];
  let usedModel = model;

  for (let i = 0; i < Math.max(1, numImages); i++) {
    const payload = buildPayload({ prompt, model, aspectRatio, imageSize, fallbackModels });

    logger?.debug(
      `OpenRouter model: ${model}${fallbackModels.length ? ` (fallbacks: ${fallbackModels.join(", ")})` : ""}`,
    );

    let data: unknown;
    try {
      data = await httpJson<unknown>({
        url: OPENROUTER_API_URL,
        method: "POST",
        headers: buildOpenRouterHeaders(apiKey),
        body: payload,
        timeoutMs: 240_000,
      });
    } catch (e) {
      return { status: "error", error: e instanceof Error ? e.message : String(e) };
    }

    const parsed = extractImagesFromResponse(data);
    if (parsed.urls.length === 0) {
      return { status: "error", error: formatNoImagesError(model, parsed) };
    }

    imageUrls.push(...parsed.urls);
    usedModel = parsed.model ?? usedModel;
    if (imageUrls.length >= numImages) break;
  }

  // Save images to output dir
  const outDir = getOutputDir();
  const savedFiles: string[] = [];

  for (let i = 0; i < Math.min(imageUrls.length, Math.max(1, numImages)); i++) {
    const url = imageUrls[i];
    if (!url) continue;
    try {
      const bytes = await fetchBytes(url);
      const dest = path.join(outDir, `openrouter_image_${Date.now()}_${i}.png`);
      fs.writeFileSync(dest, bytes);
      savedFiles.push(dest);
      logger?.success(`Saved: ${dest}`);
    } catch (e) {
      throw new ProviderError(
        `Failed to save image: ${e instanceof Error ? e.message : String(e)}`,
        "openrouter",
      );
    }
  }

  if (output && savedFiles[0]) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.writeFileSync(output, fs.readFileSync(savedFiles[0]));
  }

  return { status: "success", generatedImages: savedFiles, model: usedModel };
}
