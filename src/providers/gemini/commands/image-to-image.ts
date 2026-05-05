/**
 * multix gemini image-to-image — edit/transform images using Gemini 2.5 Flash Image
 * (Nano Banana). Accepts 1+ reference images via --ref (path or URL) plus a prompt.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { resolveImageInput } from "../../../core/image-input.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import {
  type ContentPart,
  type GenerateContentRequest,
  extractImages,
  generateContent,
} from "../client.js";
import { IMAGE_MODEL_FALLBACK } from "../models.js";

// Gemini inline data has a practical ~7MB request cap. Stay well under that
// per-image so multi-ref still fits.
const SOFT_LIMIT_BYTES = 5 * 1024 * 1024;
const HARD_LIMIT_BYTES = 7 * 1024 * 1024;

export function registerGeminiImageToImageCommand(parent: Command): void {
  parent
    .command("image-to-image")
    .alias("i2i")
    .description(
      "Edit/compose images with Gemini 2.5 Flash Image (Nano Banana) using one or more reference images",
    )
    .requiredOption("--prompt <text>", "Text prompt describing the edit/transformation")
    .requiredOption(
      "--ref <path>",
      "Reference image (URL or local path); repeatable for multi-ref",
      collect,
      [] as string[],
    )
    .option("-m, --model <id>", `Gemini image model (default ${IMAGE_MODEL_FALLBACK})`)
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
        const model = opts.model ?? IMAGE_MODEL_FALLBACK;

        // Resolve refs → inlineData parts. URLs are downloaded by Gemini differently;
        // we always inline for consistent behavior across both URL and local refs.
        const parts: ContentPart[] = [];
        for (const r of opts.ref) {
          const resolved = await resolveImageInput(r, {
            logger,
            softLimitBytes: SOFT_LIMIT_BYTES,
            hardLimitBytes: HARD_LIMIT_BYTES,
          });
          if (resolved.kind === "url") {
            // Fetch the URL and inline the bytes — Gemini's REST endpoint expects
            // inlineData or fileData (uploaded). We pick inline to skip the upload step.
            const buf = await fetchUrlAsBuffer(resolved.url);
            const mime = sniffImageMime(buf, resolved.url);
            if (buf.byteLength > HARD_LIMIT_BYTES) {
              throw new Error(
                `Reference ${resolved.url} is ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB — exceeds Gemini ${HARD_LIMIT_BYTES / 1024 / 1024}MB inline cap.`,
              );
            }
            parts.push({ inlineData: { mimeType: mime, data: buf.toString("base64") } });
          } else {
            const data = resolved.dataUrl.split(",", 2)[1] ?? "";
            parts.push({ inlineData: { mimeType: resolved.mime, data } });
          }
        }
        parts.push({ text: opts.prompt });

        logger.debug(`Calling ${model} with ${opts.ref.length} reference image(s)`);

        const req: GenerateContentRequest = {
          model,
          contents: [{ parts }],
          generationConfig: { responseModalities: ["IMAGE"] },
        };

        const resp = await generateContent(req);
        const images = extractImages(resp);
        if (images.length === 0) {
          logger.error(
            "No images in response — model may have refused or doesn't support image output.",
          );
          process.exit(1);
        }

        const outDir = getOutputDir();
        const ts = Date.now();
        const saved: string[] = [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          if (!img) continue;
          const ext = img.mimeType.includes("png") ? "png" : "jpg";
          const dest = path.join(outDir, `gemini-i2i-${ts}-${i + 1}.${ext}`);
          fs.writeFileSync(dest, Buffer.from(img.data, "base64"));
          saved.push(dest);
          logger.success(`Saved: ${dest}`);
        }

        if (opts.output && saved[0]) {
          fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
          fs.copyFileSync(saved[0], opts.output);
          logger.success(`Copied to: ${opts.output}`);
        }

        console.log(`\nGenerated ${saved.length} image(s):`);
        for (const f of saved) console.log(`  ${f}`);
      },
    );
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

async function fetchUrlAsBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

// Sniff MIME from magic bytes; fall back to URL extension.
function sniffImageMime(buf: Buffer, url: string): string {
  if (buf.length >= 4) {
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
      return "image/png";
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
    if (
      buf.length >= 12 &&
      buf.slice(0, 4).toString() === "RIFF" &&
      buf.slice(8, 12).toString() === "WEBP"
    )
      return "image/webp";
  }
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}
