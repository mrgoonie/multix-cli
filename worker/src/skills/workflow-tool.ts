/**
 * multix_workflow: describe, start, read and cancel runs of a skill's
 * workflow (multix.workflow.json) over MCP (WorkflowManager). It cannot
 * authorize a workflow: the account does that over REST, so a model never
 * grants itself the right to run one.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MultixError } from "../../../src/core/errors.js";
import type { RunToolFn } from "../jobs/job-tools.js";
import { toolInput } from "../jobs/tool-input-schema.js";
import { type WorkflowContext, WorkflowError, WorkflowManager } from "./workflow-manager.js";
import { MAX_WORKFLOW_INPUTS, WORKFLOW_FILE } from "./workflow-manifest.js";
import { MAX_ACTIVE_RUNS } from "./workflow-store.js";

const ACTIONS = ["describe", "run", "status", "cancel", "list"] as const;

const REASON_CODES = {
  invalid: "INVALID_INPUT",
  not_found: "NOT_FOUND",
  not_authorized: "NOT_AUTHORIZED",
  conflict: "CONFLICT",
  busy: "BUSY",
  unavailable: "UNAVAILABLE",
} as const;

function required<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) {
    throw new MultixError(
      `INVALID_INPUT: ${field} is required for action=${action}`,
      "INVALID_INPUT",
    );
  }
  return value;
}

export function registerWorkflowTool(server: McpServer, ctx: WorkflowContext, runTool: RunToolFn) {
  const manager = new WorkflowManager(ctx);

  server.registerTool(
    "multix_workflow",
    {
      title: "multix skill workflows",
      description: `Run a skill's workflow: the fixed multix CLI steps in its ${WORKFLOW_FILE}, each one a multix_run job with your saved keys, under the same caps and cost checks. describe (uri): the steps, inputs, revision and digest, and whether you authorized them. A run needs your authorization for exactly that revision and digest, which only you can give over REST (POST /api/v1/workflow-authorizations with an API key from /dashboard); this tool cannot authorize, and a new revision needs a new authorization. run (uri, inputs): start a run and its first step. status (run_id): the run advances when read: it collects the finished step's outputs and starts the next step; poll until succeeded, failed or canceled. cancel (run_id) stops the run and its current job. list: your runs and authorizations. At most ${MAX_ACTIVE_RUNS} active runs.`,
      inputSchema: toolInput({
        action: z.enum(ACTIONS),
        uri: z
          .string()
          .max(512)
          .optional()
          .describe(
            "Skill URI: skill://private/<name>/SKILL.md or skill://team/<owner>/<name>/SKILL.md",
          ),
        inputs: z
          .record(z.string().max(32), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe(`Run inputs by name, as describe lists them (at most ${MAX_WORKFLOW_INPUTS})`),
        run_id: z.string().max(64).optional().describe("Run id returned by run"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      runTool("multix_workflow", { action: args.action }, async () => {
        const a = args.action;
        try {
          switch (a) {
            case "describe":
              return await manager.describe(required(args.uri, "uri", a));
            case "run":
              return await manager.start(required(args.uri, "uri", a), args.inputs);
            case "status":
              return await manager.status(required(args.run_id, "run_id", a));
            case "cancel":
              return await manager.cancel(required(args.run_id, "run_id", a));
            case "list":
              return await manager.list();
          }
        } catch (error) {
          if (!(error instanceof WorkflowError)) throw error;
          const code = REASON_CODES[error.reason];
          // "busy:" is the prefix MCP clients read as retryable (see classifyToolError).
          const prefix = error.reason === "busy" ? "busy" : code;
          throw new MultixError(`${prefix}: ${error.message}`, code);
        }
      }),
  );
}
