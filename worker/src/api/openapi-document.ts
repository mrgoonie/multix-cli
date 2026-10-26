/**
 * OpenAPI 3.1 description of the REST API, served at /api/v1/openapi.json and
 * rendered as the human-readable reference at /api/docs. Keep it in step with
 * api-router.ts: test/rest-api.test.ts checks that every documented path and
 * method is routed.
 */

import { MAX_API_KEYS_PER_ACCOUNT } from "../accounts/api-key-store.js";
import { EVENT_NAMES } from "../events/event-catalog.js";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  MAX_ACTIVE_SUBSCRIPTIONS,
  MAX_SUBSCRIPTION_TTL_SECONDS,
  MIN_SUBSCRIPTION_TTL_SECONDS,
} from "../events/event-hub.js";
import { MAX_WAIT_SECONDS } from "../jobs/job-runner.js";
import {
  DEFAULT_BUDGET_THRESHOLDS,
  MAX_BUDGET_LIMIT_USD,
  MAX_BUDGET_NAME_CHARS,
  MAX_BUDGET_THRESHOLD,
  MAX_BUDGET_THRESHOLDS,
} from "../ledger/budget-input.js";
import { DEFAULT_RANGE_DAYS, MAX_RANGE_DAYS } from "../ledger/ledger-query.js";
import { MAX_IMPORT_BODY_BYTES, MAX_IMPORT_ENTRIES } from "../ledger/ledger-records.js";
import {
  BUDGET_PERIODS,
  BUDGET_SCOPE_KINDS,
  GROUP_BYS,
  OPERATION_SOURCES,
  OPERATION_STATUSES,
} from "../ledger/ledger-types.js";
import { MAX_BUDGETS, MAX_EXPORT_ROWS, MAX_PAGE_SIZE } from "../ledger/usage-ledger.js";
import {
  DEFAULT_PAGE_SIZE,
  MAX_ACTIVITY_QUERY_CHARS,
  MAX_ADJUSTMENT_USD,
  MAX_NOTE_CHARS,
} from "./usage-api-handlers.js";

type Json = Record<string, unknown>;

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });

function jsonBody(schema: Json, example: unknown): Json {
  return { required: true, content: { "application/json": { schema, example } } };
}

function ok(description: string, schema: Json, status = "200"): Json {
  return {
    [status]: { description, content: { "application/json": { schema } } },
  };
}

const ERRORS: Json = {
  "400": { $ref: "#/components/responses/BadRequest" },
  "401": { $ref: "#/components/responses/Unauthorized" },
  "403": { $ref: "#/components/responses/Forbidden" },
  "429": { $ref: "#/components/responses/RateLimited" },
};

/** Extra errors of operations that take a JSON body. */
const BODY_ERRORS: Json = {
  "413": { $ref: "#/components/responses/PayloadTooLarge" },
  "415": { $ref: "#/components/responses/UnsupportedMediaType" },
};

/** Extra error of the job operations when the server has no job containers. */
const JOB_ERRORS: Json = { "503": { $ref: "#/components/responses/Unavailable" } };

/** Extra error of the event operations when the server has no event hub. */
const EVENT_ERRORS: Json = { "503": { $ref: "#/components/responses/Unavailable" } };

/** Extra error of the usage, budget and activity operations when the server keeps no ledger. */
const LEDGER_ERRORS: Json = {
  "503": {
    description: "This server keeps no usage records (code ledger_unavailable)",
    content: { "application/json": { schema: ref("Error") } },
  },
};

const NOT_FOUND: Json = { "404": { $ref: "#/components/responses/NotFound" } };

const query = (name: string, schema: Json, description: string): Json => ({
  name,
  in: "query",
  required: false,
  schema,
  description,
});

const FILTER_VALUE_SCHEMA: Json = {
  type: "string",
  pattern: "^[A-Za-z0-9][A-Za-z0-9_.:@/+ -]{0,199}$",
};

/** Filters shared by summary, operations and export. */
const USAGE_FILTERS: Json[] = [
  query(
    "from",
    { type: "string" },
    `Start (inclusive): epoch milliseconds or an ISO date/time. Default: ${DEFAULT_RANGE_DAYS} days before \`to\`; the range may cover at most ${MAX_RANGE_DAYS} days`,
  ),
  query(
    "to",
    { type: "string" },
    "End (exclusive): epoch milliseconds or an ISO date/time. Default: now",
  ),
  query("provider", FILTER_VALUE_SCHEMA, "Provider, e.g. gemini"),
  query("model", FILTER_VALUE_SCHEMA, "Model id"),
  query("command", FILTER_VALUE_SCHEMA, "CLI command, e.g. gemini generate"),
  query("client_id", FILTER_VALUE_SCHEMA, "MCP client id or `api_key:<id>`"),
  query("project_id", FILTER_VALUE_SCHEMA, "Project id"),
  query("source", { type: "string", enum: [...OPERATION_SOURCES] }, "Where the operation ran"),
  query("status", { type: "string", enum: [...OPERATION_STATUSES] }, "Operation status"),
];

const PAGING = (cursor: string): Json[] => [
  query(
    "limit",
    { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE },
    "Page size",
  ),
  query("cursor", { type: "string" }, cursor),
];

const OP_ID = {
  name: "op_id",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
  description: "Operation id: `job_<job id>` or `cli_<history id>`",
};

const BUDGET_ID = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Budget id returned by POST /api/v1/budgets",
};

const BUDGET_EXAMPLE = {
  name: "Gemini this month",
  scope_kind: "provider",
  scope_value: "gemini",
  period: "month",
  limit_usd: 50,
  thresholds: [50, 80, 100],
};

const nullable = (type: string, extra: Json = {}): Json => ({ type: [type, "null"], ...extra });

const USAGE_TOTALS_PROPERTIES: Json = {
  operations: { type: "integer" },
  succeeded: { type: "integer" },
  failed: { type: "integer", description: "failed, timed_out and canceled" },
  running: { type: "integer" },
  success_rate: nullable("number", {
    description: "succeeded / finished; null when none finished",
  }),
  provider_reported_cost_usd: { type: "number" },
  estimated_cost_usd: { type: "number" },
  adjustments_usd: { type: "number" },
  known_cost_usd: {
    type: "number",
    description:
      "provider-reported + estimated + adjustments; operations of unknown cost add nothing",
  },
  unknown_cost_operations: {
    type: "integer",
    description: "Operations whose cost nobody reported",
  },
  credits: nullable("number"),
  tokens_input: nullable("integer"),
  tokens_output: nullable("integer"),
  output_count: { type: "integer" },
  output_bytes: { type: "integer" },
  http_errors: { type: "integer" },
  latency_p50_ms: nullable("integer"),
  latency_p95_ms: nullable("integer"),
  cost_per_successful_output_usd: nullable("number", {
    description: "null when any operation's cost is unknown or nothing succeeded with outputs",
  }),
};

const SUBSCRIPTION_ID = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Subscription id returned by POST /api/v1/events/subscriptions",
};

const JOB_ID = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
  description: "Job id returned by POST /api/v1/jobs",
};

export function openApiDocument(origin: string): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "multix REST API",
      version: "1",
      description:
        "Manage the provider keys and R2 storage of your multix account, run multix CLI commands in isolated containers, and read your usage, costs, budgets and activity log. Create an API key in /dashboard and send it as `Authorization: Bearer <key>`. Key values and R2 credentials are write-only: no response contains them. Changes can take up to a minute to reach every Cloudflare location.",
    },
    servers: [{ url: `${origin}/api/v1` }],
    security: [{ apiKey: [] }],
    paths: {
      "/me": {
        get: {
          summary: "The calling account",
          operationId: "getMe",
          responses: { ...ok("Account", ref("Me")), ...ERRORS },
        },
      },
      "/provider-keys": {
        get: {
          summary: "List provider keys",
          description:
            "Every provider key name the CLI reads, with whether it is set. Never returns values.",
          operationId: "listProviderKeys",
          responses: { ...ok("Key status", ref("ProviderKeyList")), ...ERRORS },
        },
        patch: {
          summary: "Set or remove several provider keys",
          description:
            "Each entry saves a value, or removes the key when the value is null. The whole body is validated before anything is written.",
          operationId: "patchProviderKeys",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["keys"],
              properties: {
                keys: {
                  type: "object",
                  additionalProperties: { type: ["string", "null"], maxLength: 1024 },
                },
              },
            },
            { keys: { GEMINI_API_KEY: "<value>", OPENAI_API_KEY: null } },
          ),
          responses: {
            ...ok("Saved and removed names", ref("KeyChange")),
            ...ERRORS,
            ...BODY_ERRORS,
          },
        },
      },
      "/provider-keys/{name}": {
        parameters: [
          {
            name: "name",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Provider key name, e.g. GEMINI_API_KEY (see GET /provider-keys)",
          },
        ],
        put: {
          summary: "Set one provider key",
          operationId: "putProviderKey",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["value"],
              properties: { value: { type: "string", maxLength: 1024 } },
            },
            { value: "<value>" },
          ),
          responses: { ...ok("Saved", ref("KeyChange")), ...ERRORS, ...BODY_ERRORS },
        },
        delete: {
          summary: "Remove one provider key",
          operationId: "deleteProviderKey",
          responses: { ...ok("Removed", ref("KeyChange")), ...ERRORS },
        },
      },
      "/storage": {
        get: {
          summary: "R2 storage settings",
          description:
            "Account id, bucket and public URL of the saved settings; never the access key pair.",
          operationId: "getStorage",
          responses: { ...ok("Storage", ref("Storage")), ...ERRORS },
        },
        put: {
          summary: "Check and save R2 storage settings",
          description:
            "Lists the bucket, uploads and deletes an empty `.multix-probe-*` object under the directory path, and saves only if every step succeeds (422 otherwise). Use an R2 token with Object Read & Write on the bucket.",
          operationId: "putStorage",
          requestBody: jsonBody(ref("StorageInput"), {
            account_id: "0123456789abcdef0123456789abcdef",
            access_key_id: "<access key id>",
            secret_access_key: "<secret access key>",
            bucket: "multix-outputs",
            public_base_url: "https://media.example.com",
            prefix: "agents/outputs",
          }),
          responses: {
            ...ok("Saved", ref("Storage")),
            "422": { $ref: "#/components/responses/StorageCheckFailed" },
            ...ERRORS,
            ...BODY_ERRORS,
          },
        },
        delete: {
          summary: "Remove R2 storage settings",
          operationId: "deleteStorage",
          responses: { ...ok("Removed", ref("Storage")), ...ERRORS },
        },
      },
      "/catalog": {
        get: {
          summary: "CLI commands the server can run",
          description:
            "Without group: every group, its commands and whether your saved keys cover it. With group: positionals, options, file inputs and server caps of each command.",
          operationId: "getCatalog",
          parameters: [
            {
              name: "group",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "gemini",
            },
          ],
          responses: { ...ok("Catalog", { type: "object" }), ...ERRORS },
        },
      },
      "/jobs": {
        post: {
          summary: "Run a CLI command",
          description: `Runs one multix CLI command in its own container with your saved keys. Waits up to wait_seconds (max ${MAX_WAIT_SECONDS}, container start included): 200 when the job already ended, 202 while it runs (poll GET /jobs/{id}). Output files go to your R2 bucket and come back as URLs. 429 \`busy\` when your account or the server already runs as many jobs as allowed.`,
          operationId: "runJob",
          requestBody: jsonBody(ref("RunInput"), {
            command: "gemini generate",
            options: { prompt: "a red bicycle, studio photo", "aspect-ratio": "16:9" },
            wait_seconds: 30,
          }),
          responses: {
            ...ok("Job ended", ref("Job")),
            ...ok("Job still running", ref("Job"), "202"),
            ...JOB_ERRORS,
            ...ERRORS,
            ...BODY_ERRORS,
          },
        },
      },
      "/jobs/{id}": {
        parameters: [JOB_ID],
        get: {
          summary: "Job status and outputs",
          operationId: "getJob",
          responses: {
            ...ok("Job ended", ref("Job")),
            ...ok("Job still running", ref("Job"), "202"),
            "404": { $ref: "#/components/responses/NotFound" },
            ...JOB_ERRORS,
            ...ERRORS,
          },
        },
      },
      "/jobs/{id}/cancel": {
        parameters: [JOB_ID],
        post: {
          summary: "Stop a job",
          description: "Stops the job and its container. Files not yet uploaded are lost.",
          operationId: "cancelJob",
          responses: {
            ...ok("Job", ref("Job")),
            "404": { $ref: "#/components/responses/NotFound" },
            ...JOB_ERRORS,
            ...ERRORS,
          },
        },
      },
      "/api-keys": {
        get: {
          summary: "List API keys",
          description: `Name, prefix and creation time of each key (at most ${MAX_API_KEYS_PER_ACCOUNT}). Create keys in /dashboard.`,
          operationId: "listApiKeys",
          responses: { ...ok("API keys", ref("ApiKeyList")), ...ERRORS },
        },
      },
      "/api-keys/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        delete: {
          summary: "Revoke an API key",
          description: "A key may revoke itself. Other locations may accept it for up to a minute.",
          operationId: "revokeApiKey",
          responses: {
            ...ok("Revoked", { type: "object", properties: { revoked: { type: "string" } } }),
            "404": { $ref: "#/components/responses/NotFound" },
            ...ERRORS,
          },
        },
      },
      "/events": {
        get: {
          summary: "Event catalog",
          description:
            "Every event a subscription can receive, with the JSON Schema of its `data`. Payloads carry ids, status, command, provider, timestamps and output names and sizes: never prompts, CLI output, error text, keys or URLs. Fetch the job with GET /api/v1/jobs/{id} for the rest.",
          operationId: "getEventCatalog",
          responses: { ...ok("Catalog", ref("EventCatalog")), ...ERRORS },
        },
      },
      "/events/subscriptions": {
        get: {
          summary: "List event subscriptions",
          description:
            "The calling account's webhook subscriptions, active and inactive. Secrets are never listed.",
          operationId: "listEventSubscriptions",
          responses: {
            ...ok("Subscriptions", {
              type: "object",
              properties: { subscriptions: { type: "array", items: ref("EventSubscription") } },
            }),
            ...ERRORS,
            ...EVENT_ERRORS,
          },
        },
        post: {
          summary: "Subscribe a webhook to job events",
          description: `Deliveries are POSTed to \`callback_url\` (public https, default port, not this server; every address its host resolves to must be public, checked here and again before each delivery) and signed with Standard Webhooks headers (\`webhook-id\`, \`webhook-timestamp\`, \`webhook-signature\`). Delivery is at least once: dedupe on \`webhook-id\`. Failed deliveries are retried with backoff for about a day, then dead-lettered. At most ${MAX_ACTIVE_SUBSCRIPTIONS} active subscriptions per account, counting those an MCP client made over MCP Events. The signing secret is returned only in this response.`,
          operationId: "createEventSubscription",
          requestBody: jsonBody(ref("EventSubscriptionInput"), {
            callback_url: "https://hooks.example.com/multix",
            events: ["multix.job.completed", "multix.job.failed"],
            ttl_seconds: DEFAULT_SUBSCRIPTION_TTL_SECONDS,
            description: "CI pipeline",
          }),
          responses: {
            ...ok("Created", ref("EventSubscriptionCreated"), "201"),
            "409": {
              description: `Already ${MAX_ACTIVE_SUBSCRIPTIONS} active subscriptions (code limit_reached)`,
              content: { "application/json": { schema: ref("Error") } },
            },
            ...ERRORS,
            ...BODY_ERRORS,
            ...EVENT_ERRORS,
          },
        },
      },
      "/events/subscriptions/{id}": {
        parameters: [SUBSCRIPTION_ID],
        get: {
          summary: "Get an event subscription",
          description: "Status, expiry and delivery counters of one subscription.",
          operationId: "getEventSubscription",
          responses: {
            ...ok("Subscription", {
              type: "object",
              properties: { subscription: ref("EventSubscription") },
            }),
            "404": { $ref: "#/components/responses/NotFound" },
            ...ERRORS,
            ...EVENT_ERRORS,
          },
        },
        delete: {
          summary: "Revoke an event subscription",
          description: "Stops deliveries at once and drops the ones still queued for it.",
          operationId: "revokeEventSubscription",
          responses: {
            ...ok("Revoked", { type: "object", properties: { revoked: { type: "string" } } }),
            "404": { $ref: "#/components/responses/NotFound" },
            ...ERRORS,
            ...EVENT_ERRORS,
          },
        },
      },
      "/events/dead-letters": {
        get: {
          summary: "List undelivered events",
          description:
            "Deliveries that ran out of retries, were refused permanently or were dropped, newest first.",
          operationId: "listEventDeadLetters",
          responses: {
            ...ok("Dead letters", {
              type: "object",
              properties: { dead_letters: { type: "array", items: ref("EventDeadLetter") } },
            }),
            ...ERRORS,
            ...EVENT_ERRORS,
          },
        },
      },
      "/events/audit": {
        get: {
          summary: "Event subscription audit log",
          description: "Who created, revoked, disabled or expired each subscription, newest first.",
          operationId: "listEventAudit",
          responses: {
            ...ok("Audit log", {
              type: "object",
              properties: { audit: { type: "array", items: ref("EventAuditEntry") } },
            }),
            ...ERRORS,
            ...EVENT_ERRORS,
          },
        },
      },
      "/usage/summary": {
        get: {
          summary: "Usage summary",
          description:
            "Totals over the range (operations, success rate, known cost, operations of unknown cost, tokens, latency), optional groups, a daily series and the status of every budget. A cost nobody reported is never counted as 0: it is left out of known_cost_usd and counted in unknown_cost_operations. Costs are records, not a bill.",
          operationId: "getUsageSummary",
          parameters: [
            ...USAGE_FILTERS,
            query(
              "group_by",
              { type: "string", enum: [...GROUP_BYS] },
              "Split the totals by this field",
            ),
            query(
              "tz_offset_minutes",
              { type: "integer", minimum: -840, maximum: 840, default: 0 },
              "Minutes east of UTC for the daily buckets",
            ),
          ],
          responses: { ...ok("Summary", ref("UsageSummary")), ...ERRORS, ...LEDGER_ERRORS },
        },
      },
      "/usage/operations": {
        get: {
          summary: "List operations",
          description:
            "Jobs run over MCP or REST and imported CLI runs, newest first. Unknown values (cost, tokens, credits) are null.",
          operationId: "listOperations",
          parameters: [...USAGE_FILTERS, ...PAGING("next_cursor of the previous page")],
          responses: {
            ...ok("Operations", {
              type: "object",
              properties: {
                operations: { type: "array", items: ref("Operation") },
                next_cursor: nullable("string"),
              },
            }),
            ...ERRORS,
            ...LEDGER_ERRORS,
          },
        },
      },
      "/usage/operations/{op_id}": {
        parameters: [OP_ID],
        get: {
          summary: "Get an operation",
          operationId: "getOperation",
          responses: {
            ...ok("Operation and its adjustments", {
              type: "object",
              properties: {
                operation: ref("Operation"),
                adjustments: { type: "array", items: ref("Adjustment") },
              },
            }),
            ...NOT_FOUND,
            ...ERRORS,
            ...LEDGER_ERRORS,
          },
        },
      },
      "/usage/operations/{op_id}/adjustments": {
        parameters: [OP_ID],
        post: {
          summary: "Adjust an operation's cost",
          description:
            "Adds a signed USD amount to the operation's known cost (a refund is negative). Logged as a usage.adjusted activity.",
          operationId: "createAdjustment",
          requestBody: jsonBody(ref("AdjustmentInput"), {
            kind: "refund",
            amount_usd: -0.04,
            note: "Provider refunded a failed render",
          }),
          responses: {
            ...ok("Created", ref("Adjustment"), "201"),
            ...NOT_FOUND,
            ...ERRORS,
            ...BODY_ERRORS,
            ...LEDGER_ERRORS,
          },
        },
      },
      "/usage/export": {
        get: {
          summary: "Export operations",
          description: `Up to ${MAX_EXPORT_ROWS} operations, oldest first. CSV (default): an attachment with ISO 8601 UTC times, empty cells for unknown values and cells that could start a spreadsheet formula prefixed with \`'\`; the \`x-multix-truncated: true\` header marks a capped export. JSON: \`{ operations, truncated }\`. Logged as a usage.exported activity.`,
          operationId: "exportUsage",
          parameters: [
            query(
              "format",
              { type: "string", enum: ["csv", "json"], default: "csv" },
              "Export format",
            ),
            ...USAGE_FILTERS,
          ],
          responses: {
            "200": {
              description: "Export",
              headers: {
                "x-multix-truncated": {
                  description: `Present (true) when more than ${MAX_EXPORT_ROWS} operations matched`,
                  schema: { type: "string" },
                },
              },
              content: {
                "text/csv": { schema: { type: "string" } },
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      operations: { type: "array", items: ref("Operation") },
                      truncated: { type: "boolean" },
                    },
                  },
                },
              },
            },
            ...ERRORS,
            ...LEDGER_ERRORS,
          },
        },
      },
      "/usage/import": {
        post: {
          summary: "Import CLI history",
          description: `What \`multix history push\` sends: at most ${MAX_IMPORT_ENTRIES} entries and ${MAX_IMPORT_BODY_BYTES} bytes per request. Entries are keyed by their history id, so sending a batch again only counts duplicates. Invalid entries are counted as rejected. Only measurements are kept: never prompts, arguments, paths or URLs.`,
          operationId: "importUsage",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["entries"],
              properties: {
                entries: { type: "array", maxItems: MAX_IMPORT_ENTRIES, items: ref("ImportEntry") },
              },
            },
            {
              entries: [
                {
                  id: "h_01",
                  ts: "2026-10-01T12:00:00.000Z",
                  command: "gemini generate",
                  provider: "gemini",
                  model: "gemini-2.5-flash-image",
                  ok: true,
                  duration_ms: 5200,
                  usage: { cost_usd: 0.039 },
                },
              ],
            },
          ),
          responses: {
            ...ok("Import counts", {
              type: "object",
              properties: {
                accepted: { type: "integer" },
                duplicates: { type: "integer" },
                rejected: { type: "integer" },
              },
            }),
            ...ERRORS,
            ...BODY_ERRORS,
            "413": {
              description: `Body larger than ${MAX_IMPORT_BODY_BYTES} bytes`,
              content: { "application/json": { schema: ref("Error") } },
            },
            ...LEDGER_ERRORS,
          },
        },
      },
      "/usage/data": {
        delete: {
          summary: "Delete all usage records",
          description:
            "Deletes every operation, adjustment, budget alert and activity of the account. Budgets stay; a ledger.deleted activity records the deletion. Requires `?confirm=delete`.",
          operationId: "deleteUsageData",
          parameters: [
            {
              name: "confirm",
              in: "query",
              required: true,
              schema: { type: "string", enum: ["delete"] },
            },
          ],
          responses: {
            ...ok("Deleted", { type: "object", properties: { deleted: { type: "boolean" } } }),
            ...ERRORS,
            ...LEDGER_ERRORS,
          },
        },
      },
      "/budgets": {
        get: {
          summary: "List budgets",
          description: "Every budget with its spend, forecast and crossed thresholds this period.",
          operationId: "listBudgets",
          responses: {
            ...ok("Budgets", {
              type: "object",
              properties: { budgets: { type: "array", items: ref("BudgetStatus") } },
            }),
            ...ERRORS,
            ...LEDGER_ERRORS,
          },
        },
        post: {
          summary: "Create a budget",
          description: `At most ${MAX_BUDGETS} budgets per account. Crossing a threshold is recorded once per period as a budget.threshold_crossed activity. Spend counts known costs only; unknown_cost_operations says how many operations could not be counted.`,
          operationId: "createBudget",
          requestBody: jsonBody(ref("BudgetInput"), BUDGET_EXAMPLE),
          responses: {
            ...ok("Created", ref("BudgetStatus"), "201"),
            "409": {
              description: `Already ${MAX_BUDGETS} budgets (code budget_limit)`,
              content: { "application/json": { schema: ref("Error") } },
            },
            ...ERRORS,
            ...BODY_ERRORS,
            ...LEDGER_ERRORS,
          },
        },
      },
      "/budgets/{id}": {
        parameters: [BUDGET_ID],
        get: {
          summary: "Get a budget",
          operationId: "getBudget",
          responses: {
            ...ok("Budget", ref("BudgetStatus")),
            ...NOT_FOUND,
            ...ERRORS,
            ...LEDGER_ERRORS,
          },
        },
        put: {
          summary: "Replace a budget",
          description: "Takes the full budget, as on create.",
          operationId: "updateBudget",
          requestBody: jsonBody(ref("BudgetInput"), BUDGET_EXAMPLE),
          responses: {
            ...ok("Updated", ref("BudgetStatus")),
            ...NOT_FOUND,
            ...ERRORS,
            ...BODY_ERRORS,
            ...LEDGER_ERRORS,
          },
        },
        delete: {
          summary: "Delete a budget",
          operationId: "deleteBudget",
          responses: {
            ...ok("Deleted", { type: "object", properties: { deleted: { type: "boolean" } } }),
            ...NOT_FOUND,
            ...ERRORS,
            ...LEDGER_ERRORS,
          },
        },
      },
      "/activities": {
        get: {
          summary: "Activity log",
          description:
            "Account activity, newest first: jobs, imports, exports, adjustments, budgets and alerts, and changes made with an API key (provider keys by name, storage, API keys, webhooks by host). Never key values, prompts or full URLs. Entries form a hash chain (see /activities/verify).",
          operationId: "listActivities",
          parameters: [
            query(
              "from",
              { type: "string" },
              "Start (inclusive): epoch milliseconds or an ISO date/time",
            ),
            query(
              "to",
              { type: "string" },
              "End (exclusive): epoch milliseconds or an ISO date/time",
            ),
            query(
              "kind",
              { type: "string", pattern: "^[a-z0-9_.]{1,64}$" },
              "Kind prefix, e.g. budget. or job.failed",
            ),
            query(
              "q",
              { type: "string", maxLength: MAX_ACTIVITY_QUERY_CHARS },
              "Case-insensitive text in kind, subject, actor or metadata",
            ),
            ...PAGING("next_cursor (an activity seq) of the previous page"),
          ],
          responses: {
            ...ok("Activities", {
              type: "object",
              properties: {
                activities: { type: "array", items: ref("Activity") },
                next_cursor: nullable("string"),
              },
            }),
            ...ERRORS,
            ...LEDGER_ERRORS,
          },
        },
      },
      "/activities/verify": {
        get: {
          summary: "Verify the activity log",
          description:
            "Recomputes the hash chain of the remaining activities (pruning drops the oldest). first_bad_seq is the first entry that does not match.",
          operationId: "verifyActivities",
          responses: {
            ...ok("Verification", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                checked: { type: "integer" },
                first_bad_seq: nullable("integer"),
              },
            }),
            ...ERRORS,
            ...LEDGER_ERRORS,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "An API key from /dashboard (`mxk_…`).",
        },
      },
      responses: {
        BadRequest: {
          description: "Invalid input",
          content: { "application/json": { schema: ref("Error") } },
        },
        Unauthorized: {
          description: "Missing, unknown or revoked API key",
          content: { "application/json": { schema: ref("Error") } },
        },
        Forbidden: {
          description: "The account is not on the server's sign-in allowlist",
          content: { "application/json": { schema: ref("Error") } },
        },
        PayloadTooLarge: {
          description: "Body larger than 64 KiB (512 KiB for POST /usage/import)",
          content: { "application/json": { schema: ref("Error") } },
        },
        UnsupportedMediaType: {
          description: "Content-Type is not application/json",
          content: { "application/json": { schema: ref("Error") } },
        },
        Unavailable: {
          description:
            "This server does not run jobs or deliver events, or a callback host could not be resolved (retry later)",
          content: { "application/json": { schema: ref("Error") } },
        },
        NotFound: {
          description: "Not found or not yours",
          content: { "application/json": { schema: ref("Error") } },
        },
        RateLimited: {
          description: "Rate limited or too many running jobs (code busy)",
          content: { "application/json": { schema: ref("Error") } },
        },
        StorageCheckFailed: {
          description: "R2 refused the access check; nothing was saved",
          content: { "application/json": { schema: ref("Error") } },
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: { code: { type: "string" }, message: { type: "string" } },
            },
          },
        },
        Me: {
          type: "object",
          properties: {
            id: { type: "string" },
            login: { type: "string" },
            name: { type: ["string", "null"] },
            api_key_id: { type: "string" },
          },
        },
        ProviderKeyList: {
          type: "object",
          properties: {
            keys: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  set: { type: "boolean" },
                  updated_at: { type: ["string", "null"], format: "date-time" },
                },
              },
            },
          },
        },
        KeyChange: {
          type: "object",
          properties: {
            saved: { type: "array", items: { type: "string" } },
            removed: { type: "array", items: { type: "string" } },
          },
        },
        Storage: {
          type: "object",
          properties: {
            configured: { type: "boolean" },
            account_id: { type: "string" },
            bucket: { type: "string" },
            public_base_url: { type: ["string", "null"] },
            prefix: {
              type: "string",
              description: "Directory job outputs are written under (`<prefix>/<account>/<job>/`)",
            },
          },
        },
        StorageInput: {
          type: "object",
          required: ["account_id", "access_key_id", "secret_access_key", "bucket"],
          properties: {
            account_id: { type: "string", pattern: "^[0-9a-fA-F]{32}$" },
            access_key_id: { type: "string" },
            secret_access_key: { type: "string" },
            bucket: { type: "string" },
            public_base_url: {
              type: "string",
              format: "uri",
              description:
                "Optional https base URL; without it outputs get presigned links valid up to 7 days",
            },
            prefix: {
              type: "string",
              default: "multix",
              description:
                "Optional directory path inside the bucket. Letters, digits, `.`, `_`, `-` and `/`; surrounding and repeated slashes are dropped, then the path may be at most 256 characters with no `.` or `..` segments. Omitting it on PUT resets the directory to `multix`",
            },
          },
        },
        RunInput: {
          type: "object",
          required: ["command"],
          properties: {
            command: {
              type: "string",
              description: "Command path from GET /catalog, e.g. gemini generate",
            },
            args: {
              type: "array",
              items: { type: "string" },
              maxItems: 20,
              description: "Positionals in order",
            },
            options: {
              type: "object",
              description: "Options by long name without dashes",
              additionalProperties: {
                oneOf: [
                  { type: "string" },
                  { type: "number" },
                  { type: "boolean" },
                  { type: "array", items: { type: "string" } },
                ],
              },
            },
            inputs: {
              type: "object",
              description: "https URLs for file options or positionals; downloaded for the CLI",
              additionalProperties: {
                oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
              },
            },
            wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_SECONDS },
          },
        },
        Job: {
          type: "object",
          properties: {
            job_id: { type: "string" },
            status: {
              type: "string",
              enum: ["starting", "running", "succeeded", "failed", "timed_out", "canceled"],
            },
            outputs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  url: { type: "string" },
                  bytes: { type: "integer" },
                },
              },
            },
            stdout: { type: "string" },
            stderr_tail: { type: "string" },
            exit_code: { type: ["integer", "null"] },
            error: { type: "string" },
            note: { type: "string" },
            next: { type: "object", description: "Where to poll while the job runs" },
          },
        },
        ApiKeyList: {
          type: "object",
          properties: {
            api_keys: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  prefix: { type: "string" },
                  created_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        EventCatalog: {
          type: "object",
          properties: {
            events: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", enum: [...EVENT_NAMES] },
                  description: { type: "string" },
                  data_schema: { type: "object" },
                },
              },
            },
          },
        },
        EventSubscriptionInput: {
          type: "object",
          required: ["callback_url"],
          properties: {
            callback_url: {
              type: "string",
              format: "uri",
              description:
                "Public https URL on the default port whose host resolves only to public addresses",
            },
            events: {
              type: "array",
              items: { type: "string", enum: [...EVENT_NAMES] },
              description: "Defaults to every event",
            },
            ttl_seconds: {
              type: "integer",
              minimum: MIN_SUBSCRIPTION_TTL_SECONDS,
              maximum: MAX_SUBSCRIPTION_TTL_SECONDS,
              default: DEFAULT_SUBSCRIPTION_TTL_SECONDS,
              description: "The subscription expires after this; create a new one to renew",
            },
            description: { type: "string", maxLength: 200 },
          },
        },
        EventSubscription: {
          type: "object",
          properties: {
            id: { type: "string" },
            callback_url: { type: "string", description: "Query string redacted" },
            events: { type: "array", items: { type: "string" } },
            description: { type: "string" },
            status: { type: "string", enum: ["active", "disabled", "expired"] },
            status_reason: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            expires_at: { type: "string", format: "date-time" },
            delivered_count: { type: "integer" },
            consecutive_dead_letters: { type: "integer" },
            last_success_at: { type: "string", format: "date-time" },
            last_failure_at: { type: "string", format: "date-time" },
            source: {
              type: "string",
              enum: ["mcp"],
              description: "Present on subscriptions an MCP client made over MCP Events",
            },
            job_id: {
              type: "string",
              description: "MCP subscriptions narrowed to one job receive only its events",
            },
          },
        },
        EventSubscriptionCreated: {
          type: "object",
          properties: {
            subscription: ref("EventSubscription"),
            secret: { type: "string", description: "Signing secret (`whsec_…`). Shown only once." },
            signing: { type: "object", description: "How to verify a delivery" },
          },
        },
        EventDeadLetter: {
          type: "object",
          properties: {
            id: { type: "string" },
            subscription_id: { type: "string" },
            event_id: { type: "string" },
            event: { type: "string" },
            attempts: { type: "integer" },
            reason: { type: "string" },
            last_status: { type: ["integer", "null"] },
            at: { type: "string", format: "date-time" },
          },
        },
        EventAuditEntry: {
          type: "object",
          properties: {
            at: { type: "string", format: "date-time" },
            action: { type: "string" },
            actor: { type: "string" },
            subscription_id: { type: ["string", "null"] },
            detail: { type: ["string", "null"] },
          },
        },
        Operation: {
          type: "object",
          description:
            "One job or CLI run. Unknown values are null, never 0. Never holds prompts, arguments, paths, URLs or error text.",
          properties: {
            op_id: { type: "string" },
            schema_version: { type: "integer" },
            source: { type: "string", enum: [...OPERATION_SOURCES] },
            client_id: nullable("string"),
            client_name: nullable("string"),
            project_id: nullable("string"),
            trace_id: { type: "string" },
            job_id: nullable("string"),
            history_id: nullable("string"),
            command: { type: "string" },
            provider: { type: "string" },
            model: nullable("string"),
            task: nullable("string"),
            status: { type: "string", enum: [...OPERATION_STATUSES] },
            error_code: nullable("string"),
            started_at: { type: "integer", description: "Epoch milliseconds" },
            finished_at: nullable("integer"),
            duration_ms: nullable("integer"),
            output_count: nullable("integer"),
            output_bytes: nullable("integer"),
            tokens_input: nullable("integer"),
            tokens_output: nullable("integer"),
            tokens_total: nullable("integer"),
            tokens_thinking: nullable("integer"),
            credits: nullable("number"),
            credits_unit: nullable("string"),
            estimated_cost_usd: nullable("number"),
            actual_cost_usd: nullable("number", { description: "As reported by the provider" }),
            currency: { type: "string", enum: ["USD"] },
            cost_provenance: {
              type: "string",
              enum: ["estimated", "provider_reported", "billed", "unknown"],
            },
            rate_source: nullable("string"),
            http_requests: nullable("integer"),
            http_errors: nullable("integer"),
            detail: {
              type: "object",
              description:
                "provider_ids, outputs (bytes, mime, sha256), spans, metrics, cli_version",
            },
            updated_at: { type: "integer" },
          },
        },
        Adjustment: {
          type: "object",
          properties: {
            id: { type: "string" },
            op_id: { type: "string" },
            kind: { type: "string", enum: ["refund", "correction"] },
            amount_usd: { type: "number" },
            note: nullable("string"),
            actor: { type: "string" },
            created_at: { type: "integer" },
          },
        },
        AdjustmentInput: {
          type: "object",
          required: ["kind", "amount_usd"],
          properties: {
            kind: { type: "string", enum: ["refund", "correction"] },
            amount_usd: {
              type: "number",
              minimum: -MAX_ADJUSTMENT_USD,
              maximum: MAX_ADJUSTMENT_USD,
              description: "Signed amount added to the operation's cost (a refund is negative)",
            },
            note: { type: "string", maxLength: MAX_NOTE_CHARS },
          },
        },
        UsageTotals: { type: "object", properties: USAGE_TOTALS_PROPERTIES },
        UsageSummary: {
          type: "object",
          properties: {
            from: { type: "integer" },
            to: { type: "integer" },
            tz_offset_minutes: { type: "integer" },
            totals: ref("UsageTotals"),
            group_by: nullable("string", { enum: [...GROUP_BYS, null] }),
            groups: {
              type: "array",
              items: {
                type: "object",
                properties: { key: nullable("string"), ...USAGE_TOTALS_PROPERTIES },
              },
            },
            series: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  bucket_start: { type: "integer" },
                  operations: { type: "integer" },
                  failed: { type: "integer" },
                  known_cost_usd: { type: "number" },
                  unknown_cost_operations: { type: "integer" },
                },
              },
            },
            budgets: { type: "array", items: ref("BudgetStatus") },
          },
        },
        ImportEntry: {
          type: "object",
          description: "One CLI history entry as written by the multix CLI",
          required: ["id", "ts", "command", "provider", "ok"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$" },
            ts: { type: "string", format: "date-time" },
            command: { type: "string" },
            provider: { type: "string" },
            model: { type: "string" },
            ok: { type: "boolean" },
            error_code: { type: "string" },
            duration_ms: { type: "integer" },
            version: { type: "string" },
            provider_ids: { type: "array", items: { type: "string" } },
            outputs: { type: "array", items: { type: "object" } },
            usage: {
              type: "object",
              description: "cost_usd, credits, tokens { input, output, total, thinking }, metrics",
            },
            http: { type: "object", description: "requests, errors" },
          },
        },
        BudgetInput: {
          type: "object",
          required: ["name", "scope_kind", "period", "limit_usd"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: MAX_BUDGET_NAME_CHARS },
            scope_kind: { type: "string", enum: [...BUDGET_SCOPE_KINDS] },
            scope_value: {
              ...FILTER_VALUE_SCHEMA,
              description: "Required unless scope_kind is account (then ignored)",
            },
            period: {
              type: "string",
              enum: [...BUDGET_PERIODS],
              description: "UTC calendar day, ISO week (Monday) or month",
            },
            limit_usd: { type: "number", exclusiveMinimum: 0, maximum: MAX_BUDGET_LIMIT_USD },
            thresholds: {
              type: "array",
              items: { type: "integer", minimum: 1, maximum: MAX_BUDGET_THRESHOLD },
              minItems: 1,
              maxItems: MAX_BUDGET_THRESHOLDS,
              uniqueItems: true,
              default: [...DEFAULT_BUDGET_THRESHOLDS],
              description: "Percentages of limit_usd that raise an alert once per period",
            },
          },
        },
        BudgetStatus: {
          type: "object",
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            scope_kind: { type: "string", enum: [...BUDGET_SCOPE_KINDS] },
            scope_value: nullable("string"),
            period: { type: "string", enum: [...BUDGET_PERIODS] },
            limit_usd: { type: "number" },
            thresholds: { type: "array", items: { type: "integer" } },
            created_at: { type: "integer" },
            updated_at: { type: "integer" },
            period_start: { type: "integer" },
            period_end: { type: "integer" },
            spent_usd: { type: "number", description: "Known cost in the period" },
            unknown_cost_operations: { type: "integer" },
            percent: { type: "number" },
            forecast_usd: nullable("number", {
              description: "Linear projection to the period end; a forecast, not a bill",
            }),
            state: { type: "string", enum: ["ok", "warning", "exceeded"] },
            alerts: {
              type: "array",
              items: { type: "integer" },
              description: "Thresholds already crossed this period",
            },
          },
        },
        Activity: {
          type: "object",
          properties: {
            seq: { type: "integer" },
            id: { type: "string" },
            ts: { type: "integer" },
            actor: { type: "string", description: "`api_key:<id>`, an MCP client, `system`, …" },
            kind: {
              type: "string",
              description: "e.g. job.succeeded, budget.created, provider_key.saved",
            },
            subject: nullable("string"),
            metadata: { type: "object" },
            prev_hash: { type: "string" },
            hash: { type: "string" },
          },
        },
      },
    },
  };
}
