/** Typed 3D presets built on the existing fal queue, upload and receipt machinery. */
import path from "node:path";
import type { Command } from "commander";
import { ValidationError, ProviderError } from "../../../core/errors.js";
import { parseJsonInput } from "../../../core/json-input.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { createFalClient, requireFalKey } from "../client.js";
import { uploadLocalFile } from "../local-files.js";
import { buildReceipt, persistReceipt } from "../request-receipt.js";
import { downloadResultMedia, extractMediaUrls, submitAndWait, submitFalRequest } from "../run-helpers.js";

interface Fal3dPreset {
  id: string; mode: "text" | "image" | "multi-image";
  field: "prompt" | "image_url" | "image_urls" | "input_image_url";
  maxImages: number;
}
export const FAL_3D_PRESETS: readonly Fal3dPreset[] = [
  { id: "tripo3d/h3.1/image-to-3d", mode: "image", field: "image_url", maxImages: 1 },
  { id: "tripo3d/h3.1/multiview-to-3d", mode: "multi-image", field: "image_urls", maxImages: 4 },
  { id: "tripo3d/h3.1/text-to-3d", mode: "text", field: "prompt", maxImages: 0 },
  { id: "hitem3d/hi3d/v3.0/image-to-3d", mode: "image", field: "image_url", maxImages: 1 },
  { id: "hitem3d/hi3d/image-to-3d", mode: "image", field: "image_url", maxImages: 1 },
  { id: "fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d", mode: "image", field: "input_image_url", maxImages: 1 },
  { id: "fal-ai/hunyuan-3d/v3.1/rapid/text-to-3d", mode: "text", field: "prompt", maxImages: 0 },
  { id: "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d", mode: "image", field: "input_image_url", maxImages: 1 },
  { id: "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d", mode: "text", field: "prompt", maxImages: 0 },
  ...(["v7", "v7.1"] as const).flatMap((version) => [
    { id: "meshy/" + version + "/image-to-3d", mode: "image" as const, field: "image_url" as const, maxImages: 1 },
    { id: "meshy/" + version + "/multi-image-to-3d", mode: "multi-image" as const, field: "image_urls" as const, maxImages: 4 },
    { id: "meshy/" + version + "/text-to-3d", mode: "text" as const, field: "prompt" as const, maxImages: 0 },
  ]),
];

export function buildFal3dInput(model: string, prompt: string | undefined, refs: readonly string[], extras: Record<string, unknown> = {}): Record<string, unknown> {
  const preset = FAL_3D_PRESETS.find((item) => item.id === model);
  if (!preset) throw new ValidationError("Unsupported fal 3D preset. Use fal run for other models.");
  if (preset.mode === "text") {
    if (!prompt || refs.length) throw new ValidationError("Text-to-3D needs a prompt and no --ref");
    return { ...extras, prompt };
  }
  if (prompt) throw new ValidationError("Image-to-3D model does not take a text prompt");
  const min = preset.mode === "multi-image" ? 2 : 1;
  if (refs.length < min || refs.length > preset.maxImages) throw new ValidationError("Model expects " + min + "-" + preset.maxImages + " reference images");
  return { ...extras, [preset.field]: preset.mode === "multi-image" ? [...refs] : refs[0] };
}

const collect = (value: string, previous: string[]) => [...previous, value];
export function registerFal3dCommand(parent: Command): void {
  parent.command("3d [prompt]")
    .description("3D via fal.ai: Tripo H3.1, Hi3D v3/v2.1, Hunyuan 3.1 and Meshy v7/v7.1")
    .option("-m, --model <id>", "Model preset; defaults to Tripo H3.1 image/text")
    .option("--ref <path|url>", "Reference image, repeat for multi-image models", collect, [])
    .option("--input <json>", "Additional model-specific input JSON or @file.json")
    .option("--detach", "Submit and print resumable receipt")
    .option("--no-download", "Print result JSON instead of files")
    .option("--output-dir <dir>", "Destination directory")
    .option("--wait-timeout <ms>", "Polling timeout in milliseconds", "900000")
    .option("-v, --verbose", "Verbose logging")
    .action(async (prompt: string | undefined, opts: {
      model?: string; ref: string[]; input?: string; detach?: boolean; download: boolean;
      outputDir?: string; waitTimeout: string; verbose?: boolean;
    }) => {
      const model = opts.model ?? (opts.ref.length ? "tripo3d/h3.1/image-to-3d" : "tripo3d/h3.1/text-to-3d");
      buildFal3dInput(model, prompt, opts.ref); // reject invalid shape before upload/billing
      const logger = createLogger({ verbose: !!opts.verbose, stderr: true });
      const extra = opts.input ? parseJsonInput(opts.input) : {};
      const refs = await Promise.all(opts.ref.map(async (ref) => {
        if (ref.startsWith("https://")) return ref;
        if (ref.includes("://")) throw new ValidationError("Use a local file or https:// image URL");
        return (await uploadLocalFile(ref, requireFalKey(), logger)).url;
      }));
      const input = buildFal3dInput(model, prompt, refs, extra);
      const outDir = opts.outputDir ? path.resolve(opts.outputDir) : getOutputDir();
      if (opts.detach) {
        const submitted = await submitFalRequest(createFalClient(), model, input, logger);
        const receipt = persistReceipt(buildReceipt({ model, requestId: submitted.request_id, status: submitted.status, input }), undefined, logger);
        console.log(JSON.stringify(receipt, null, 2));
        return;
      }
      const { requestId, result } = await submitAndWait({ model, input, logger, waitTimeoutMs: Number(opts.waitTimeout), download: opts.download });
      if (opts.download === false) { console.log(JSON.stringify(result, null, 2)); return; }
      const urls = [...new Set(extractMediaUrls(result))];
      if (!urls.length) throw new ProviderError("fal 3D completed without downloadable media", "fal");
      const saved = await downloadResultMedia(urls, outDir, requestId, logger);
      if (!saved.length) throw new ProviderError("fal 3D download failed", "fal");
      console.log(JSON.stringify({ request_id: requestId, model, files: saved }, null, 2));
    });
}
