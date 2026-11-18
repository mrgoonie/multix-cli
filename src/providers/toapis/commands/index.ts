/**
 * `multix toapis` — the ToAPIs aggregator (https://toapis.com): one key and one
 * balance for Seedance, Veo, Kling, Wan, Grok, gpt-image, Gemini image, Seedream,
 * Flux and more. ToAPIs is a reseller, not the model vendor.
 */

import type { Command } from "commander";
import { nameJob } from "../../../agent/run-state.js";
import { ValidationError } from "../../../core/errors.js";
import { quoteEstimateUsd, quoteToapis } from "../client.js";
import { TOAPIS_PRICING_LINK } from "../models.js";
import { buildToapisBody, parseParams } from "../request-body.js";
import type { ToapisMediaKind } from "../types.js";
import {
  createToapisClientFromEnv,
  createToapisLogger,
  resolveRef,
  toapisBaseUrlFromEnv,
  toapisDefaultModel,
  uploadLocalFile,
} from "./env.js";
import {
  type RunOpts,
  addRunOptions,
  finishTask,
  parsePositiveInt,
  printableTask,
  resumeCommand,
  runTask,
} from "./task-runner.js";

const collect = (value: string, prev: string[]) => [...prev, value];

interface GenerateOpts extends RunOpts {
  model?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  count?: string;
  audio?: boolean;
  seed?: string;
  negative?: string;
  image: string[];
  firstFrame?: string;
  lastFrame?: string;
  param: string[];
}

function addGenerateOptions(cmd: Command, kind: ToapisMediaKind): Command {
  cmd
    .option("-m, --model <id>", `Model id (see \`multix toapis models --type ${kind}\`)`)
    .option("--aspect-ratio <r>", "Aspect ratio, e.g. 16:9, 9:16, 1:1")
    .option(
      "--resolution <r>",
      kind === "image"
        ? "Resolution: 1K, 2K or 4K (model dependent)"
        : "Resolution: 480p, 720p, 1080p",
    )
    .option("--seed <n>", "Fixed seed")
    .option("--negative <text>", "Negative prompt (models that support it)")
    .option(
      "--image <pathOrUrl>",
      "Reference image; local files are uploaded (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--param <key=value>",
      "Extra model field sent as-is; dotted keys nest, JSON values parse (repeatable)",
      collect,
      [] as string[],
    );
  if (kind === "image") cmd.option("-n, --count <n>", "Number of images (model dependent)");
  else {
    cmd
      .option("--duration <s>", "Duration in seconds (model dependent, e.g. Seedance 4-15)")
      .option("--first-frame <pathOrUrl>", "First frame image (image-to-video)")
      .option("--last-frame <pathOrUrl>", "Last frame image")
      .option("--audio", "Generate an audio track")
      .option("--no-audio", "Generate no audio track");
  }
  return addRunOptions(cmd, kind === "video" ? 900_000 : 300_000);
}

/** Quote params as the pricing page sends them. */
function quoteParams(opts: GenerateOpts, kind: ToapisMediaKind): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (opts.resolution)
    params.resolution =
      kind === "image" ? opts.resolution.toUpperCase() : opts.resolution.toLowerCase();
  if (opts.duration) params.duration = Number(opts.duration);
  if (opts.aspectRatio) params.aspect_ratio = opts.aspectRatio;
  if (opts.audio !== undefined) params.generate_audio = opts.audio;
  return params;
}

async function generate(kind: ToapisMediaKind, prompt: string, opts: GenerateOpts): Promise<void> {
  const logger = createToapisLogger({
    verbose: opts.verbose,
    stdoutReserved: Boolean(opts.async),
  });
  const model = opts.model?.trim() || toapisDefaultModel(kind);
  const duration = parsePositiveInt(opts.duration, "--duration");
  const count = parsePositiveInt(opts.count, "--count");
  const seed = opts.seed === undefined ? undefined : Number(opts.seed);
  if (seed !== undefined && !Number.isInteger(seed))
    throw new ValidationError("--seed must be an integer");

  const client = createToapisClientFromEnv();
  const images: string[] = [];
  for (const ref of opts.image) images.push((await resolveRef(client, ref, logger)) as string);
  const body = buildToapisBody({
    kind,
    model,
    prompt,
    aspectRatio: opts.aspectRatio,
    resolution: opts.resolution,
    duration,
    count,
    audio: opts.audio,
    seed,
    negativePrompt: opts.negative,
    images,
    firstFrame: await resolveRef(client, opts.firstFrame, logger),
    lastFrame: await resolveRef(client, opts.lastFrame, logger),
    extra: parseParams(opts.param),
  });
  await runTask(client, kind, body, opts, logger, kind === "video" ? 900_000 : 300_000);
}

export function registerToapisCommands(program: Command): void {
  const toapis = program
    .command("toapis")
    .description(
      "ToAPIs aggregator (reseller): image and video models from many vendors on one key — Seedance, Veo, Kling, Wan, gpt-image, Gemini image, Seedream, Flux",
    );

  addGenerateOptions(
    toapis
      .command("image")
      .description("Generate images (async task)")
      .argument("<prompt>", "Text prompt"),
    "image",
  ).action((prompt: string, opts: GenerateOpts) => generate("image", prompt, opts));

  addGenerateOptions(
    toapis
      .command("video")
      .description(
        "Generate a video: text-to-video, or image-to-video with --first-frame (async task)",
      )
      .argument("<prompt>", "Text prompt"),
    "video",
  ).action((prompt: string, opts: GenerateOpts) => generate("video", prompt, opts));

  toapis
    .command("status")
    .description("Show a task; with --wait, wait for it and download the outputs")
    .argument("<taskId>", "Task id printed by --async")
    .option("--kind <kind>", "image or video", "video")
    .option("--wait", "Wait until the task finishes, then download")
    .option("--wait-timeout <ms>", "Max time to wait", "900000")
    .option("--output <path>", "Output file or directory")
    .option("--no-download", "Do not download media; print output URLs instead")
    .option("-v, --verbose", "Verbose logging")
    .action(async (taskId: string, opts: RunOpts & { kind: string; wait?: boolean }) => {
      if (opts.kind !== "image" && opts.kind !== "video") {
        throw new ValidationError(`--kind must be image or video, got "${opts.kind}"`);
      }
      const kind = opts.kind as ToapisMediaKind;
      const logger = createToapisLogger({ verbose: opts.verbose });
      const client = createToapisClientFromEnv();
      nameJob(taskId);
      const task = opts.wait
        ? await client.waitForTask(kind, taskId, {
            timeoutMs: parsePositiveInt(opts.waitTimeout, "--wait-timeout"),
            resumeHint: resumeCommand(kind, taskId),
          })
        : await client.getTask(kind, taskId);
      if (task.status === "completed" || task.status === "failed") {
        await finishTask(task, kind, opts, logger);
        return;
      }
      console.log(`Task ${task.id}: ${task.status || "queued"} (${task.progress ?? 0}%)`);
    });

  toapis
    .command("models")
    .description("List the image/video/audio models this key can use (live)")
    .option("--type <type>", "image, video, audio or all", "all")
    .action(async (opts: { type: string }) => {
      if (!["image", "video", "audio", "all"].includes(opts.type)) {
        throw new ValidationError(`--type must be image, video, audio or all, got "${opts.type}"`);
      }
      const models = await createToapisClientFromEnv().listModels(
        opts.type as "image" | "video" | "audio" | "all",
      );
      for (const m of models)
        console.log(`${m.id}\t${(m.supported_endpoint_types ?? []).join(",")}`);
      console.error(`${models.length} models. Prices: ${TOAPIS_PRICING_LINK}`);
    });

  toapis
    .command("quote")
    .description("Price quote from ToAPIs' public price list (no key needed, nothing is charged)")
    .requiredOption("-m, --model <id>", "Model id")
    .option("--resolution <r>", "Resolution (480p/720p/1080p or 1K/2K/4K)")
    .option("--duration <s>", "Video duration in seconds")
    .option("--aspect-ratio <r>", "Aspect ratio")
    .option("-n, --count <n>", "Image count")
    .option("--param <key=value>", "Extra quote parameter (repeatable)", collect, [] as string[])
    .action(async (opts: GenerateOpts & { model: string }) => {
      const duration = parsePositiveInt(opts.duration, "--duration");
      const count = parsePositiveInt(opts.count, "--count");
      const kind: ToapisMediaKind =
        duration || /p$/i.test(opts.resolution ?? "") ? "video" : "image";
      const params = { ...quoteParams(opts, kind), ...parseParams(opts.param) };
      const [quote] = await quoteToapis([{ model: opts.model, params }], {
        baseUrl: toapisBaseUrlFromEnv(),
      });
      if (!quote) {
        throw new ValidationError(
          `ToAPIs cannot price ${opts.model} with these options (unknown model or unsupported value)`,
        );
      }
      const estimate = quoteEstimateUsd(quote, { duration, count });
      console.log(`${quote.model}: ${quote.display_price} (${quote.charge_type})`);
      const perSecond = quote.estimated_second_price?.output_unit_price;
      if (perSecond !== undefined)
        console.log(
          `≈ $${perSecond.toFixed(4)}/s (ToAPIs P75 estimate; billed by usage.total_tokens)`,
        );
      if (estimate !== undefined) console.log(`Estimated: $${estimate.toFixed(4)}`);
    });

  toapis
    .command("upload")
    .description("Upload a local image, video or audio file; prints its public URL")
    .argument("<file>", "Local media file")
    .option("-v, --verbose", "Verbose logging")
    .action(async (file: string, opts: { verbose?: boolean }) => {
      const logger = createToapisLogger({ verbose: opts.verbose, stdoutReserved: true });
      console.log(await uploadLocalFile(createToapisClientFromEnv(), file, logger));
    });
}
