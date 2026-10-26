/**
 * `multix models` — one place to find which command and model serve a task,
 * built from the live command tree (so it never drifts from the CLI): each
 * command's task, default model (env overrides applied), whether its key is
 * set, whether it runs async, and the provider command that lists more models.
 */

import type { Command } from "commander";
import { run } from "../../agent/run-state.js";
import { ValidationError } from "../../core/errors.js";
import { groupKeyNames, groupReady } from "./provider-group-keys.js";

export const TASKS = [
  "image",
  "image-edit",
  "video",
  "image-to-video",
  "video-edit",
  "speech",
  "transcription",
  "music",
  "sfx",
  "voice",
  "3d",
  "analysis",
  "document",
  "avatar-video",
  "any",
] as const;

/** Task per command leaf name; group-specific overrides come first. */
const TASK_BY_COMMAND: Record<string, string> = {
  "gemini extract": "analysis",
  "elevenlabs music": "music",
  "minimax generate-music": "music",
  "atlas audio": "speech",
  "heygen video": "avatar-video",
  "heygen video-agent": "avatar-video",
  "heygen template": "avatar-video",
  "heygen model-video": "avatar-video",
  "heygen tts": "speech",
  "heygen translate": "video-edit",
  "heygen lipsync": "video-edit",
  "elevenlabs dub": "video-edit",
};
const TASK_BY_LEAF: Record<string, string> = {
  generate: "image",
  image: "image",
  "image-to-image": "image-edit",
  upscale: "image-edit",
  variation: "image-edit",
  video: "video",
  "generate-video": "video",
  "image-to-video": "image-to-video",
  "reference-to-video": "image-to-video",
  "edit-video": "video-edit",
  "extend-video": "video-edit",
  "generate-speech": "speech",
  tts: "speech",
  transcribe: "transcription",
  sfx: "sfx",
  "voice-changer": "voice",
  clone: "voice",
  isolate: "voice",
  "generate-3d": "3d",
  "3d": "3d",
  analyze: "analysis",
  convert: "document",
  run: "any",
};
const LIST_COMMANDS = new Set(["models", "video-models", "voices", "avatars", "styles", "list"]);
/** What a task produces, so an agent knows what file type to expect. */
const OUTPUT_BY_TASK: Record<string, string> = {
  image: "image",
  "image-edit": "image",
  video: "video",
  "image-to-video": "video",
  "video-edit": "video",
  "avatar-video": "video",
  speech: "audio",
  music: "audio",
  sfx: "audio",
  voice: "audio",
  transcription: "text",
  analysis: "text",
  document: "text",
  "3d": "3d",
};
/** Options every command (or every provider command) has; not task inputs. */
const NON_INPUT_OPTIONS = new Set([
  "--json",
  "--dry-run",
  "--verbose",
  "--help",
  "--model",
  "--model-id",
  "--download",
  "--no-download",
  "--output-dir",
  "--wait-timeout",
  "--receipt",
  "--detach",
  "--async",
]);

export interface ModelRow {
  task: string;
  command: string;
  provider: string;
  default_model?: string;
  /** Model ids the command's help names (choices or examples). */
  models?: string[];
  /** Takes any model id of the provider (generic runners). */
  any_model?: boolean;
  /** Arguments and flags the command takes (positionals as <name> or [name]). */
  inputs?: string[];
  /** Kind of file the command produces. */
  output?: string;
  ready: boolean;
  keys?: string[];
  async?: boolean;
  /** Command that lists the provider's models or voices live. */
  list?: string;
}

/** Default and named model ids from an option description ("(a|b)", "default x", "Model: a, b"). */
export function modelsFromDescription(text: string): { def?: string; models: string[] } {
  const ID = /^[A-Za-z0-9][\w.\/:*-]*$/;
  const STOP = new Set(["depends", "the", "a", "model", "id"]);
  const valid = (id: string | undefined) => {
    const v = id?.trim().replace(/[),.;]+$/, "");
    if (!v || /^owner\//.test(v)) return undefined; // placeholder syntax, not a model
    return ID.test(v) && !STOP.has(v.toLowerCase()) && /\d|-|\//.test(v) ? v : undefined;
  };
  const def =
    valid(text.match(/default:?\s+([^\s,;)]+)/i)?.[1]) ??
    valid(text.match(/([^\s(]+)\s+\(default\)/i)?.[1]);
  const models = new Set<string>();
  const add = (list: string | undefined, sep: RegExp) => {
    for (const id of list?.split(sep) ?? []) {
      const v = valid(id);
      if (v) models.add(v);
    }
  };
  for (const group of text.matchAll(/\(([^()]*\|[^()]*)\)/g)) add(group[1], /\|/);
  add(text.match(/e\.g\.\s*([^)]+)/)?.[1], /\s*,\s*|\s+or\s+/);
  const plain = text.replace(/\s*\(default\)/gi, "");
  add(plain.match(/:\s*([^()]+?)(?:\s*\(|$)/)?.[1], /\s*,\s*|\s+or\s+/);
  if (def) models.add(def);
  return def ? { def, models: [...models] } : { models: [...models] };
}

function leaves(cmd: Command, prefix: string[] = []): Array<{ path: string[]; cmd: Command }> {
  if (cmd.commands.length === 0) return [{ path: prefix, cmd }];
  return cmd.commands.flatMap((sub) => leaves(sub, [...prefix, sub.name()]));
}

export function modelRows(program: Command): ModelRow[] {
  const rows: ModelRow[] = [];
  for (const { path, cmd } of leaves(program)) {
    const [group = "", ...rest] = path;
    const leaf = rest.join(" ");
    const command = path.join(" ");
    const task = TASK_BY_COMMAND[command] ?? TASK_BY_LEAF[leaf];
    if (!task || group === "media") continue;
    const modelOpt = cmd.options.find((o) => o.long === "--model" || o.long === "--model-id");
    const lister = program.commands
      .find((g) => g.name() === group)
      ?.commands.find(
        (c) =>
          LIST_COMMANDS.has(c.name()) &&
          (c.name() !== "voices" || task === "speech") &&
          (c.name() !== "video-models" || task.includes("video")),
      );
    const named = modelsFromDescription(modelOpt?.description ?? "");
    const def = typeof modelOpt?.defaultValue === "string" ? modelOpt.defaultValue : named.def;
    const inputs = [
      ...cmd.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)),
      ...cmd.options
        .map((o) => o.long)
        .filter((l): l is string => Boolean(l) && !NON_INPUT_OPTIONS.has(l as string)),
    ];
    rows.push({
      task,
      command,
      provider: group,
      ...(def ? { default_model: def } : {}),
      ...(named.models.length > 1 ? { models: named.models } : {}),
      ...(task === "any" || ["fal", "replicate", "atlas", "openrouter"].includes(group)
        ? { any_model: true }
        : {}),
      ...(inputs.length ? { inputs } : {}),
      ...(OUTPUT_BY_TASK[task] ? { output: OUTPUT_BY_TASK[task] } : {}),
      ready: groupReady(group),
      ...(groupKeyNames(group).length ? { keys: groupKeyNames(group) } : {}),
      ...(cmd.options.some((o) => o.long === "--async" || o.long === "--detach")
        ? { async: true }
        : {}),
      ...(lister
        ? { list: `multix ${group} ${lister.name()}${lister.commands.length ? " list" : ""}` }
        : {}),
    });
  }
  return rows;
}

export function registerModelsCommand(program: Command): void {
  program
    .command("models")
    .description(
      "Find the command and model for a task: default models, key readiness, async support (agents: start here)",
    )
    .option("-t, --task <task>", `Filter by task: ${TASKS.join(", ")}`)
    .option("-p, --provider <group>", "Filter by provider group (gemini, fal, runway, ...)")
    .option("--ready", "Only providers whose API key is set")
    .action((opts: { task?: string; provider?: string; ready?: boolean }) => {
      if (opts.task && !(TASKS as readonly string[]).includes(opts.task)) {
        throw new ValidationError(`Invalid --task: ${opts.task}. Valid: ${TASKS.join(", ")}`);
      }
      const rows = modelRows(program).filter(
        (r) =>
          (!opts.task || r.task === opts.task) &&
          (!opts.provider || r.provider === opts.provider) &&
          (!opts.ready || r.ready),
      );
      if (run.json) {
        console.log(JSON.stringify(rows));
        return;
      }
      if (rows.length === 0) {
        console.log(
          "No matching commands. Try without --ready, or `multix check` to see missing keys.",
        );
        return;
      }
      const width = Math.max(...rows.map((r) => r.command.length));
      let task = "";
      for (const r of rows.sort(
        (a, b) => a.task.localeCompare(b.task) || Number(b.ready) - Number(a.ready),
      )) {
        if (r.task !== task) {
          task = r.task;
          console.log(`\n${task}`);
        }
        const flags = [r.ready ? "ready" : `needs ${r.keys?.join(", ")}`, r.async ? "async" : ""]
          .filter(Boolean)
          .join(", ");
        const model = [
          r.default_model ?? (r.any_model ? "<any model id>" : "provider default"),
          r.models?.length
            ? `(also: ${r.models
                .filter((m) => m !== r.default_model)
                .slice(0, 4)
                .join(", ")})`
            : "",
        ]
          .filter(Boolean)
          .join(" ");
        console.log(
          `  multix ${r.command.padEnd(width)}  ${model}  [${flags}]${r.list ? `  list: ${r.list}` : ""}`,
        );
      }
    });
}
