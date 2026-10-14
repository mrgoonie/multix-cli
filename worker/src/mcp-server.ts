/**
 * MCP tool surface. A fresh server is built per request (stateless
 * Streamable HTTP). Every tool is a CLI runner tool (jobs/job-tools.ts):
 * multix_catalog, multix_run, multix_job_status and multix_job_cancel, with
 * job state in a per-job Durable Object.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { MultixError } from "../../src/core/errors.js";
import { type Env, limitsFrom, secretValues } from "./config.js";
import type { JobToolsContext } from "./jobs/job-runner.js";
import { registerJobTools } from "./jobs/job-tools.js";
import { logEvent, sanitizeText } from "./redaction.js";

export const SERVER_NAME = "multix";

export interface ServerDeps {
  version: string;
  /** The caller's job context; the job tools are registered only when present. */
  jobs?: JobToolsContext;
}

function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Run a tool body, turning failures into MCP tool errors. Expected errors
 * (validation, job not found, busy) keep their message after secret and
 * signed-URL scrubbing; anything else becomes a generic message. Messages
 * keep the CLI's --flag wording, since multix_run takes CLI option names.
 */
async function runTool(
  env: Env,
  tool: string,
  fields: Record<string, string | undefined>,
  body: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const payload = await body();
    logEvent("info", "tool_call", { tool, ...fields, ok: true, ms: Date.now() - started });
    return ok(payload);
  } catch (error) {
    const secrets = secretValues(env);
    const expected = error instanceof MultixError;
    const raw = error instanceof Error ? error.message : String(error);
    const message = sanitizeText(raw, secrets);
    logEvent(expected ? "warn" : "error", "tool_call", {
      tool,
      ...fields,
      ok: false,
      ms: Date.now() - started,
      error: error instanceof Error ? error.name : "unknown",
      detail: message,
    });
    return toolError(expected ? message : "Internal error while running the tool");
  }
}

export function createMcpServer(env: Env, deps: ServerDeps): McpServer {
  const limits = limitsFrom(env);
  const server = new McpServer(
    { name: SERVER_NAME, version: deps.version },
    { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() },
  );

  // `env` holds only the caller's own provider keys (toolEnvFor in index.ts).
  registerJobTools(server, limits, env, deps.jobs, (tool, fields, body) =>
    runTool(env, tool, fields, body),
  );

  return server;
}
