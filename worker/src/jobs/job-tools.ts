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
import { BudgetError } from "../../../src/core/errors.js";
import type { Limits } from "../config.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { catalogPayload } from "./catalog-view.js";
import {
  DEFAULT_WAIT_SECONDS,
  JobRunner,
  type JobToolsContext,
  MAX_WAIT_SECONDS,
} from "./job-runner.js";
import { prepareRun } from "./run-argv-builder.js";
import { MAX_INPUT_FILES } from "./run-input-files.js";
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
        "List the multix CLI commands this server can run with multix_run. Without group: every group, its commands and whether you saved keys for it. With group: each command's positionals and options, which ones take files (pass https URLs in inputs) and the server's caps. Never returns key values.",
      inputSchema: toolInput({
        group: z
          .string()
          .regex(/^[a-z0-9-]{1,40}$/)
          .optional()
          .describe("Command group, e.g. gemini, replicate, media"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool("multix_catalog", { group: args.group }, async () =>
        catalogPayload(keys, args.group),
      ),
  );

  if (!jobs) return;
  const runner = new JobRunner(jobs);

  server.registerTool(
    "multix_run",
    {
      title: "Run a multix CLI command",
      description: `Run one multix CLI command in an isolated container with your saved keys. command: e.g. "gemini generate". options: by long name without dashes ({"prompt": "...", "num-images": 2, "no-webp": true}). args: positionals in order. inputs: https URLs for file options or positionals (downloaded for the CLI). Output files go to your R2 bucket (configure it in /dashboard) and come back as URLs. Waits up to wait_seconds (max ${MAX_WAIT_SECONDS}, container start included); if still running, poll multix_job_status. At most ${jobs.caps.perAccount} running jobs per account. Caps: ${limits.maxOutputs} outputs, ${limits.maxVideoSeconds} s video, resolutions ${limits.allowedResolutions.join("/")}.`,
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
