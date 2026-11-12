/** WaveSpeedAI generic and 3D CLI commands. */
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { ProviderError, ValidationError } from "../../../core/errors.js";
import { downloadToFile } from "../../../core/http-client.js";
import { parseJsonInput } from "../../../core/json-input.js";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { checkUrlSafety } from "../../../core/url-safety.js";
import { inspectLocalMedia } from "../../fal/local-files.js";
import { createWaveSpeedClient, waveOutputUrls, type WavePrediction, type WaveSpeedClient } from "../client.js";
import { WAVESPEED_3D_MODELS, WAVESPEED_DEFAULT_3D_MODEL, wave3dModel } from "../models.js";

const collect = (v: string, previous: string[]) => [...previous, v];
interface Flags {
  model?: string; input?: string; file: string[]; ref: string[];
  detach?: boolean; wait?: boolean; download: boolean;
  outputDir?: string; output?: string; waitTimeout: string; verbose?: boolean;
}

/** Build a 3D payload with exact input names from WaveSpeed's per-model schema. */
export function buildWave3dInput(model: string, prompt: string | undefined, refs: readonly string[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const spec = wave3dModel(model);
  if (!spec) throw new ValidationError("Unsupported 3D preset. Use wavespeed run for custom IDs; wavespeed models lists verified IDs.");
  if (spec.mode === "text") {
    if (!prompt || refs.length) throw new ValidationError("Text-to-3D needs a prompt and no --ref");
    return { ...extra, prompt };
  }
  if (prompt) throw new ValidationError("This model accepts reference images, not text prompts");
  const min = model.includes("multiview") ? 2 : 1;
  if (refs.length < min || refs.length > spec.maxImages) {
    throw new ValidationError("Model " + model + " needs " + min + "-" + spec.maxImages + " reference image(s)");
  }
  return { ...extra, [spec.field]: spec.field === "images" ? [...refs] : refs[0] };
}

async function uploadImage(client: WaveSpeedClient, input: string): Promise<string> {
  if (input.startsWith("https://")) {
    checkUrlSafety(input, { provider: "wavespeed", action: "fetch" });
    return input;
  }
  if (input.includes("://")) throw new ValidationError("Use https:// or local image paths");
  const file = await inspectLocalMedia(input);
  if (!file.mime.startsWith("image/")) throw new ValidationError("WaveSpeed 3D requires an image");
  if (file.size > 200 * 1024 * 1024) throw new ValidationError("WaveSpeed 200 MB upload limit");
  const ticket = await client.uploadTicket(file.name, file.size, file.mime);
  return client.uploadBytes(ticket, await fs.readFile(file.abs));
}

async function applyFileFlags(client: WaveSpeedClient, input: Record<string, unknown>, list: readonly string[]): Promise<void> {
  for (const flag of list) {
    const pivot = flag.indexOf("=");
    const name = flag.slice(0, pivot);
    if (pivot <= 0 || !/^[a-z_][a-z_0-9]*(\[\])?$/.test(name)) throw new ValidationError("Expected --file name=path or name[]=path");
    const url = await uploadImage(client, flag.slice(pivot + 1));
    if (name.endsWith("[]")) {
      const field = name.slice(0, -2);
      if (input[field] !== undefined && !Array.isArray(input[field])) throw new ValidationError("Existing input " + field + " is not an array");
      input[field] = [...(input[field] as string[] ?? []), url];
    } else input[name] = url;
  }
}

async function printOrDownload(prediction: WavePrediction, flags: Flags): Promise<void> {
  if (flags.download === false) { console.log(JSON.stringify(prediction, null, 2)); return; }
  const urls = [...new Set(waveOutputUrls(prediction))];
  if (!urls.length) throw new ProviderError("Prediction has no downloadable output", "wavespeed");
  if (flags.output && urls.length !== 1) throw new ValidationError("--output only applies to one output file");
  const dir = flags.outputDir ? path.resolve(flags.outputDir) : getOutputDir();
  const files: string[] = [];
  for (const [index, url] of urls.entries()) {
    checkUrlSafety(url, { provider: "wavespeed" });
    const originalExt = path.extname(new URL(url).pathname).toLowerCase();
    const ext = /^\.[a-z0-9]{1,8}$/.test(originalExt) ? originalExt : ".glb";
    const dest = flags.output ? path.resolve(flags.output) : path.join(dir, "wavespeed-" + prediction.id + "-" + (index + 1) + ext);
    await downloadToFile(url, { dest, validateUrl: (value) => { checkUrlSafety(value, { provider: "wavespeed" }); } });
    files.push(dest);
  }
  console.log(JSON.stringify({ id: prediction.id, model: prediction.model, status: prediction.status, files, actual_cost_usd: prediction.cost ?? prediction.price ?? null }, null, 2));
}

async function generate(client: WaveSpeedClient, model: string, input: Record<string, unknown>, flags: Flags): Promise<void> {
  const logger = createLogger({ verbose: !!flags.verbose, stderr: true });
  const submitted = await client.submit(model, input); // never retry this paid POST
  if (flags.detach) {
    console.log(JSON.stringify({ id: submitted.id, model, status: submitted.status, resume_command: "multix wavespeed status " + submitted.id + " --wait" }, null, 2));
    return;
  }
  try {
    const result = submitted.status === "completed" ? submitted : await client.wait(submitted.id, { timeoutMs: Number(flags.waitTimeout) });
    await printOrDownload(result, flags);
  } catch (error) {
    logger.error("Prediction " + submitted.id + " was accepted. Resume: multix wavespeed status " + submitted.id + " --wait");
    throw error;
  }
}

function addOutputFlags(cmd: Command): Command {
  return cmd.option("--detach", "Print accepted prediction ID and return")
    .option("--no-download", "Print raw result instead of downloading")
    .option("--output-dir <dir>", "Output directory")
    .option("--output <file>", "Exact file path for a single output")
    .option("--wait-timeout <ms>", "Maximum polling duration (ms)", "900000")
    .option("-v, --verbose", "Verbose logging");
}

export function registerWaveSpeedCommands(root: Command): void {
  const parent = root.command("wavespeed").description("WaveSpeedAI API: models, 3D generation, upload and resumable jobs");
  parent.command("models").description("Verified WaveSpeedAI 3D model IDs")
    .action(() => console.log(JSON.stringify(WAVESPEED_3D_MODELS, null, 2)));

  addOutputFlags(parent.command("run <model>").description("Run any WaveSpeedAI model by ID")
    .option("--input <json>", "Input JSON or @file.json")
    .option("--file <field=path>", "Upload an image to field; field[]=path appends", collect, []))
    .action(async (model: string, flags: Flags) => {
      if (!flags.input && !flags.file.length) throw new ValidationError("Provide --input or --file");
      const input = flags.input ? parseJsonInput(flags.input) : {};
      const client = createWaveSpeedClient();
      await applyFileFlags(client, input, flags.file);
      await generate(client, model, input, flags);
    });

  addOutputFlags(parent.command("3d [prompt]").description("Image/text/multi-image to 3D with Seed3D, Tripo, Hunyuan and Meshy")
    .option("-m, --model <id>", "Model ID; image default Seed3D 2.0, text default Tripo H3.1")
    .option("--ref <path|url>", "Reference image; repeat for multi-view models", collect, [])
    .option("--input <json>", "Additional provider-specific JSON settings or @file.json"))
    .action(async (prompt: string | undefined, flags: Flags) => {
      const model = flags.model ?? (flags.ref.length ? WAVESPEED_DEFAULT_3D_MODEL : "tripo3d/h3.1/text-to-3d");
      buildWave3dInput(model, prompt, flags.ref); // preflight before any billable upload
      const extra = flags.input ? parseJsonInput(flags.input) : {};
      const client = createWaveSpeedClient();
      const refs = await Promise.all(flags.ref.map((input) => uploadImage(client, input)));
      await generate(client, model, buildWave3dInput(model, prompt, refs, extra), flags);
    });

  parent.command("status <id>").description("Inspect or resume a prediction without resubmission")
    .option("--wait", "Poll to terminal status")
    .option("--no-download", "Print raw result")
    .option("--output-dir <dir>", "Output directory")
    .option("--output <file>", "Exact file path for one output")
    .option("--wait-timeout <ms>", "Maximum polling duration (ms)", "900000")
    .action(async (id: string, flags: Flags) => {
      const client = createWaveSpeedClient();
      const result = flags.wait ? await client.wait(id, { timeoutMs: Number(flags.waitTimeout) }) : await client.result(id);
      if (flags.wait && result.status === "completed") await printOrDownload(result, flags);
      else console.log(JSON.stringify(result, null, 2));
    });

  parent.command("upload <file>").description("Upload a local image and print its media URL")
    .action(async (file: string) => console.log(JSON.stringify({ url: await uploadImage(createWaveSpeedClient(), file) })));
}
