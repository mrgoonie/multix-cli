/**
 * The CLI runner's MCP tools: discover commands, run one in a per-job
 * container, read and cancel jobs. multix_catalog only reads the caller's
 * keys and is always offered; the job tools need the job Durable Object
 * bindings (see index.ts) and are offered only when `jobs` is given.
 */

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  COST_POLICIES,
  checkBudget,
  estimateCommand,
  parseCostPolicy,
} from "../../../src/budget/command-cost.js";
import { TASKS } from "../../../src/capabilities/capability-types.js";
import { CATALOG_VIEWS, OFFERING_SORTS } from "../../../src/catalog/catalog-query.js";
import { BudgetError } from "../../../src/core/errors.js";
import type { Limits } from "../config.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { MODEL_ID_RE, catalogPayload } from "./catalog-view.js";
import {
  DEFAULT_WAIT_SECONDS,
  JobRunner,
  type JobToolsContext,
  MAX_WAIT_SECONDS,
} from "./job-runner.js";
import { modelCatalogPayload } from "./model-catalog-view.js";
import { prepareRun } from "./run-argv-builder.js";
import { MAX_INPUT_FILES } from "./run-input-files.js";
import { assertSpendGuard } from "./run-option-caps.js";
import { toolInput } from "./tool-input-schema.js";

export type RunToolFn = (
  tool: string,
  fields: Record<string, string | undefined>,
  body: () => Promise<Record<string, unknown>>,
) => Promise<CallToolResult>;

const jobIdSchema = z.string().max(64).describe("Job id returned by multix_run");
const optionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);
const urlListSchema = z.union([
  z.string().max(2048),
  z.array(z.string().max(2048)).max(MAX_INPUT_FILES),
]);

/**
 * The CLI's --estimate / --max-cost for multix_run, from the same pricing
 * code: an estimate-only call returns the price and never starts a job; a
 * budget the run cannot be proven to fit throws (nothing is started).
 */
export function costPreflight(
  command: string,
  args: {
    options?: Record<string, unknown>;
    estimate?: boolean;
    max_cost_usd?: number;
    cost_policy?: string;
  },
): Record<string, unknown> | undefined {
  if (!args.estimate && args.max_cost_usd === undefined) return undefined;
  const estimate = estimateCommand(command, args.options ?? {});
  let budget: Record<string, unknown> | undefined;
  if (args.max_cost_usd !== undefined) {
    const policy = parseCostPolicy(args.cost_policy);
    try {
      checkBudget(estimate, args.max_cost_usd, policy);
      budget = { ok: true, max_cost_usd: args.max_cost_usd, policy };
    } catch (error) {
      if (!args.estimate || !(error instanceof BudgetError)) throw error;
      budget = {
        ok: false,
        max_cost_usd: args.max_cost_usd,
        policy,
        code: error.code,
        message: error.message,
      };
    }
  }
  if (!args.estimate) return undefined;
  return { estimate_only: true, command, estimate, ...(budget ? { budget } : {}) };
}

/** How multix_run treats a run the caps cannot bound (multix_catalog marks them `uncapped_spend`). */
export const UNCAPPED_SPEND_NOTE: Record<Limits["uncappedSpend"], string> = {
  budget:
    "Runs the caps cannot bound (uncapped_spend in multix_catalog) need max_cost_usd and start only when their price is known and fits.",
  deny: "Runs the caps cannot bound (uncapped_spend in multix_catalog) are refused.",
  allow: "Runs the caps cannot bound (uncapped_spend in multix_catalog) are allowed.",
};

export function registerJobTools(
  server: McpServer,
  limits: Limits,
  keys: ProviderKeys,
  jobs: JobToolsContext | undefined,
  runTool: RunToolFn,
): void {
  server.registerTool(
    "multix_catalog",
    {
      title: "multix CLI catalog",
      description:
        "List the multix CLI commands this server can run with multix_run. Without group: every group, its commands and whether you saved keys for it. With group: each command's positionals and options, which ones take files (pass https URLs in inputs) and the server's caps. With task: only the commands and verified models for that task (e.g. speech). With model (group = its provider): a verified model's inputs, voices and formats; task is then ignored. Never returns key values.",
      inputSchema: toolInput({
        group: z
          .string()
          .regex(/^[a-z0-9-]{1,40}$/)
          .optional()
          .describe("Command group, e.g. gemini, replicate, media"),
        task: z.enum(TASKS).optional().describe("Task filter, e.g. speech, image, image-to-video"),
        model: z
          .string()
          .regex(MODEL_ID_RE)
          .optional()
          .describe("Model id to inspect, e.g. elevenlabs/tts/eleven-v4"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(
        "multix_catalog",
        { group: args.group, task: args.task, model: args.model },
        async () => catalogPayload(keys, args.group, { task: args.task, model: args.model }),
      ),
  );

  server.registerTool(
    "multix_model_catalog",
    {
      title: "multix model & provider catalogue",
      description:
        "Compare models and providers before running one. view providers: provider links and whether you saved keys. view models: offerings (provider + model) with tasks, the multix command and prices per configuration (resolution, audio), each with its source URL and check date. view show: one offering. view compare: quote every offering for one exact request (task, resolution, duration_s, audio, aspect_ratio, images); only prices the source confirms for that configuration are ranked, the rest are not_comparable or unknown with the reason, never $0. Price says nothing about quality. Never returns key values.",
      inputSchema: toolInput({
        view: z.enum(CATALOG_VIEWS).describe("providers, models, show or compare"),
        task: z.enum(TASKS).optional().describe("Task filter, e.g. video, image-to-video, speech"),
        provider: z
          .string()
          .regex(/^[a-z0-9-]{1,40}$/)
          .optional()
          .describe("Provider group, e.g. fal, atlas"),
        family: z
          .string()
          .regex(/^[a-z0-9.-]{1,60}$/)
          .optional()
          .describe("Model family, e.g. seedance-2.5"),
        query: z.string().max(100).optional().describe("Text in the offering id, name or family"),
        offering: z
          .string()
          .max(250)
          .optional()
          .describe("show: <provider>:<model>, e.g. fal:bytedance/seedance-2.5/text-to-video"),
        priced: z.boolean().optional().describe("models: only offerings with a current price"),
        ready: z.boolean().optional().describe("Only providers you saved keys for"),
        resolution: z.string().max(20).optional().describe("480p, 720p, 1080p or 4k"),
        duration_s: z.number().positive().max(3600).optional().describe("compare: video seconds"),
        audio: z.boolean().optional().describe("Generated audio on or off"),
        aspect_ratio: z.string().max(10).optional().describe("compare: e.g. 16:9"),
        images: z.number().int().positive().max(100).optional().describe("compare: images"),
        sort: z
          .enum(OFFERING_SORTS as [string, ...string[]])
          .optional()
          .describe("models: sort"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool(
        "multix_model_catalog",
        { view: args.view, task: args.task, provider: args.provider, offering: args.offering },
        async () => modelCatalogPayload(keys, args),
      ),
  );

  if (!jobs) return;
  const runner = new JobRunner(jobs);

  server.registerTool(
    "multix_run",
    {
      title: "Run a multix CLI command",
      description: `Run one multix CLI command in an isolated container with your saved keys. command: e.g. "gemini generate". options: by long name without dashes ({"prompt": "...", "num-images": 2, "no-webp": true}). args: positionals in order. inputs: https URLs for file options or positionals (downloaded for the CLI). Output files go to your R2 bucket (configure it in /dashboard) and come back as URLs. Waits up to wait_seconds (max ${MAX_WAIT_SECONDS}, container start included); if still running, poll multix_job_status. At most ${jobs.caps.perAccount} running jobs per account. Caps: ${limits.maxOutputs} outputs, ${limits.maxVideoSeconds} s video, resolutions ${limits.allowedResolutions.join("/")}. ${UNCAPPED_SPEND_NOTE[limits.uncappedSpend]}`,
      inputSchema: toolInput({
        command: z.string().min(1).max(100).describe("Command path from multix_catalog"),
        args: z.array(z.string()).max(20).optional(),
        options: z.record(z.string(), optionValueSchema).optional(),
        inputs: z.record(z.string(), urlListSchema).optional(),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
        estimate: z
          .boolean()
          .optional()
          .describe("Price the run (range, units, rate source) and return without starting it"),
        max_cost_usd: z
          .number()
          .min(0)
          .optional()
          .describe("Refuse to start unless the cost is at most this many USD"),
        cost_policy: z
          .enum(COST_POLICIES as [string, ...string[]])
          .optional()
          .describe(
            "With max_cost_usd: strict (proven ceiling only, default) or estimate (accept the estimated high end)",
          ),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      const fields = { command: args.command.slice(0, 100) };
      return runTool("multix_run", fields, async () => {
        const prepared = prepareRun(args, limits);
        // An estimate-only call starts nothing, so the guard does not apply to it.
        if (!args.estimate) {
          assertSpendGuard(prepared.command, prepared.uncappedSpend, limits, args.max_cost_usd);
        }
        const preflight = costPreflight(prepared.command, args);
        if (preflight) return preflight;
        return runner.run(prepared, args.wait_seconds ?? DEFAULT_WAIT_SECONDS);
      });
    },
  );

  server.registerTool(
    "multix_job_status",
    {
      title: "multix job status",
      description:
        "Read a multix_run job: status, output URLs, stdout and the tail of stderr. Poll until status is succeeded, failed, timed_out or canceled.",
      inputSchema: toolInput({ job_id: jobIdSchema }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => runTool("multix_job_status", {}, async () => runner.status(args.job_id)),
  );

  server.registerTool(
    "multix_job_cancel",
    {
      title: "Cancel a multix job",
      description:
        "Stop a running multix_run job and its container. Files not yet uploaded are lost.",
      inputSchema: toolInput({ job_id: jobIdSchema }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => runTool("multix_job_cancel", {}, async () => runner.cancel(args.job_id)),
  );
}
