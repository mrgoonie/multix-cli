/**
 * Command options -> generate body, shared by the commands and the
 * pre-flight estimate so `--estimate` prices exactly what would be sent.
 */

import type { Command } from "commander";
import { ValidationError } from "../../../core/errors.js";
import { requireCatalogModel } from "../catalog.js";
import { buildImageBody, buildVideoBody } from "../request.js";
import type { SumeCatalogModel, SumeRouter } from "../types.js";
import { type SumeCatalogRead, loadSumeCatalog } from "./catalog-cache.js";
import { sumeBaseUrl } from "./env.js";

export interface SumeImageCliOpts {
  model?: string;
  image?: string[];
  aspectRatio?: string;
  resolution?: string;
  quality?: string;
  numImages?: string;
  outputFormat?: string;
}

export interface SumeVideoCliOpts {
  model?: string;
  image?: string;
  endImage?: string;
  refImage?: string[];
  refVideo?: string[];
  refAudio?: string[];
  video?: string;
  audio?: string;
  duration?: string;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
}

export const collect = (value: string, prev: string[]) => [...prev, value];

export function addImageRequestOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-m, --model <id>", "Sume model id from `multix sume models --kind image`")
    .option(
      "--image <pathOrUrl>",
      "Image to edit (https URL or local file; repeat for several)",
      collect,
      [],
    )
    .option("--aspect-ratio <ratio>", "Aspect ratio the model lists (e.g. 1:1, 16:9)")
    .option("--resolution <res>", "Resolution the model lists (e.g. 1K, 2K)")
    .option("--quality <q>", "Quality the model lists (e.g. low, medium, high)")
    .option("-n, --num-images <n>", "Images to generate (up to the model's max_images)")
    .option("--output-format <fmt>", "Output format the model lists (e.g. png, jpeg, webp)");
}

export function addVideoRequestOptions(cmd: Command): Command {
  return cmd
    .requiredOption("-m, --model <id>", "Sume model id from `multix sume models --kind video`")
    .option("--image <pathOrUrl>", "First frame (image-to-video, or the face for image lipsync)")
    .option("--end-image <pathOrUrl>", "Last frame")
    .option("--ref-image <pathOrUrl>", "Reference image (repeatable)", collect, [])
    .option("--ref-video <pathOrUrl>", "Reference video (repeatable)", collect, [])
    .option("--ref-audio <pathOrUrl>", "Reference audio (repeatable)", collect, [])
    .option("--video <pathOrUrl>", "Source video (video-to-video, lipsync)")
    .option("--audio <pathOrUrl>", "Speech track for a lipsync model")
    .option("--duration <seconds>", "Length in seconds, within the model's range")
    .option("--resolution <res>", "Resolution the model lists (e.g. 720p)")
    .option("--aspect-ratio <ratio>", "Aspect ratio the model lists (e.g. 16:9)")
    .option("--generate-audio", "Ask for native audio (models with audio)")
    .option("--no-generate-audio", "Ask for a silent clip (models with audio)");
}

function positiveNumber(
  raw: string | undefined,
  flag: string,
  integer: boolean,
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new ValidationError(
      `${flag} must be a positive ${integer ? "integer" : "number"}, got "${raw}"`,
    );
  }
  return n;
}

export function imageBodyFrom(
  model: SumeCatalogModel,
  prompt: string | undefined,
  o: SumeImageCliOpts,
) {
  return buildImageBody(model, {
    prompt,
    images: o.image ?? [],
    aspectRatio: o.aspectRatio,
    resolution: o.resolution,
    quality: o.quality,
    numImages: positiveNumber(o.numImages, "--num-images", true),
    outputFormat: o.outputFormat,
  });
}

export function videoBodyFrom(
  model: SumeCatalogModel,
  prompt: string | undefined,
  o: SumeVideoCliOpts,
) {
  return buildVideoBody(model, {
    prompt,
    image: o.image,
    endImage: o.endImage,
    refImages: o.refImage ?? [],
    refVideos: o.refVideo ?? [],
    refAudios: o.refAudio ?? [],
    video: o.video,
    audio: o.audio,
    duration: positiveNumber(o.duration, "--duration", false),
    resolution: o.resolution,
    aspectRatio: o.aspectRatio,
    generateAudio: o.generateAudio,
  });
}

export interface PlannedRequest {
  catalog: SumeCatalogRead;
  model: SumeCatalogModel;
  body: Record<string, unknown>;
}

/**
 * Load the catalog and build the checked body. Without a usable catalog
 * nothing can be confirmed, so nothing is sent.
 */
export async function planRequest(
  router: SumeRouter,
  prompt: string | undefined,
  opts: SumeImageCliOpts | SumeVideoCliOpts,
  fetch?: typeof globalThis.fetch,
): Promise<PlannedRequest> {
  const modelId = opts.model?.trim();
  if (!modelId) throw new ValidationError("--model <id> is required (see: multix sume models)");
  const catalog = await loadSumeCatalog({ baseUrl: sumeBaseUrl(), ...(fetch ? { fetch } : {}) });
  if (catalog.source.state === "unavailable") {
    throw new ValidationError(
      `The Sume model catalog is unavailable (${catalog.source.error}), so ${modelId}'s inputs cannot be checked; nothing was sent. Retry, or run: multix sume models --refresh`,
    );
  }
  const model = requireCatalogModel(catalog.models, modelId, router);
  const body =
    router === "image"
      ? imageBodyFrom(model, prompt, opts as SumeImageCliOpts)
      : videoBodyFrom(model, prompt, opts as SumeVideoCliOpts);
  return { catalog, model, body };
}
