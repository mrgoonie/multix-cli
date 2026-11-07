/**
 * `multix generate <task> [prompt...]` — one request shape for image, video,
 * lip-sync and upscale across providers.
 *
 *   multix generate image "a red fox" --provider fal --model fal-ai/flux/dev --output fox.png
 *   multix generate video "waves" --model atlas:bytedance/seedance-v1-pro-fast/image-to-video --image frame.png
 *   multix generate lipsync --provider heygen --video in.mp4 --audio line.wav --output out.mp4
 *
 * The provider comes from --provider or a `<provider>:<model>` --model; there
 * is no automatic fallback. The provider's adapter maps the request onto the
 * provider command that serves it and refuses anything that command cannot
 * take before any request. That command then runs in this process, so its
 * validation, `--estimate` / `--max-cost` pre-flight, polling, downloads,
 * history entry and `multix.result/v1` envelope are the ones it always has;
 * the envelope's `route` names the command generate chose.
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { producedFiles } from "../../agent/output-file-tracker.js";
import { run } from "../../agent/run-state.js";
import { ConfigError, ProviderError } from "../../core/errors.js";
import { createLogger } from "../../core/logger.js";
import {
  GENERATE_PROVIDERS,
  GENERATE_TASKS,
  type GenerateInput,
  type GeneratePlan,
  type GenerateTask,
  adapterFor,
  isGenerateTask,
  resolveRoute,
} from "./generate-adapters.js";

/** Default for --wait-timeout (milliseconds) on every provider command that has one. */
export const WAIT_TIMEOUT_ENV = "MULTIX_WAIT_TIMEOUT";

interface GenerateOpts {
  provider?: string;
  model?: string;
  image: string[];
  endImage?: string;
  video?: string;
  audio?: string;
  aspectRatio?: string;
  resolution?: string;
  duration?: string;
  numImages?: string;
  generateAudio?: boolean;
  output?: string;
  async?: boolean;
  waitTimeout?: string;
  verbose?: boolean;
  json?: boolean;
  dryRun?: boolean;
  estimate?: boolean;
  maxCost?: string;
  costPolicy?: string;
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function positive(flag: string, value: string | undefined, integer: boolean): string | undefined {
  if (value === undefined) return undefined;
  const n = Number(value.trim());
  if (!value.trim() || !Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) {
    throw new ConfigError(
      `${flag} must be a positive ${integer ? "integer" : "number"}; got ${value}`,
    );
  }
  return value.trim();
}

/** The validated request, before any provider is involved. */
export function buildInput(task: GenerateTask, words: string[], opts: GenerateOpts): GenerateInput {
  const prompt = words.join(" ").trim();
  const envTimeout = process.env[WAIT_TIMEOUT_ENV]?.trim();
  const waitTimeout =
    positive("--wait-timeout", opts.waitTimeout, true) ??
    (envTimeout ? positive(WAIT_TIMEOUT_ENV, envTimeout, true) : undefined);
  if (opts.endImage !== undefined && opts.image.length === 0) {
    throw new ConfigError("--end-image needs --image (the first frame)");
  }
  if (opts.output !== undefined && opts.async) {
    throw new ConfigError(
      "--output cannot be combined with --async: nothing is downloaded yet; use the resume command in the result",
    );
  }
  return {
    task,
    ...(prompt ? { prompt } : {}),
    images: opts.image,
    ...(opts.endImage !== undefined ? { endImage: opts.endImage } : {}),
    ...(opts.video !== undefined ? { video: opts.video } : {}),
    ...(opts.audio !== undefined ? { audio: opts.audio } : {}),
    ...(opts.aspectRatio !== undefined ? { aspectRatio: opts.aspectRatio } : {}),
    ...(opts.resolution !== undefined ? { resolution: opts.resolution } : {}),
    ...(opts.duration !== undefined
      ? { duration: positive("--duration", opts.duration, false) }
      : {}),
    ...(opts.numImages !== undefined
      ? { numImages: positive("--num-images", opts.numImages, true) }
      : {}),
    ...(opts.generateAudio !== undefined ? { generateAudio: opts.generateAudio } : {}),
    ...(opts.output !== undefined ? { output: opts.output } : {}),
    async: Boolean(opts.async),
    ...(waitTimeout !== undefined ? { waitTimeout } : {}),
    ...(waitTimeout !== undefined && opts.waitTimeout === undefined
      ? { waitTimeoutFromEnv: true }
      : {}),
  };
}

/** Plan a request: provider, model and the provider command with its arguments. */
export function planGenerate(
  task: string,
  words: string[],
  opts: GenerateOpts,
): { provider: string; model?: string; plan: GeneratePlan } {
  if (!isGenerateTask(task)) {
    throw new ConfigError(`Unknown task "${task}". Valid: ${GENERATE_TASKS.join(", ")}`);
  }
  const route = resolveRoute(opts.provider, opts.model);
  const input = buildInput(task, words, opts);
  if (route.model !== undefined) input.model = route.model;
  const plan = adapterFor(route.provider, task).plan(input);
  if (!plan.writesOutput && input.output !== undefined && Number(input.numImages ?? 1) > 1) {
    throw new ConfigError("--output takes one file; drop --num-images or --output");
  }
  return { provider: route.provider, ...(route.model ? { model: route.model } : {}), plan };
}

function findCommand(root: Command, names: string[]): Command {
  let cmd: Command | undefined = root;
  for (const name of names) cmd = cmd?.commands.find((c) => c.name() === name);
  if (!cmd || cmd.commands.length > 0) {
    throw new Error(`multix generate: no command "${names.join(" ")}"`);
  }
  return cmd;
}

/** Global flags passed on to the provider command, which prices, guards and dry-runs itself. */
function forwarded(opts: GenerateOpts, target: Command): string[] {
  const has = (flag: string) => target.options.some((o) => o.long === flag);
  const out: string[] = [];
  if (opts.json && has("--json")) out.push("--json");
  if (opts.dryRun && has("--dry-run")) out.push("--dry-run");
  if (opts.estimate && has("--estimate")) out.push("--estimate");
  if (opts.maxCost !== undefined) {
    if (!has("--max-cost")) {
      throw new ConfigError(`${target.name()} cannot enforce --max-cost; run without it`);
    }
    out.push("--max-cost", opts.maxCost);
  }
  if (opts.costPolicy !== undefined && has("--cost-policy")) {
    out.push("--cost-policy", opts.costPolicy);
  }
  if (opts.verbose && has("--verbose")) out.push("--verbose");
  return out;
}

const MEDIA_EXT: Record<"image" | "video", RegExp> = {
  image: /\.(png|jpe?g|webp|gif|avif)$/i,
  video: /\.(mp4|mov|webm|mkv)$/i,
};

/** For commands without --output: copy the one media file the command saved to --output. */
export function copyOutput(task: GenerateTask, output: string): void {
  const kind = task === "image" || task === "upscale" ? "image" : "video";
  const target = path.resolve(output);
  const files = producedFiles().filter(
    (f) => MEDIA_EXT[kind].test(f) && path.resolve(f) !== target,
  );
  const [file] = files;
  if (!file) {
    throw new ProviderError(`The provider command saved no ${kind} to copy to --output`, run.group);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, target);
  console.log(`Copied to: ${output}`);
}

export function registerGenerateCommand(program: Command): void {
  program
    .command("generate")
    .description(
      "Generate an image or video, lip-sync or upscale on any provider with one set of flags; refuses inputs the provider cannot take before any request",
    )
    .argument("<task>", `Task: ${GENERATE_TASKS.join("|")}`)
    .argument("[prompt...]", "Prompt (not used by lipsync or upscale)")
    .option("--provider <id>", `Provider (${GENERATE_PROVIDERS.join("|")})`)
    .option(
      "--model <id>",
      "Model id, or <provider>:<model> to name both (multix models --task <task> --live)",
    )
    .option(
      "--image <path|url>",
      "Input image: image edit, first frame for video, subject for lipsync, source for upscale (repeatable)",
      collect,
      [] as string[],
    )
    .option("--end-image <path|url>", "Last frame of an image-to-video run")
    .option("--video <path|url>", "Source video (lipsync)")
    .option("--audio <path|url>", "Audio track (lipsync)")
    .option("--aspect-ratio <ratio>", "Aspect ratio, e.g. 16:9")
    .option("--resolution <res>", "Resolution, e.g. 720p, 1080p, 2K")
    .option("--duration <s>", "Video length in seconds")
    .option("--num-images <n>", "Number of images")
    .option("--generate-audio", "Make a soundtrack (video models with audio)")
    .option("--no-generate-audio", "Make no soundtrack (video models with audio)")
    .option("--output <path>", "Save the result to this path")
    .option("--async", "Submit and return the job id and resume command instead of waiting")
    .option(
      "--wait-timeout <ms>",
      `How long to wait for the result (default: ${WAIT_TIMEOUT_ENV}, else the provider command's)`,
    )
    .option("-v, --verbose", "Verbose logging")
    .action(async (task: string, words: string[], opts: GenerateOpts, cmd: Command) => {
      const logger = createLogger({ verbose: opts.verbose ?? false, stderr: true });
      // Not a provider itself: a refused request names none; the provider command sets its own.
      run.group = "";
      const { provider, model, plan } = planGenerate(task, words, opts);
      const root = cmd.parent;
      if (!root) throw new Error("multix generate: no parent program");
      const target = findCommand(root, plan.command.split(" "));
      const args = [...plan.args, ...forwarded(opts, target)];
      run.route = {
        via: "generate",
        task,
        provider,
        ...(model ? { model } : {}),
        command: plan.command,
        args,
      };
      logger.debug(`multix ${plan.command} ${args.join(" ")}`);
      await target.parseAsync(args, { from: "user" });
      // The provider command saved the file under its own name; give it the --output path.
      if (!plan.writesOutput && opts.output && !opts.dryRun && !opts.estimate && !opts.async) {
        copyOutput(task as GenerateTask, opts.output);
      }
    });
}
