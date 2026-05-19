import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "../../core/errors.js";
import { fetchBytes } from "../../core/http-client.js";
import { isHttpUrl } from "../../core/image-input.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import { fileFromPath, postOpenAIForm, postOpenAIJson, requireOpenAIKey } from "./client.js";
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  type OpenAIImageOutputFormat,
  type OpenAIImageQuality,
  type OpenAIImageSize,
  extFromImageFormat,
} from "./models.js";

interface ImageData {
  b64_json?: string;
}

interface ImageResponse {
  data?: ImageData[];
}

export interface ImageRefBytes {
  filename: string;
  bytes: Buffer;
  mime: string;
}

export function buildImageGenerationBody(opts: {
  prompt: string;
  model?: string;
  size?: OpenAIImageSize;
  quality?: OpenAIImageQuality;
  outputFormat: OpenAIImageOutputFormat;
  numImages?: number;
}): Record<string, unknown> {
  return {
    model: opts.model ?? DEFAULT_OPENAI_IMAGE_MODEL,
    prompt: opts.prompt,
    size: opts.size ?? "1024x1024",
    quality: opts.quality ?? "medium",
    output_format: opts.outputFormat,
    n: opts.numImages ?? 1,
  };
}

export async function buildImageEditForm(opts: {
  prompt: string;
  refs: ImageRefBytes[];
  model: string;
  size: OpenAIImageSize;
  quality: OpenAIImageQuality;
  outputFormat: OpenAIImageOutputFormat;
}): Promise<FormData> {
  const form = new FormData();
  form.append("model", opts.model);
  form.append("prompt", opts.prompt);
  form.append("size", opts.size);
  form.append("quality", opts.quality);
  form.append("output_format", opts.outputFormat);
  for (const ref of opts.refs) {
    form.append("image[]", new File([new Uint8Array(ref.bytes)], ref.filename, { type: ref.mime }));
  }
  return form;
}

export function saveOpenAIImages(opts: {
  data?: ImageData[];
  task: string;
  format: OpenAIImageOutputFormat;
  output?: string;
  logger?: Logger;
}): string[] {
  const items = opts.data ?? [];
  if (items.length === 0) throw new ProviderError("No images in OpenAI response", "openai");
  const outDir = getOutputDir();
  const ext = extFromImageFormat(opts.format);
  const ts = Date.now();
  const saved: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const b64 = items[i]?.b64_json;
    if (!b64) throw new ProviderError("No b64_json in OpenAI image response", "openai");
    const dest = path.join(outDir, `openai-${opts.task}-${ts}-${i + 1}.${ext}`);
    fs.writeFileSync(dest, Buffer.from(b64, "base64"));
    saved.push(dest);
    opts.logger?.success(`Saved: ${dest}`);
  }
  if (opts.output && saved[0]) {
    fs.mkdirSync(path.dirname(path.resolve(opts.output)), { recursive: true });
    fs.copyFileSync(saved[0], opts.output);
    opts.logger?.success(`Copied to: ${opts.output}`);
  }
  return saved;
}

export async function resolveImageRefBytes(ref: string): Promise<ImageRefBytes> {
  if (isHttpUrl(ref)) {
    const bytes = await fetchBytes(ref);
    const pathname = new URL(ref).pathname;
    const filename = path.basename(pathname) || "reference.png";
    return { filename, bytes, mime: sniffImageMime(bytes, filename) };
  }
  const file = fileFromPath(ref);
  const bytes = Buffer.from(await file.arrayBuffer());
  return { filename: file.name, bytes, mime: file.type || sniffImageMime(bytes, file.name) };
}

export async function generateOpenAIImage(opts: {
  prompt: string;
  model?: string;
  size?: OpenAIImageSize;
  quality?: OpenAIImageQuality;
  outputFormat: OpenAIImageOutputFormat;
  numImages?: number;
  output?: string;
  logger?: Logger;
}): Promise<string[]> {
  const data = await postOpenAIJson<ImageResponse>(
    "/images/generations",
    buildImageGenerationBody(opts),
    requireOpenAIKey(),
  );
  return saveOpenAIImages({
    data: data.data,
    task: "image",
    format: opts.outputFormat,
    output: opts.output,
    logger: opts.logger,
  });
}

export async function editOpenAIImage(opts: {
  prompt: string;
  refs: string[];
  model?: string;
  size?: OpenAIImageSize;
  quality?: OpenAIImageQuality;
  outputFormat: OpenAIImageOutputFormat;
  output?: string;
  logger?: Logger;
}): Promise<string[]> {
  const refs = await Promise.all(opts.refs.map((ref) => resolveImageRefBytes(ref)));
  const form = await buildImageEditForm({
    prompt: opts.prompt,
    refs,
    model: opts.model ?? DEFAULT_OPENAI_IMAGE_MODEL,
    size: opts.size ?? "1024x1024",
    quality: opts.quality ?? "medium",
    outputFormat: opts.outputFormat,
  });
  const data = await postOpenAIForm<ImageResponse>("/images/edits", form, requireOpenAIKey());
  return saveOpenAIImages({
    data: data.data,
    task: "image-edit",
    format: opts.outputFormat,
    output: opts.output,
    logger: opts.logger,
  });
}

function sniffImageMime(buf: Buffer, name: string): string {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP")
    return "image/webp";
  const ext = path.extname(name).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}
