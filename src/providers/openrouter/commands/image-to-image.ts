/**
 * multix openrouter image-to-image — edit/transform images via OpenRouter chat
 * completions multimodal API. Sends `image_url` content parts (URL or data:URL)
 * along with the text prompt.
 *
 * Default model: google/gemini-2.5-flash-image (Nano Banana via OR). Other good
 * choices: black-forest-labs/flux-kontext-pro / -max.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolveKey } from "../../../core/env-loader.js";
import { ProviderError } from "../../../core/errors.js";
import { fetchBytes, httpJson } from "../../../core/http-client.js";
import { refUrl, resolveImageInput } from "../../../core/image-input.js";
import { type Logger, createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { OPENROUTER_API_URL, requireOpenRouterKey } from "../client.js";

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
    .option("--output <path>", "Save first generated image to this path")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        prompt: string;
        ref: string[];
        model?: string;
        output?: string;
        verbose?: boolean;
      }) => {
        if (!opts.ref || opts.ref.length === 0) {
          throw new Error("At least one --ref is required for image-to-image.");
        }
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const model = opts.model ?? resolveKey("OPENROUTER_IMAGE_MODEL") ?? DEFAULT_MODEL;

        const resolvedRefs: string[] = [];
        for (const r of opts.ref) {
          const resolved = await resolveImageInput(r, {
            logger,
            softLimitBytes: SOFT_LIMIT_BYTES,
            hardLimitBytes: HARD_LIMIT_BYTES,
          });
          resolvedRefs.push(refUrl(resolved));
        }

        logger.debug(`OpenRouter i2i: model=${model}, refs=${resolvedRefs.length}`);

        const saved = await runImageToImage({
          prompt: opts.prompt,
          model,
          refs: resolvedRefs,
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

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { images?: Array<{ image_url?: { url?: string } }> };
  }>;
  model?: string;
}

interface RunOpts {
  prompt: string;
  model: string;
  refs: string[];
  output?: string;
  logger: Logger;
}

async function runImageToImage(opts: RunOpts): Promise<string[]> {
  const apiKey = requireOpenRouterKey();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  const referer = resolveKey("OPENROUTER_SITE_URL");
  const title = resolveKey("OPENROUTER_APP_NAME") ?? "multix";
  if (referer) headers["HTTP-Referer"] = referer;
  if (title) headers["X-Title"] = title;

  const content: Array<Record<string, unknown>> = opts.refs.map((url) => ({
    type: "image_url",
    image_url: { url },
  }));
  content.push({ type: "text", text: opts.prompt });

  const payload: Record<string, unknown> = {
    model: opts.model,
    messages: [{ role: "user", content }],
    modalities: opts.model.includes("gemini") ? ["image", "text"] : ["image"],
  };

  const data = await httpJson<ChatCompletionResponse>({
    url: OPENROUTER_API_URL,
    method: "POST",
    headers,
    body: payload,
    timeoutMs: 240_000,
  });

  const messageImages = data.choices?.[0]?.message?.images ?? [];
  if (messageImages.length === 0) {
    throw new ProviderError(
      `No images in response — model '${opts.model}' may not support image-to-image`,
      "openrouter",
    );
  }

  const outDir = getOutputDir();
  const ts = Date.now();
  const saved: string[] = [];
  for (let i = 0; i < messageImages.length; i++) {
    const url = messageImages[i]?.image_url?.url;
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
