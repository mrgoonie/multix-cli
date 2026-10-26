/**
 * MCP surface. A fresh server is built per request (stateless Streamable
 * HTTP). The CLI runner tools (jobs/job-tools.ts) are multix_catalog,
 * multix_run, multix_job_status and multix_job_cancel, with job state in a
 * per-job Durable Object. multix_usage_summary (ledger/usage-tools.ts) reads
 * the account's usage ledger when the deployment has one. Servers answering
 * protocol 2026-07-28 requests also
 * offer MCP Events (events/events-methods.ts) when the deployment has the
 * subscription store.
 */

import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { type ErrorInfo, classifyMessage } from "../../src/core/error-classify.js";
import { MultixError } from "../../src/core/errors.js";
import { type Env, limitsFrom, secretValues } from "./config.js";
import { type EventsContext, registerEventMethods } from "./events/events-methods.js";
import type { JobToolsContext } from "./jobs/job-runner.js";
import { registerJobTools } from "./jobs/job-tools.js";
import type { AccountLedgerStub } from "./ledger/account-ledger.js";
import { registerUsageTools } from "./ledger/usage-tools.js";
import { logEvent, sanitizeText } from "./redaction.js";

export const SERVER_NAME = "multix";

export interface ServerDeps {
  version: string;
  /** The caller's job context; the job tools are registered only when present. */
  jobs?: JobToolsContext;
  /**
   * Protocol era of the request: `modern` (2026-07-28, negotiated through
   * server/discover) or `legacy` (2025 initialize handshake). Defaults to legacy.
   */
  era?: "legacy" | "modern";
  /** The caller's MCP Events context; events are offered only to modern requests when present. */
  events?: EventsContext;
  /** The caller's usage ledger; multix_usage_summary is registered only when present. */
  ledger?: AccountLedgerStub;
}

function ok(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** Server-side refusals the CLI classifier does not know: both clear on their own. */
function classifyToolError(message: string): ErrorInfo {
  if (/^(busy|server at capacity):/.test(message)) {
    return { ...classifyMessage(message), code: "RATE_LIMITED", retryable: true, hint: message };
  }
  return classifyMessage(message);
}

/**
 * Tool error: the message stays the text content; structuredContent adds the
 * same classification the CLI's --json envelope uses (code, retryable, hint),
 * so agents branch on a code instead of parsing prose.
 */
function toolError(message: string): CallToolResult {
  const info = classifyToolError(message);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      error: {
        code: info.code,
        message,
        retryable: info.retryable,
        hint: info.hint,
        ...(info.retry_after_s !== undefined ? { retry_after_s: info.retry_after_s } : {}),
      },
    },
  };
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
  const events = deps.era === "modern" ? deps.events : undefined;
  const server = new McpServer(
    { name: SERVER_NAME, version: deps.version },
    {
      jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
      // `events` is the MCP Events capability (not in the SDK's typed list).
      ...(events ? { capabilities: { events: {} } as Record<string, object> } : {}),
    },
  );

  // `env` holds only the caller's own provider keys (toolEnvFor in index.ts).
  const run = (
    tool: string,
    fields: Record<string, string | undefined>,
    body: () => Promise<Record<string, unknown>>,
  ) => runTool(env, tool, fields, body);
  registerJobTools(server, limits, env, deps.jobs, run);
  registerUsageTools(server, deps.ledger, run);
  if (events) registerEventMethods(server, events);

  return server;
}
