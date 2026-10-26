/**
 * The CLI runner's MCP tools: discover commands, run one in a per-job
 * container, read and cancel jobs. multix_catalog only reads the caller's
 * keys and is always offered; the job tools need the job Durable Object
 * bindings (see index.ts) and are offered only when `jobs` is given.
 */

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TASKS } from "../../../src/capabilities/capability-types.js";
import type { Limits } from "../config.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { MODEL_ID_RE, catalogPayload } from "./catalog-view.js";
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
        "List the multix CLI commands this server can run with multix_run. Without group: every group, its commands and whether you saved keys for it. With group: each command's positionals and options, which ones take files (pass https URLs in inputs) and the server's caps. With task: only the commands and verified models for that task (e.g. speech). With model: a verified model's inputs, voices and formats. Never returns key values.",
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
      }),
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
