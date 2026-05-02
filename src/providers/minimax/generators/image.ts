/**
 * MiniMax image generation — wraps image_generation endpoint.
 * Mirrors generate_image() in minimax_generate.py.
 */

import fs from "node:fs";
import path from "node:path";
import { getOutputDir } from "../../../core/output-dir.js";
import { fetchBytes } from "../../../core/http-client.js";
import { ProviderError } from "../../../core/errors.js";
import { apiPost } from "../client.js";
import type { Logger } from "../../../core/logger.js";

interface ImageGenerationResponse {
  data?: { image_urls?: string[] };
  base_resp?: { status_code?: number; status_msg?: string };
}

export interface ImageResult {
  status: "success" | "error";
  generatedImages?: string[];
  model?: string;
  error?: string;
}

export async function generateMinimaxImage(opts: {
  apiKey: string;
  prompt: string;
  model?: string;
  aspectRatio?: string;
  numImages?: number;
  output?: string;
  logger?: Logger;
}): Promise<ImageResult> {
  const {
    apiKey,
    prompt,
    model = "image-01",
    aspectRatio = "1:1",
    numImages = 1,
    output,
    logger,
  } = opts;

  const payload = {
    model,
    prompt,
    aspect_ratio: aspectRatio,
    n: Math.min(numImages, 9),
    response_format: "url",
    prompt_optimizer: true,
  };

  logger?.debug(`Generating ${numImages} image(s) with ${model}`);

  let resp: ImageGenerationResponse;
  try {
    resp = await apiPost<ImageGenerationResponse>("image_generation", payload, apiKey, { logger });
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const imageUrls = resp.data?.image_urls ?? [];
  if (imageUrls.length === 0) {
    return { status: "error", error: "No images in response" };
  }

  const outDir = getOutputDir();
  const savedFiles: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    if (!url) continue;
    try {
      const bytes = await fetchBytes(url);
      const fname = `minimax_image_${Date.now()}_${i}.png`;
      const dest = path.join(outDir, fname);
      fs.writeFileSync(dest, bytes);
      savedFiles.push(dest);
      logger?.success(`Saved: ${dest}`);
    } catch (e) {
      throw new ProviderError(`Failed to download image: ${e instanceof Error ? e.message : String(e)}`, "minimax");
    }
  }

  if (output && savedFiles[0]) {
    fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
    fs.copyFileSync(savedFiles[0], output);
  }

  return { status: "success", generatedImages: savedFiles, model };
}
