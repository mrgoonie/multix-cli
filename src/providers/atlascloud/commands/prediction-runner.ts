/**
 * Shared Atlas Cloud prediction lifecycle for CLI commands:
 * schema loading, submit -> (async exit | bounded poll) -> terminal check ->
 * output delivery (text printed, media downloaded with normalized names,
 * images finalized to WebP like other providers, video thumbnails).
 *
 * Output and thumbnail downloads are https-only, never reach a local/private
 * address (checked on every redirect hop), and stop at MULTIX_MAX_DOWNLOAD_MB.
 * Generated names are deterministic per prediction output, so a retry keeps
 * the files an earlier run saved and downloads only the missing ones.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { trackInFlight, trackSubmit } from "../../../agent/run-state.js";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { maxDownloadBytes } from "../../../core/http-client.js";
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
  checkOutputUrl,
  classifyOutputs,
  defaultExtensionFor,
  extensionForContentType,
  hasNsfwFlag,
  isTerminalStatus,
  outputCategory,
  outputExtension,
  outputFileName,
  thumbnailSource,
} from "../prediction-output.js";
import type { AtlasMediaKind, AtlasModelSpec, AtlasPrediction } from "../types.js";
import { type NamingPolicy, downloadClaimed, savedOutput } from "./output-claims.js";

export type { NamingPolicy };

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

/**
 * Repeatable single-value `--ref`: each occurrence takes exactly one value, so
 * `atlas 3d --ref a.png "prompt"` keeps "prompt" as the positional argument.
 */
export function addRefOption(cmd: Command, description: string): Command {
  return cmd.option(
    "--ref <pathOrUrl>",
    `${description} (repeat --ref for several)`,
    (value: string, prev: string[]) => [...prev, value],
    [] as string[],
  );
}

/** Reject a missing `--ref` for commands that need at least one reference. */
export function requireRefs(refs: string[] | undefined): string[] {
  if (!refs || refs.length === 0) {
    throw new ValidationError("Missing required option --ref <pathOrUrl>");
  }
  return refs;
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
  /** Ends the process on Ctrl-C/SIGTERM/SIGHUP while submitting or waiting (tests inject it). */
  exit?: (code: number) => void;
}

export interface ExecuteResult {
  predictionId: string;
  prediction?: AtlasPrediction;
  files: string[];
  texts: string[];
}

/** The command that resumes a prediction, keeping the user's `--output` so files land in the same place. */
export function resumeCommand(id: string, output?: string): string {
  const base = `multix atlas status ${id} --wait --download`;
  return output ? `${base} --output ${shellQuote(output)}` : base;
}

function shellQuote(value: string): string {
  if (/^[\w@%+=:,./\\-]+$/.test(value)) return value;
  // Double quotes work in POSIX shells, PowerShell and cmd; escape what POSIX expands.
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Shell exit status for a run stopped by each signal: 128 + the signal number. */
const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;

/**
 * Run `wait` so that Ctrl-C, SIGTERM or a closed terminal stops it and exits
 * with 128 + the signal number through the agent runtime (envelope, history),
 * after printing `message`. Nothing local needs cleanup while it runs.
 */
export async function exitOnInterrupt<T>(
  wait: () => Promise<T>,
  message: string,
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<T> {
  const signals = Object.keys(SIGNAL_EXIT) as Array<keyof typeof SIGNAL_EXIT>;
  const stop = (signal: keyof typeof SIGNAL_EXIT) => {
    process.stderr.write(`${message}\n`);
    exit(SIGNAL_EXIT[signal]);
  };
  for (const signal of signals) process.on(signal, stop);
  try {
    return await wait();
  } finally {
    for (const signal of signals) process.off(signal, stop);
  }
}

/**
 * Run the work before a submit (schema read, validation, uploads): a signal
 * there is a clean cancel, since nothing billable was sent.
 */
export function beforeSubmit<T>(work: () => Promise<T>, exit?: (code: number) => void): Promise<T> {
  trackSubmit({ state: "unsent" });
  return exitOnInterrupt(work, "Cancelled before submitting; no prediction was created.", exit);
}

const SUBMIT_UNKNOWN_HINT =
  "The submit request may have reached Atlas Cloud before the run stopped, so a paid prediction may exist that multix cannot name. Check the Atlas Cloud dashboard before resubmitting, or you may pay twice.";

/** Submit, then either exit with the id (--async) or wait, verify, and deliver outputs. */
export async function executePrediction(o: ExecuteOptions): Promise<ExecuteResult> {
  const { client, logger, opts } = o;
  const timeoutMs = parseTimeoutMs(opts.waitTimeout, o.defaultWaitTimeoutMs);
  logger.info(`Submitting to ${o.model} (generate${capitalize(o.kind)})...`);
  // Atlas may accept the POST and bill it before the answer arrives.
  trackSubmit({ state: "pending", hint: SUBMIT_UNKNOWN_HINT });
  const submitted = await exitOnInterrupt(
    () => client.submit(o.kind, { ...o.body, model: o.model }),
    `Cancelled while submitting to ${o.model}. ${SUBMIT_UNKNOWN_HINT}`,
    o.exit,
  );
  const id = submitted.id;

  if (opts.async) {
    trackSubmit(undefined);
    console.log(id);
    console.error(`Prediction submitted. Resume with: ${resumeCommand(id, opts.output)}`);
    return { predictionId: id, files: [], texts: [] };
  }

  const resume = resumeCommand(id, opts.output);
  // From here a stopped run leaves a billed prediction behind: report how to resume it.
  trackInFlight(id, resume);
  logger.info(`Prediction ${id} — waiting up to ${Math.round(timeoutMs / 1000)}s...`);
  const final = isTerminalStatus(submitted.status)
    ? submitted
    : await exitOnInterrupt(
        () =>
          client.waitForPrediction(id, {
            timeoutMs,
            intervalMs: o.pollIntervalMs,
            resumeHint: `Resume with: ${resume}`,
            onPoll: (p, n) => logger.debug(`poll ${n}: ${p.status}`),
          }),
        `Cancelled while waiting on prediction ${id}; it keeps running and is billed. Resume with: ${resume}`,
        o.exit,
      );
  assertPredictionSucceeded(final);
  // File names come from the submit-time id, which a resume also uses.
  const delivered = await deliverPrediction(final, {
    logger,
    opts,
    hint: o.hint,
    predictionId: id,
  });
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
 * `atlas-<prediction id>-NN.<ext>`. --output without an extension (or an existing
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
  cfg: {
    logger: Logger;
    opts: RunCliOpts;
    hint?: OutputCategory;
    /** The id the user submitted or resumed with; names files. Defaults to the prediction's. */
    predictionId?: string;
  },
): Promise<{ files: string[]; texts: string[] }> {
  const { logger, opts } = cfg;
  const id = cfg.predictionId ?? prediction.id;
  const retry = resumeCommand(id, opts.output);
  if (prediction.price !== undefined && prediction.price !== "") {
    logger.info(`Cost: $${prediction.price}`);
  }
  const classified = classifyOutputs(prediction);

  if (classified.mode === "empty") {
    throw new ProviderError(
      hasNsfwFlag(prediction)
        ? `Prediction ${id} returned no output: blocked by content safety (has_nsfw_contents). Try a different prompt or input.`
        : `Prediction ${id} completed but returned no outputs.`,
      ATLAS_PROVIDER,
    );
  }

  for (const text of classified.texts) console.log(text);
  if (classified.mode === "text") {
    if (opts.output) {
      // A directory gets the deterministic name, so a rerun rewrites the same text.
      const dest = isDirectoryOutput(opts.output)
        ? path.resolve(opts.output, outputFileName(id, 0, "txt"))
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
    predictionId: id,
    outDir: getOutputDir,
    output: opts.output,
    hint: cfg.hint,
  });
  const policy = namingPolicy(opts.output, classified.urls.length);
  // Read the cap up front so a bad MULTIX_MAX_DOWNLOAD_MB fails before any download.
  const maxBytes = maxDownloadBytes();
  const saved: string[] = [];
  const downloaded: string[] = [];
  const reused = new Set<string>();
  let failed = 0;
  for (let i = 0; i < classified.urls.length; i++) {
    const url = classified.urls[i] as string;
    const planned = dests[i] as string;
    try {
      // Checked before fetching: the stem is known even when the extension
      // still depends on the response Content-Type.
      const existing = policy === "reuse" ? savedOutput(planned) : undefined;
      if (existing) {
        saved.push(existing);
        reused.add(existing);
        logger.info(`Already saved: ${existing}`);
        continue;
      }
      const dest = await downloadClaimed(
        url,
        (response) =>
          policy === "overwrite" || outputExtension(url)
            ? planned
            : withContentTypeExtension(planned, response.headers.get("content-type")),
        policy,
        // Inline data: outputs are decoded by fetch, never sent over the network.
        { maxBytes, validateUrl: isDataUrl(url) ? undefined : checkOutputUrl },
      );
      saved.push(dest);
      downloaded.push(dest);
      logger.debug(`Downloaded ${redactUrl(url)} -> ${dest}`);
    } catch (e) {
      failed++;
      logger.warn(
        `Download failed (${redactUrl(url)}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (saved.length === 0) {
    throw new ProviderError(
      `Prediction ${id} produced ${classified.urls.length} output(s) but none downloaded. Retry with: ${retry}`,
      ATLAS_PROVIDER,
    );
  }

  // Files saved by an earlier run were finalized then (or kept as asked then).
  const images = downloaded.filter((f) => outputCategory(f) === "image");
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
    // Only the outputs may name a thumbnail: the rest of the payload can echo
    // request input such as a reference image. Same URL and naming policy as the outputs.
    await maybeDownloadThumb(thumbnailSource(prediction), firstVideo, {
      skip: opts.thumb === false,
      logger,
      download: async (thumbUrl, planned) => {
        const existing = policy === "reuse" ? savedOutput(planned) : undefined;
        if (existing) return { dest: existing };
        const dest = await downloadClaimed(thumbUrl, () => planned, policy, {
          maxBytes,
          validateUrl: checkOutputUrl,
        });
        return { dest };
      },
    });
  }

  console.log(`\nPrediction ${id}: saved ${files.length} file(s)`);
  for (const f of files) console.log(`  ${f}${reused.has(f) ? " (already saved)" : ""}`);
  if (failed > 0) {
    // Paid-for outputs were lost: scripts must not mistake this for success.
    throw new ProviderError(
      `Prediction ${id}: downloaded ${saved.length} of ${classified.urls.length} output(s); ${failed} failed. Saved: ${files.join(", ")}. Retry with: ${retry}`,
      ATLAS_PROVIDER,
    );
  }
  return { files, texts: classified.texts };
}

function isDataUrl(url: string): boolean {
  return /^data:/i.test(url.trim());
}

export function namingPolicy(output: string | undefined, outputCount: number): NamingPolicy {
  if (!output || isDirectoryOutput(output)) return "reuse";
  return outputCount === 1 ? "overwrite" : "unique";
}

/** Swap a planned fallback extension for the one the response Content-Type names. */
function withContentTypeExtension(planned: string, contentType: string | null): string {
  const ext = extensionForContentType(contentType);
  if (!ext) return planned;
  const current = path.extname(planned);
  return `${current ? planned.slice(0, -current.length) : planned}.${ext}`;
}
