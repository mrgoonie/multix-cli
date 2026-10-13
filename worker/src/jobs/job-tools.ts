/**
 * The CLI runner's MCP tools: discover commands, run one in a per-job
 * container, read and cancel jobs. Registered only when the server has the
 * job Durable Object binding (see index.ts).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Limits } from "../config.js";
import { catalogPayload } from "./catalog-view.js";
import {
  DEFAULT_WAIT_SECONDS,
  JobRunner,
  type JobToolsContext,
  MAX_WAIT_SECONDS,
} from "./job-runner.js";
import { prepareRun } from "./run-argv-builder.js";
import { MAX_INPUT_FILES } from "./run-input-files.js";

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

export function registerJobTools(
  server: McpServer,
  limits: Limits,
  jobs: JobToolsContext,
  runTool: RunToolFn,
): void {
  const runner = new JobRunner(jobs);

  server.registerTool(
    "multix_catalog",
    {
      title: "multix CLI catalog",
      description:
        "List the multix CLI commands this server can run with multix_run. Without group: every group, its commands and whether you saved keys for it. With group: each command's positionals and options, which ones take files (pass https URLs in inputs) and the server's caps. Never returns key values.",
      inputSchema: {
        group: z
          .string()
          .regex(/^[a-z0-9-]{1,40}$/)
          .optional()
          .describe("Command group, e.g. gemini, replicate, media"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool("multix_catalog", { group: args.group }, async () =>
        catalogPayload(jobs.keys, args.group),
      ),
  );

  server.registerTool(
    "multix_run",
    {
      title: "Run a multix CLI command",
      description: `Run one multix CLI command in an isolated container with your saved keys. command: e.g. "gemini generate". options: by long name without dashes ({"prompt": "...", "num-images": 2, "no-webp": true}). args: positionals in order. inputs: https URLs for file options or positionals (downloaded for the CLI). Output files go to your R2 bucket (configure it in /dashboard) and come back as URLs. Waits up to wait_seconds (max ${MAX_WAIT_SECONDS}); if still running, poll multix_job_status. Caps: ${limits.maxOutputs} outputs, ${limits.maxVideoSeconds} s video, resolutions ${limits.allowedResolutions.join("/")}.`,
      inputSchema: {
        command: z.string().min(1).max(100).describe("Command path from multix_catalog"),
        args: z.array(z.string()).max(20).optional(),
        options: z.record(optionValueSchema).optional(),
        inputs: z.record(urlListSchema).optional(),
        wait_seconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      const fields = { command: args.command.slice(0, 100) };
      return runTool("multix_run", fields, async () => {
        const prepared = prepareRun(args, limits);
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
      inputSchema: { job_id: jobIdSchema },
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
      inputSchema: { job_id: jobIdSchema },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => runTool("multix_job_cancel", {}, async () => runner.cancel(args.job_id)),
  );
}
