/**
 * Shared Atlas Cloud prediction lifecycle for CLI commands:
 * schema loading, submit -> (async exit | bounded poll) -> terminal check ->
 * output delivery (text printed, media downloaded with normalized names,
 * images finalized to WebP like other providers, video thumbnails).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { downloadFile } from "../../../core/http-client.js";
import {
  finalizeGeneratedImages,
  imageFormatOption,
  noWebpOption,
} from "../../../core/image-webp-finalize.js";
import type { Logger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { redactUrl } from "../../../core/redact.js";
import { maybeDownloadThumb } from "../../../core/video-thumb.js";
import { ATLAS_PROVIDER, type AtlasCloudClient, assertPredictionSucceeded } from "../client.js";
import {
  type OutputCategory,
  classifyOutputs,
  defaultExtensionFor,
  hasNsfwFlag,
  isTerminalStatus,
  outputCategory,
  outputExtension,
  outputFileName,
} from "../prediction-output.js";
import type { AtlasMediaKind, AtlasModelSpec, AtlasPrediction } from "../types.js";

export interface RunCliOpts {
  async?: boolean;
  waitTimeout?: string;
  output?: string;
  /** commander `--no-download` sets false. */
  download?: boolean;
  /** commander `--no-validate` sets false. */
  validate?: boolean;
  /** commander `--no-thumb` sets false. */
  thumb?: boolean;
  imageFormat?: string;
  webp?: boolean;
  verbose?: boolean;
}

/** Add the lifecycle/output flags shared by every generation command. */
export function addRunOptions(
  cmd: Command,
  cfg: { waitTimeoutMs: number; images?: boolean; video?: boolean },
): Command {
  cmd
    .option("--async", "Submit and exit; print the prediction id (resume with `atlas status`)")
    .option("--wait-timeout <ms>", "Max time to wait for completion", String(cfg.waitTimeoutMs))
    .option("--output <path>", "Output file (single output) or directory (path without extension)")
    .option("--no-download", "Do not download media; print output URLs instead")
    .option("--no-validate", "Skip client-side validation against the model's published schema");
  if (cfg.images) cmd.addOption(imageFormatOption()).addOption(noWebpOption());
  if (cfg.video) cmd.option("--no-thumb", "Skip downloading the video thumbnail if present");
  return cmd.option("-v, --verbose", "Verbose logging");
}

export function parseTimeoutMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`--wait-timeout must be a positive integer (ms), got "${raw}"`);
  }
  return n;
}

const KIND_COMMAND: Record<AtlasMediaKind, string> = {
  image: "image",
  video: "video",
  audio: "audio",
};

/**
 * Load the model's published schema for validation. Never fatal: when the
 * schema is unavailable the request is sent as built, with a warning.
 */
export async function loadModelSpec(
  client: AtlasCloudClient,
  model: string,
  logger: Logger,
  validate: boolean | undefined,
): Promise<AtlasModelSpec | undefined> {
  if (validate === false) return undefined;
  try {
    const spec = await client.getModelSpec(model);
    if (!spec) {
      logger.warn(
        `Model ${model} is not in the Atlas Cloud public catalog or has no published schema; sending without validation.`,
      );
    }
    return spec;
  } catch (e) {
    logger.warn(
      `Could not load the schema for ${model} (${e instanceof Error ? e.message : String(e)}); sending without validation.`,
    );
    return undefined;
  }
}

/** Reject a model whose schema says it is served by a different endpoint. */
export function assertEndpoint(
  spec: AtlasModelSpec | undefined,
  expected: AtlasMediaKind,
  model: string,
): void {
  if (!spec?.endpoint || spec.endpoint === expected) return;
  throw new ValidationError(
    `Model ${model} is a ${spec.endpoint} model (served by generate${capitalize(spec.endpoint)}), not ${expected}. ` +
      `Use \`multix atlas ${KIND_COMMAND[spec.endpoint]} ...\` or \`multix atlas run ${model} --type ${spec.endpoint} --input '{...}'\`.`,
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface ExecuteOptions {
  client: AtlasCloudClient;
  logger: Logger;
  kind: AtlasMediaKind;
  model: string;
  body: Record<string, unknown>;
  opts: RunCliOpts;
  /** Expected output kind; used only for the extension of URLs that carry none. */
  hint?: OutputCategory;
  defaultWaitTimeoutMs: number;
  pollIntervalMs?: number;
}

export interface ExecuteResult {
  predictionId: string;
  prediction?: AtlasPrediction;
  files: string[];
  texts: string[];
}

export function resumeCommand(id: string): string {
  return `multix atlas status ${id} --wait --download`;
}

/** Submit, then either exit with the id (--async) or wait, verify, and deliver outputs. */
export async function executePrediction(o: ExecuteOptions): Promise<ExecuteResult> {
  const { client, logger, opts } = o;
  const timeoutMs = parseTimeoutMs(opts.waitTimeout, o.defaultWaitTimeoutMs);
  logger.info(`Submitting to ${o.model} (generate${capitalize(o.kind)})...`);
  const submitted = await client.submit(o.kind, { ...o.body, model: o.model });
  const id = submitted.id;

  if (opts.async) {
    console.log(id);
    console.error(`Prediction submitted. Resume with: ${resumeCommand(id)}`);
    return { predictionId: id, files: [], texts: [] };
  }

  logger.info(`Prediction ${id} — waiting up to ${Math.round(timeoutMs / 1000)}s...`);
  const final = isTerminalStatus(submitted.status)
    ? submitted
    : await client.waitForPrediction(id, {
        timeoutMs,
        intervalMs: o.pollIntervalMs,
        resumeHint: `Resume with: ${resumeCommand(id)}`,
        onPoll: (p, n) => logger.debug(`poll ${n}: ${p.status}`),
      });
  assertPredictionSucceeded(final);
  const delivered = await deliverPrediction(final, { logger, opts, hint: o.hint });
  return { predictionId: id, prediction: final, ...delivered };
}

/** `--output` names a directory: trailing separator, no extension, or an existing directory. */
export function isDirectoryOutput(output: string): boolean {
  return (
    /[\\/]$/.test(output) ||
    path.extname(output) === "" ||
    (fs.existsSync(output) && fs.statSync(output).isDirectory())
  );
}

/**
 * Plan local paths for media outputs. Without --output: the output dir with
 * `atlas-<id>-NN.<ext>`. --output without an extension (or an existing
 * directory) is a directory; with an extension it is the file for a single
 * output, or the `<base>-NN.<ext>` stem for several.
 */
export function planOutputPaths(
  urls: string[],
  cfg: { predictionId: string; outDir: () => string; output?: string; hint?: OutputCategory },
): string[] {
  const exts = urls.map((u) => {
    const cat = outputCategory(u);
    return (
      outputExtension(u) ?? defaultExtensionFor(cat !== "unknown" ? cat : (cfg.hint ?? "unknown"))
    );
  });
  const output = cfg.output;
  if (!output || isDirectoryOutput(output)) {
    const dir = output ? path.resolve(output) : cfg.outDir();
    return exts.map((ext, i) => path.join(dir, outputFileName(cfg.predictionId, i, ext)));
  }
  const abs = path.resolve(output);
  if (urls.length === 1) return [abs];
  const base = abs.slice(0, -path.extname(abs).length);
  return exts.map((ext, i) => `${base}-${String(i + 1).padStart(2, "0")}.${ext}`);
}

/** Print text outputs, download media outputs, and finalize images/videos. */
export async function deliverPrediction(
  prediction: AtlasPrediction,
  cfg: { logger: Logger; opts: RunCliOpts; hint?: OutputCategory },
): Promise<{ files: string[]; texts: string[] }> {
  const { logger, opts } = cfg;
  if (prediction.price !== undefined && prediction.price !== "") {
    logger.info(`Cost: $${prediction.price}`);
  }
  const classified = classifyOutputs(prediction);

  if (classified.mode === "empty") {
    throw new ProviderError(
      hasNsfwFlag(prediction)
        ? `Prediction ${prediction.id} returned no output: blocked by content safety (has_nsfw_contents). Try a different prompt or input.`
        : `Prediction ${prediction.id} completed but returned no outputs.`,
      ATLAS_PROVIDER,
    );
  }

  for (const text of classified.texts) console.log(text);
  if (classified.mode === "text") {
    if (opts.output) {
      const dest = isDirectoryOutput(opts.output)
        ? path.resolve(opts.output, outputFileName(prediction.id, 0, "txt"))
        : path.resolve(opts.output);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, `${classified.texts.join("\n\n")}\n`, "utf8");
      logger.success(`Saved text output to ${dest}`);
      return { files: [dest], texts: classified.texts };
    }
    return { files: [], texts: classified.texts };
  }

  if (opts.download === false) {
    for (const u of classified.urls) console.log(u);
    return { files: [], texts: classified.texts };
  }

  const dests = planOutputPaths(classified.urls, {
    predictionId: prediction.id,
    outDir: getOutputDir,
    output: opts.output,
    hint: cfg.hint,
  });
  const saved: string[] = [];
  for (let i = 0; i < classified.urls.length; i++) {
    const url = classified.urls[i] as string;
    const dest = dests[i] as string;
    try {
      await downloadFile(url, dest);
      saved.push(dest);
      logger.debug(`Downloaded ${redactUrl(url)} -> ${dest}`);
    } catch (e) {
      fs.rmSync(dest, { force: true });
      logger.warn(
        `Download failed (${redactUrl(url)}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (saved.length === 0) {
    throw new ProviderError(
      `Prediction ${prediction.id} produced ${classified.urls.length} output(s) but none downloaded. Retry with: ${resumeCommand(prediction.id)}`,
      ATLAS_PROVIDER,
    );
  }

  const images = saved.filter((f) => outputCategory(f) === "image");
  // A directory --output must not reach the finalizer, which treats it as a file path.
  const fileOutput = opts.output && !isDirectoryOutput(opts.output) ? opts.output : undefined;
  const finalImages = finalizeGeneratedImages(images, {
    imageFormat: opts.imageFormat,
    webp: opts.webp,
    output: fileOutput,
    logger,
  });
  const files = saved.map((f) => finalImages[images.indexOf(f)] ?? f);

  const firstVideo = files.find((f) => outputCategory(f) === "video");
  if (firstVideo) {
    await maybeDownloadThumb(prediction, firstVideo, { skip: opts.thumb === false, logger });
  }

  console.log(`\nPrediction ${prediction.id}: saved ${files.length} file(s)`);
  for (const f of files) console.log(`  ${f}`);
  return { files, texts: classified.texts };
}
