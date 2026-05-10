/**
 * multix openrouter image-to-image — edit/transform images via OpenRouter chat
 * completions multimodal API. Sends `image_url` content parts (URL or data:URL)
 * along with the text prompt.
 *
 * Default model: google/gemini-2.5-flash-image (Nano Banana via OR). Other good
 * choices: openai/gpt-image-1, black-forest-labs/flux-kontext-pro, recraft/recraft-v3.
 *
 * `--strength` is Recraft-specific (init-image strength 0..1).
 * `OPENROUTER_FALLBACK_MODELS` (CSV) is honored — when set, the request uses
 * `models: [primary, ...fallbacks]` so OpenRouter can route on availability.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { fetchBytes, httpJson } from "../../../core/http-client.js";
import { refUrl, resolveImageInput } from "../../../core/image-input.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { OPENROUTER_API_URL, requireOpenRouterKey } from "../client.js";
import {
  buildI2IPayload,
  buildOpenRouterHeaders,
  extractImagesFromResponse,
  formatNoImagesError,
} from "../payload.js";

const DEFAULT_MODEL = "google/gemini-2.5-flash-image";
const SOFT_LIMIT_BYTES = 5 * 1024 * 1024;
const HARD_LIMIT_BYTES = 8 * 1024 * 1024;

export function registerOpenRouterImageToImageCommand(parent: Command): void {
  parent
    .command("image-to-image")
    .alias("i2i")
    .description("Edit/transform images via OpenRouter (default: google/gemini-2.5-flash-image)")
    .requiredOption("--prompt <text>", "Text prompt describing the edit")
    .requiredOption(
      "--ref <path>",
      "Reference image (URL or local path); repeatable (most models accept 1)",
      collect,
      [] as string[],
    )
    .option("-m, --model <id>", `OpenRouter model id (default ${DEFAULT_MODEL})`)
    .option("--strength <n>", "Recraft init-image strength 0..1 (Recraft models only)")
    .option("--output <path>", "Save first generated image to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        ref: string[];
        model?: string;
        strength?: string;
        output?: string;
        verbose?: boolean;
      }) => {
        if (!opts.ref || opts.ref.length === 0) {
          throw new ValidationError("At least one --ref is required for image-to-image.");
        }
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const model = opts.model ?? resolveKey("OPENROUTER_IMAGE_MODEL") ?? DEFAULT_MODEL;
        const strength = parseStrength(opts.strength);

        const fallbackModels = (resolveKey("OPENROUTER_FALLBACK_MODELS") ?? "")
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);

        const resolvedRefs: string[] = [];
        for (const r of opts.ref) {
          const resolved = await resolveImageInput(r, {
            logger,
            softLimitBytes: SOFT_LIMIT_BYTES,
            hardLimitBytes: HARD_LIMIT_BYTES,
          });
          resolvedRefs.push(refUrl(resolved));
        }

        const strengthDbg = strength !== undefined ? `, strength=${strength}` : "";
        const fallbacksDbg = fallbackModels.length ? `, fallbacks=${fallbackModels.join(",")}` : "";
        logger.debug(
          `OpenRouter i2i: model=${model}, refs=${resolvedRefs.length}${strengthDbg}${fallbacksDbg}`,
        );

        const saved = await runImageToImage({
          prompt: opts.prompt,
          model,
          refs: resolvedRefs,
          strength,
          fallbackModels,
          output: opts.output,
          logger,
        });

        console.log(`\nGenerated ${saved.length} image(s):`);
        for (const f of saved) console.log(`  ${f}`);
        console.log(`Model used: ${model}`);
      },
    );
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function parseStrength(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new ValidationError(`--strength must be a number in [0,1], got '${raw}'`);
  }
  return n;
}

interface RunOpts {
  prompt: string;
  model: string;
  refs: string[];
  strength?: number;
  fallbackModels: string[];
  output?: string;
  logger: Logger;
}

async function runImageToImage(opts: RunOpts): Promise<string[]> {
  const apiKey = requireOpenRouterKey();
  const headers = buildOpenRouterHeaders(apiKey);
  const payload = buildI2IPayload({
    prompt: opts.prompt,
    model: opts.model,
    refs: opts.refs,
    strength: opts.strength,
    fallbackModels: opts.fallbackModels,
  });

  const data = await httpJson<unknown>({
    url: OPENROUTER_API_URL,
    method: "POST",
    headers,
    body: payload,
    timeoutMs: 240_000,
  });

  const parsed = extractImagesFromResponse(data);
  if (parsed.urls.length === 0) {
    throw new ProviderError(formatNoImagesError(opts.model, parsed), "openrouter");
  }

  const outDir = getOutputDir();
  const ts = Date.now();
  const saved: string[] = [];
  for (let i = 0; i < parsed.urls.length; i++) {
    const url = parsed.urls[i];
    if (!url) continue;
    const bytes = await fetchBytes(url);
    const dest = path.join(outDir, `openrouter-i2i-${ts}-${i + 1}.png`);
    fs.writeFileSync(dest, bytes);
    saved.push(dest);
    opts.logger.success(`Saved: ${dest}`);
  }

  if (opts.output && saved[0]) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.copyFileSync(saved[0], opts.output);
    opts.logger.success(`Copied to: ${opts.output}`);
  }

  return saved;
}
