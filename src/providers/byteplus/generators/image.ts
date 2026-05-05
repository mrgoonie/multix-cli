/**
 * Seedream image generation — sync POST /images/generations.
 * Resolves --input-image (URL or local) to URL or data: form,
 * downloads result(s) to MULTIX_OUTPUT_DIR.
 */

import fs from "node:fs";
import path from "node:path";
import { downloadFile } from "../../../core/http-client.js";
import { refUrl, resolveImageInput } from "../../../core/image-input.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import type { BytePlusClient } from "../client.js";
import { BYTEPLUS_DEFAULTS } from "../models.js";
import type { ImageGenerationRequest, ImageGenerationResponse } from "../types.js";

export interface GenerateImageOptions {
  prompt: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
  numImages?: number;
  seed?: number;
  watermark?: boolean;
  inputImages?: string[];
  output?: string;
  logger?: Logger;
}

export interface SavedFile {
  path: string;
  url: string;
  seed?: number;
}

const ASPECT_TO_SIZE: Record<string, string> = {
  "1:1": "2048x2048",
  "16:9": "2560x1440",
  "9:16": "1440x2560",
  "4:3": "2048x1536",
  "3:4": "1536x2048",
  "21:9": "2560x1080",
  "3:2": "2048x1365",
  "2:3": "1365x2048",
};

function resolveSize(opts: GenerateImageOptions): string | undefined {
  if (opts.size && opts.aspectRatio) {
    opts.logger?.warn("Both --size and --aspect-ratio given; using --size.");
    return opts.size;
  }
  if (opts.size) return opts.size;
  if (opts.aspectRatio) {
    const mapped = ASPECT_TO_SIZE[opts.aspectRatio];
    if (!mapped) {
      throw new Error(
        `Unsupported --aspect-ratio '${opts.aspectRatio}'. Supported: ${Object.keys(ASPECT_TO_SIZE).join(", ")}`,
      );
    }
    return mapped;
  }
  return BYTEPLUS_DEFAULTS.imageSize;
}

export async function generateSeedream(
  client: BytePlusClient,
  opts: GenerateImageOptions,
): Promise<SavedFile[]> {
  const logger = opts.logger;
  const model = opts.model ?? BYTEPLUS_DEFAULTS.imageModel;

  const resolvedInputs: string[] = [];
  for (const input of opts.inputImages ?? []) {
    const r = await resolveImageInput(input, logger);
    resolvedInputs.push(refUrl(r));
  }

  const body: ImageGenerationRequest = {
    model,
    prompt: opts.prompt,
    response_format: "url",
    n: opts.numImages ?? 1,
    watermark: opts.watermark ?? true,
    size: resolveSize(opts),
  };
  if (resolvedInputs.length > 0) body.image = resolvedInputs;
  if (opts.seed !== undefined) body.seed = opts.seed;

  logger?.debug(
    `Seedream body: ${JSON.stringify({ ...body, image: body.image ? `[${body.image.length}]` : undefined })}`,
  );

  const res = await client.post<ImageGenerationResponse>("/images/generations", body, logger);

  const items = res.data ?? [];
  const ts = Date.now();
  const outDir = getOutputDir();
  const saved: SavedFile[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    const url = item.url;
    if (!url) {
      logger?.warn(`Image ${i + 1}: no URL in response (b64_json fallback not yet supported).`);
      continue;
    }
    const ext = (() => {
      try {
        const e = path.extname(new URL(url).pathname);
        return e || ".jpg";
      } catch {
        return ".jpg";
      }
    })();
    const filename =
      opts.output && items.length === 1
        ? path.resolve(opts.output)
        : path.join(outDir, `byteplus-image-${ts}-${i + 1}${ext}`);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    await downloadFile(url, filename);
    saved.push({ path: filename, url, seed: item.seed });
    logger?.success(`Saved ${filename}`);
  }

  return saved;
}
