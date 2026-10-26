/**
 * `multix models` — one place to find which command and model serve a task.
 * Tasks and model scope come from the capability registry (src/capabilities),
 * stated per command rather than guessed from names; default models, key
 * readiness and async flags come from the live command tree, so the rows
 * never drift from the CLI. `--model` inspects one verified model; `--live`
 * adds what provider catalogs list now (cached, see model-discovery-cache.ts).
 */

import type { Command } from "commander";
import { run } from "../../agent/run-state.js";
import {
  CAPABILITY_SCHEMA,
  type DiscoverySource,
  TASKS,
  type Task,
  isTask,
} from "../../capabilities/capability-types.js";
import { commandCapability } from "../../capabilities/command-capabilities.js";
import { DISCOVERY_PROVIDERS } from "../../capabilities/model-discovery.js";
import { findModelCapability, verifiedModels } from "../../capabilities/model-registry.js";
import { type ModelView, mergeModelViews } from "../../capabilities/model-views.js";
import { ValidationError } from "../../core/errors.js";
import { discoverCatalog } from "./model-discovery-cache.js";
import { groupKeyNames, groupReady } from "./provider-group-keys.js";

export { TASKS };

const LIST_COMMANDS = new Set(["models", "video-models", "voices", "avatars", "styles", "list"]);

export interface ModelRow {
  task: string;
  command: string;
  provider: string;
  default_model?: string;
  /** Model ids the command's help names (choices or examples), or its verified models. */
  models?: string[];
  /** Passes any provider model id through (not verified by multix; see model_scope). */
  any_model?: boolean;
  /** Which ids an any_model command takes, e.g. "OpenRouter model ids with image output". */
  model_scope?: string;
  /** Model ids verified for this task through this command (`multix models --model <id>`). */
  verified_models?: string[];
  /** What the command writes. */
  outputs?: string[];
  ready: boolean;
  keys?: string[];
  async?: boolean;
  /** Command that lists the provider's models or voices live. */
  list?: string;
  /** Example invocation, for routes that only verified models open. */
  example?: string;
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

function lister(program: Command, group: string, task: string): string | undefined {
  const found = program.commands
    .find((g) => g.name() === group)
    ?.commands.find(
      (c) =>
        LIST_COMMANDS.has(c.name()) &&
        (c.name() !== "voices" || task === "speech") &&
        (c.name() !== "avatars" || task !== "speech") &&
        (c.name() !== "video-models" || task.includes("video")),
    );
  return found
    ? `multix ${group} ${found.name()}${found.commands.length ? " list" : ""}`
    : undefined;
}

const keyFields = (group: string) =>
  groupKeyNames(group).length ? { keys: groupKeyNames(group) } : {};

const isAsync = (cmd: Command) =>
  cmd.options.some((o) => o.long === "--async" || o.long === "--detach");

export function modelRows(program: Command): ModelRow[] {
  const rows: ModelRow[] = [];
  const commands = new Map<string, Command>();
  for (const { path, cmd } of leaves(program)) {
    const [group = ""] = path;
    const command = path.join(" ");
    commands.set(command, cmd);
    const cap = commandCapability(command);
    if (!cap) continue;
    const modelOpt = cmd.options.find((o) => o.long === "--model" || o.long === "--model-id");
    const named = modelsFromDescription(modelOpt?.description ?? "");
    const def = typeof modelOpt?.defaultValue === "string" ? modelOpt.defaultValue : named.def;
    for (const task of cap.tasks) {
      const verified = verifiedModels({ task, provider: group })
        .filter((m) => m.command === command)
        .map((m) => m.model);
      const list = lister(program, group, task);
      rows.push({
        task,
        command,
        provider: group,
        ...(def ? { default_model: def } : {}),
        ...(named.models.length > 1 ? { models: named.models } : {}),
        ...(cap.models === "provider-catalog" ? { any_model: true, model_scope: cap.scope } : {}),
        ...(verified.length ? { verified_models: verified } : {}),
        ...(cap.outputs.length ? { outputs: [...cap.outputs] } : {}),
        ready: groupReady(group),
        ...keyFields(group),
        ...(isAsync(cmd) ? { async: true } : {}),
        ...(list ? { list } : {}),
      });
    }
  }
  // Verified models open a task on a command that does not serve it by itself
  // (e.g. speech through `fal run`): one row per command and task, listing only those ids.
  const routes = new Map<string, ModelRow>();
  for (const m of verifiedModels()) {
    const cmd = commands.get(m.command);
    if (!cmd) continue;
    for (const task of m.tasks) {
      if (commandCapability(m.command)?.tasks.includes(task)) continue;
      const key = `${task}\n${m.command}`;
      const row = routes.get(key);
      if (row) {
        row.models?.push(m.model);
        row.verified_models?.push(m.model);
        continue;
      }
      const list = lister(program, m.provider, task);
      routes.set(key, {
        task,
        command: m.command,
        provider: m.provider,
        models: [m.model],
        verified_models: [m.model],
        outputs: [...new Set(m.outputs.map((o) => o.modality))],
        ready: groupReady(m.provider),
        ...keyFields(m.provider),
        ...(isAsync(cmd) ? { async: true } : {}),
        ...(list ? { list } : {}),
        example: m.example,
      });
    }
  }
  return [...rows, ...routes.values()];
}

interface ModelsFlags {
  task?: string;
  provider?: string;
  ready?: boolean;
  model?: string;
  live?: boolean;
  refresh?: boolean;
}

/** Catalog models for a task from the providers that publish one. */
async function liveModels(
  task: Task,
  opts: ModelsFlags,
): Promise<{
  models: Array<ModelView & { ready?: boolean; keys?: string[] }>;
  sources: DiscoverySource[];
}> {
  const providers = DISCOVERY_PROVIDERS.filter((p) => !opts.provider || p === opts.provider);
  const catalogs = await Promise.all(
    providers.map((p) => discoverCatalog(p, task, { refresh: opts.refresh ?? false })),
  );
  const models = mergeModelViews(task, catalogs, opts.provider).map((m) =>
    m.command ? { ...m, ready: groupReady(m.provider), ...keyFields(m.provider) } : m,
  );
  return {
    models: opts.ready ? models.filter((m) => "ready" in m && m.ready) : models,
    sources: catalogs.map((c) => c.source),
  };
}

function printInspect(id: string, provider?: string, live?: ModelView[]): void {
  const cap = findModelCapability(id, provider);
  if (!cap) {
    const seen = live?.filter((m) => m.model === id) ?? [];
    console.log(
      seen.length
        ? `${id}: listed by ${seen.map((m) => m.provider).join(", ")} but not verified by multix; check its inputs with the provider before running it.`
        : `${id}: not in the verified registry. \`multix models --task <task> --live\` lists catalog models (unverified).`,
    );
    return;
  }
  const ready = groupReady(cap.provider);
  console.log(`${cap.name}  [${cap.provider}] ${cap.model}`);
  console.log(
    `  tasks: ${cap.tasks.join(", ")}   run: multix ${cap.command} (${cap.async ? "async" : "sync"})`,
  );
  console.log(`  ${ready ? "ready" : `needs ${groupKeyNames(cap.provider).join(", ")}`}`);
  console.log("  inputs:");
  for (const [name, spec] of Object.entries(cap.inputs)) {
    const values = spec.values
      ? ` one of ${spec.values.slice(0, 8).join("|")}${spec.values.length > 8 ? "|…" : ""}`
      : "";
    const extra = [
      spec.required ? "required" : "",
      spec.default !== undefined ? `default ${spec.default}` : "",
      spec.max_length ? `max ${spec.max_length} chars` : "",
      spec.note ?? "",
    ]
      .filter(Boolean)
      .join("; ");
    console.log(`    ${name} (${spec.type})${values}${extra ? `  ${extra}` : ""}`);
  }
  if (cap.required_any) {
    console.log(`  give one of: ${cap.required_any.map((g) => g.join(" + ")).join("  or  ")}`);
  }
  for (const o of cap.outputs) {
    console.log(
      `  output: ${o.field} (${o.modality}${o.formats ? `: ${o.formats.join(", ")}` : ""})`,
    );
  }
  if (cap.voices) {
    const voices =
      "note" in cap.voices
        ? `${cap.voices.note} (e.g. ${cap.voices.examples.join(", ")})`
        : cap.voices.join(", ");
    console.log(`  voices: ${voices}`);
  }
  if (cap.languages) {
    console.log(
      `  languages: ${cap.languages === "auto" ? "auto-detected" : cap.languages.join(", ")}`,
    );
  }
  console.log(`  example: ${cap.example}`);
  console.log(`  verified ${cap.source.verified_at} against ${cap.source.url}`);
}

function printRows(rows: ModelRow[]): void {
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
    const model =
      r.verified_models && !r.default_model && !r.any_model
        ? `verified: ${r.verified_models.join(", ")}`
        : [
            r.default_model ?? (r.any_model ? "<any model id, unverified>" : "provider default"),
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
}

function printLive(
  models: Array<ModelView & { ready?: boolean; keys?: string[] }>,
  sources: DiscoverySource[],
): void {
  console.log("\nProvider catalogs:");
  for (const s of sources) {
    const when = s.fetched_at ? ` ${s.fetched_at}` : "";
    console.log(
      `  ${s.provider}: ${s.state}${when}${s.error ? ` (${s.error})` : ""}${s.truncated ? " (truncated)" : ""}`,
    );
  }
  if (models.length === 0) return;
  console.log("Models (✓ verified by multix, ? listed by the provider only):");
  for (const m of models) {
    const state = m.listed === null ? "catalog unknown" : (m.status ?? "");
    const run = m.command
      ? `${m.verified ? "" : "unverified, "}multix ${m.command}${m.ready === false ? ` [needs ${m.keys?.join(", ")}]` : ""}`
      : m.runner
        ? `unverified, multix ${m.runner} passes any id`
        : "no multix command";
    console.log(
      `  ${m.verified ? "✓" : "?"} ${m.provider} ${m.model}  ${run}${state ? `  (${state})` : ""}`,
    );
  }
}

export function registerModelsCommand(program: Command): void {
  program
    .command("models")
    .description(
      "Find the command and model for a task: default models, verified models, key readiness, async support (agents: start here)",
    )
    .option("-t, --task <task>", `Filter by task: ${TASKS.join(", ")}`)
    .option("-p, --provider <group>", "Filter by provider group (gemini, fal, runway, ...)")
    .option("--ready", "Only providers whose API key is set")
    .option("--model <id>", "Inspect one model: inputs, voices, formats, how to run it")
    .option(
      "--live",
      "Also list models the provider catalogs serve for --task now (fal, openrouter; cached)",
    )
    .option("--refresh", "With --live: refetch the catalogs instead of using the cache")
    .action(async (opts: ModelsFlags) => {
      if (opts.task && !isTask(opts.task)) {
        throw new ValidationError(`Invalid --task: ${opts.task}. Valid: ${TASKS.join(", ")}`);
      }
      const task = opts.task as Task | undefined;
      if ((opts.live || opts.refresh) && !task && !opts.model) {
        throw new ValidationError("--live needs --task (e.g. multix models --task speech --live)");
      }
      if (opts.model !== undefined) {
        const cap = findModelCapability(opts.model, opts.provider);
        const liveTask = task ?? cap?.tasks[0];
        if ((opts.live || opts.refresh) && !liveTask) {
          throw new ValidationError(
            `--live needs --task for a model multix has not verified (e.g. multix models --model ${opts.model} --task speech --live)`,
          );
        }
        const live =
          (opts.live || opts.refresh) && liveTask ? await liveModels(liveTask, opts) : undefined;
        const listed = live?.models.filter((m) => m.model === opts.model);
        if (run.json) {
          console.log(
            JSON.stringify({
              schema: CAPABILITY_SCHEMA,
              model: opts.model,
              verified: cap ?? null,
              ...(cap ? { ready: groupReady(cap.provider), ...keyFields(cap.provider) } : {}),
              ...(live ? { listed: listed ?? [], sources: live.sources } : {}),
            }),
          );
          return;
        }
        printInspect(opts.model, opts.provider, live?.models);
        if (live) printLive(listed ?? [], live.sources);
        return;
      }
      const rows = modelRows(program).filter(
        (r) =>
          (!task || r.task === task) &&
          (!opts.provider || r.provider === opts.provider) &&
          (!opts.ready || r.ready),
      );
      const live = (opts.live || opts.refresh) && task ? await liveModels(task, opts) : undefined;
      if (run.json) {
        console.log(
          JSON.stringify(
            live
              ? {
                  schema: CAPABILITY_SCHEMA,
                  task,
                  commands: rows,
                  models: live.models,
                  sources: live.sources,
                }
              : rows,
          ),
        );
        return;
      }
      printRows(rows);
      if (live) printLive(live.models, live.sources);
    });
}
