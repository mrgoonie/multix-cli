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
import { MAX_ACTIVITY_PAGE } from "../usage/activity-log.js";
import { MAX_BUDGETS } from "../usage/budget-engine.js";
import { MAX_RATE_ENTRIES } from "../usage/rate-card.js";
import { MAX_IMPORT_ENTRIES } from "../usage/usage-ledger.js";
import { MAX_EVENT_PAGE, MAX_EXPORT_ROWS } from "../usage/usage-queries.js";
import { RATE_UNITS, USAGE_SOURCES, USAGE_STATUSES } from "../usage/usage-types.js";
import { DELETE_CONFIRMATION, MAX_IMPORT_BODY_BYTES } from "./usage-api-handlers.js";

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

/** Extra error of the usage operations when the server keeps no usage ledger. */
const USAGE_ERRORS: Json = { "503": { $ref: "#/components/responses/Unavailable" } };

const TIME_PARAM = (name: string): Json => ({
  name,
  in: "query",
  required: false,
  schema: { type: "string" },
  description: "ISO date or time, or epoch milliseconds",
});

const FILTER_VALUE = { type: "string", pattern: "^[A-Za-z0-9._:/ -]{1,128}$" };

/** Filters shared by the usage summary, event list and export. */
const USAGE_FILTERS: Json[] = [
  {
    ...TIME_PARAM("from"),
    description: "Start (inclusive): ISO date or time, or epoch ms. Default: 30 days before `to`",
  },
  {
    ...TIME_PARAM("to"),
    description:
      "End (exclusive): ISO date or time, or epoch ms; a date-only value includes that day. Default: now",
  },
  ...["provider", "model", "project", "client", "command"].map((name) => ({
    name,
    in: "query",
    required: false,
    schema: FILTER_VALUE,
  })),
  {
    name: "source",
    in: "query",
    required: false,
    schema: { type: "string", enum: [...USAGE_SOURCES] },
  },
  {
    name: "status",
    in: "query",
    required: false,
    schema: { type: "string", enum: [...USAGE_STATUSES] },
  },
  {
    name: "q",
    in: "query",
    required: false,
    schema: { type: "string", maxLength: 100 },
    description: "Substring of command, model, provider or error code",
  },
];

const TZ_PARAM: Json = {
  name: "tz",
  in: "query",
  required: false,
  schema: { type: "integer", minimum: -840, maximum: 840, default: 0 },
  description: "Offset from UTC in minutes for day and week buckets, e.g. 420 for UTC+7",
};

const USAGE_EVENT_ID = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Usage event id: the job id, or `cli_<history id>` for imported runs",
};

const BUDGET_ID = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Budget id returned by POST /api/v1/budgets",
};

const nullable = (type: string): Json => ({ type: [type, "null"] });

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
        "Manage the provider keys and R2 storage of your multix account and run multix CLI commands in isolated containers. Create an API key in /dashboard and send it as `Authorization: Bearer <key>`. Key values and R2 credentials are write-only: no response contains them. Changes can take up to a minute to reach every Cloudflare location.",
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
          description: `Runs one multix CLI command in its own container with your saved keys. Waits up to wait_seconds (max ${MAX_WAIT_SECONDS}, container start included): 200 when the job already ended, 202 while it runs (poll GET /jobs/{id}). Output files go to your R2 bucket and come back as URLs. 429 \`busy\` when your account or the server already runs as many jobs as allowed; 402 \`budget_exceeded\` when a blocking budget refuses it. \`project\` labels the run for usage reports and project budgets.`,
          operationId: "runJob",
          requestBody: jsonBody(ref("RunInput"), {
            command: "gemini generate",
            options: { prompt: "a red bicycle, studio photo", "aspect-ratio": "16:9" },
            wait_seconds: 30,
          }),
          responses: {
            ...ok("Job ended", ref("Job")),
            ...ok("Job still running", ref("Job"), "202"),
            "402": {
              description:
                "A blocking budget refused the run (code budget_exceeded); nothing was started",
              content: { "application/json": { schema: ref("Error") } },
            },
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
            "KPIs, a time series (hour, day or week buckets picked from the range) and breakdowns by provider, model, source, command, client, project and status. A cost nobody measured counts in `unknownCostRuns`, never as $0. Default range: the last 30 days.",
          operationId: "getUsageSummary",
          parameters: [...USAGE_FILTERS, TZ_PARAM],
          responses: { ...ok("Summary", ref("UsageSummary")), ...ERRORS, ...USAGE_ERRORS },
        },
      },
      "/usage/events": {
        get: {
          summary: "List usage events",
          description: `Newest first, at most ${MAX_EVENT_PAGE} per page. Pass \`next\` back as \`cursor\` for the following page.`,
          operationId: "listUsageEvents",
          parameters: [
            ...USAGE_FILTERS,
            { name: "cursor", in: "query", required: false, schema: { type: "string" } },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: MAX_EVENT_PAGE, default: 50 },
            },
          ],
          responses: {
            ...ok("Events", {
              type: "object",
              properties: {
                items: { type: "array", items: ref("UsageEvent") },
                next: { type: ["string", "null"] },
              },
            }),
            ...ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/usage/events/{id}": {
        parameters: [USAGE_EVENT_ID],
        get: {
          summary: "Get a usage event",
          operationId: "getUsageEvent",
          responses: {
            ...ok("Event with its adjustments", ref("UsageEventDetail")),
            "404": { $ref: "#/components/responses/NotFound" },
            ...ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/usage/events/{id}/adjustments": {
        parameters: [USAGE_EVENT_ID],
        post: {
          summary: "Adjust the cost of a usage event",
          description:
            "`refund` (positive, subtracted), `correction` (signed) or `billed` (what the provider actually charged; replaces the reported or estimated cost, 0 means not charged).",
          operationId: "adjustUsageEvent",
          requestBody: jsonBody(ref("AdjustmentInput"), {
            kind: "refund",
            amountUsd: 0.12,
            reason: "Provider refunded a failed render",
          }),
          responses: {
            ...ok("Recorded", ref("Adjustment"), "201"),
            "404": { $ref: "#/components/responses/NotFound" },
            ...ERRORS,
            ...BODY_ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/usage/export": {
        get: {
          summary: "Export usage events",
          description: `CSV (default) or JSON, newest first, at most ${MAX_EXPORT_ROWS} rows. When more rows match, the response has \`x-multix-truncated: true\` (and \`truncated\` in JSON): narrow the range. CSV cells that a spreadsheet would run as a formula are prefixed with \`'\`.`,
          operationId: "exportUsage",
          parameters: [
            ...USAGE_FILTERS,
            {
              name: "format",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["csv", "json"], default: "csv" },
            },
          ],
          responses: {
            "200": {
              description: "Export",
              headers: {
                "x-multix-truncated": {
                  description: "Present when more rows matched than were exported",
                  schema: { type: "string", enum: ["true"] },
                },
              },
              content: {
                "text/csv": { schema: { type: "string" } },
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: ref("UsageEvent") },
                      truncated: { type: "boolean" },
                    },
                  },
                },
              },
            },
            ...ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/usage/import": {
        post: {
          summary: "Import CLI history",
          description: `What \`multix history sync\` sends: at most ${MAX_IMPORT_ENTRIES} entries and ${MAX_IMPORT_BODY_BYTES / 1024} KiB per request. Entries are keyed by their history id, so re-sending one counts it in \`duplicates\` instead of importing it twice. Invalid entries are listed in \`rejected\`; the rest are imported.`,
          operationId: "importUsage",
          requestBody: jsonBody(ref("UsageImportInput"), {
            project: "website",
            entries: [
              {
                id: "h_01J0000000000000000000000",
                ts: "2026-10-01T09:30:00.000Z",
                duration_ms: 8200,
                command: "gemini image",
                provider: "gemini",
                model: "gemini-2.5-flash-image",
                ok: true,
                exit_code: 0,
                outputs: [{ ext: "png", bytes: 524288 }],
                usage: { cost_usd: 0.039 },
              },
            ],
          }),
          responses: {
            ...ok("Import result", ref("UsageImportResult")),
            ...ERRORS,
            ...BODY_ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/usage": {
        delete: {
          summary: "Delete all usage records",
          description:
            "Deletes every usage event, adjustment, reservation and stored balance of the account. Budgets, the rate card and the activity log stay. Requires `confirm=delete-all-usage`.",
          operationId: "deleteUsage",
          parameters: [
            {
              name: "confirm",
              in: "query",
              required: true,
              schema: { type: "string", enum: [DELETE_CONFIRMATION] },
            },
          ],
          responses: {
            ...ok("Deleted", { type: "object", properties: { deleted: { type: "integer" } } }),
            ...ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/budgets": {
        get: {
          summary: "List budgets",
          description:
            "Each budget with its current window, actual, estimated and held USD, percent used and a linear forecast (a projection, not a bill).",
          operationId: "listBudgets",
          responses: {
            ...ok("Budgets", {
              type: "object",
              properties: { budgets: { type: "array", items: ref("BudgetStatus") } },
            }),
            ...ERRORS,
            ...USAGE_ERRORS,
          },
        },
        post: {
          summary: "Create a budget",
          description: `At most ${MAX_BUDGETS} per account. A \`block\` budget refuses new Multix jobs that would exceed the limit; \`alert\` only records threshold crossings in the activity log.`,
          operationId: "createBudget",
          requestBody: jsonBody(ref("BudgetInput"), {
            name: "Monthly cap",
            scope: "account",
            period: "month",
            limitUsd: 50,
            mode: "block",
            unknownPrice: "allow",
            thresholds: [50, 80, 100],
          }),
          responses: {
            ...ok("Created", ref("Budget"), "201"),
            ...ERRORS,
            ...BODY_ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/budgets/{id}": {
        parameters: [BUDGET_ID],
        patch: {
          summary: "Change a budget",
          description: "Fields not sent keep their current value.",
          operationId: "updateBudget",
          requestBody: jsonBody({ ...ref("BudgetInput"), required: [] }, { limitUsd: 80 }),
          responses: {
            ...ok("Updated", ref("Budget")),
            "404": { $ref: "#/components/responses/NotFound" },
            ...ERRORS,
            ...BODY_ERRORS,
            ...USAGE_ERRORS,
          },
        },
        delete: {
          summary: "Delete a budget",
          operationId: "deleteBudget",
          responses: {
            "204": { description: "Deleted" },
            "404": { $ref: "#/components/responses/NotFound" },
            ...ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/activities": {
        get: {
          summary: "Account activity log",
          description:
            "Key, storage, subscription, budget and rate-card changes, imports, exports and deletions, newest first. Entries carry names and ids, never key values. Pass `next` back as `before` for the following page.",
          operationId: "listActivities",
          parameters: [
            {
              name: "kind",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Exact kind, or a prefix ending in `.` such as `budget.`",
            },
            { name: "q", in: "query", required: false, schema: { type: "string" } },
            TIME_PARAM("from"),
            TIME_PARAM("to"),
            { name: "before", in: "query", required: false, schema: { type: "integer" } },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: MAX_ACTIVITY_PAGE, default: 50 },
            },
          ],
          responses: {
            ...ok("Activities", {
              type: "object",
              properties: {
                items: { type: "array", items: ref("Activity") },
                next: { type: ["integer", "null"] },
              },
            }),
            ...ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/activities/verify": {
        get: {
          summary: "Verify the activity log",
          description:
            "Recomputes the hash chain; `brokenAtSeq` names the first entry that was edited or removed.",
          operationId: "verifyActivities",
          responses: {
            ...ok("Verification", {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                checked: { type: "integer" },
                brokenAtSeq: { type: ["integer", "null"] },
              },
            }),
            ...ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/rate-card": {
        get: {
          summary: "Rate card",
          description: "Prices used to estimate the cost of runs whose provider reports none.",
          operationId: "getRateCard",
          responses: { ...ok("Rate card", ref("RateCard")), ...ERRORS, ...USAGE_ERRORS },
        },
        put: {
          summary: "Replace the rate card",
          description: `At most ${MAX_RATE_ENTRIES} entries; the whole card is replaced.`,
          operationId: "putRateCard",
          requestBody: jsonBody(ref("RateCard"), {
            entries: [
              {
                provider: "gemini",
                model: "*",
                unit: "output",
                usd: 0.039,
                effectiveFrom: "2026-10-01",
                version: "pricing page 2026-10",
              },
            ],
          }),
          responses: {
            ...ok("Rate card", ref("RateCard")),
            ...ERRORS,
            ...BODY_ERRORS,
            ...USAGE_ERRORS,
          },
        },
      },
      "/balances": {
        get: {
          summary: "Stored provider balances",
          description: "The balances saved by the last refresh.",
          operationId: "listBalances",
          responses: { ...ok("Balances", ref("BalanceList")), ...ERRORS, ...USAGE_ERRORS },
        },
      },
      "/balances/refresh": {
        post: {
          summary: "Refresh provider balances",
          description:
            "Reads live balances with your saved keys (OpenRouter credits, ElevenLabs character quota) and stores them. Other providers you have a key for are listed as `unsupported`; a refused key is `forbidden`.",
          operationId: "refreshBalances",
          responses: { ...ok("Balances", ref("BalanceList")), ...ERRORS, ...USAGE_ERRORS },
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
          description: "Body larger than 64 KiB",
          content: { "application/json": { schema: ref("Error") } },
        },
        UnsupportedMediaType: {
          description: "Content-Type is not application/json",
          content: { "application/json": { schema: ref("Error") } },
        },
        Unavailable: {
          description:
            "This server does not run jobs, deliver events or keep usage records, or a callback host could not be resolved (retry later)",
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
            project: {
              type: "string",
              pattern: "^[A-Za-z0-9._-]{1,64}$",
              description:
                "Optional label that groups the run in the usage ledger and in project budgets",
            },
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
        UsageEvent: {
          type: "object",
          description:
            "One run. Costs are USD; a cost nobody measured is null, never 0. `provenance` says where a cost came from, `chargeState` whether the provider may have charged.",
          properties: {
            id: { type: "string" },
            source: { type: "string", enum: [...USAGE_SOURCES] },
            clientId: nullable("string"),
            project: nullable("string"),
            jobId: nullable("string"),
            historyId: nullable("string"),
            command: { type: "string" },
            provider: { type: "string" },
            modelRequested: nullable("string"),
            modelResolved: nullable("string"),
            status: { type: "string", enum: [...USAGE_STATUSES] },
            errorCode: nullable("string"),
            startedAt: { type: "integer", description: "Epoch ms" },
            finishedAt: nullable("integer"),
            durationMs: nullable("integer"),
            outputCount: nullable("integer"),
            outputBytes: nullable("integer"),
            outputs: { type: "array", items: { type: "object" } },
            tokensInput: nullable("integer"),
            tokensOutput: nullable("integer"),
            credits: nullable("number"),
            estimatedCostUsd: nullable("number"),
            actualCostUsd: nullable("number"),
            adjustmentUsd: { type: "number" },
            currency: { type: "string", enum: ["USD"] },
            rateVersion: nullable("string"),
            provenance: {
              type: "string",
              enum: ["provider_reported", "estimated", "billed", "unknown"],
            },
            chargeState: { type: "string", enum: ["charged", "uncertain", "no_charge", "pending"] },
          },
        },
        UsageEventDetail: {
          type: "object",
          properties: {
            event: ref("UsageEvent"),
            adjustments: { type: "array", items: ref("Adjustment") },
            hasDebugLog: { type: "boolean" },
          },
        },
        AdjustmentInput: {
          type: "object",
          required: ["kind", "amountUsd", "reason"],
          properties: {
            kind: { type: "string", enum: ["refund", "correction", "billed"] },
            amountUsd: { type: "number", minimum: -100000, maximum: 100000 },
            reason: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        Adjustment: {
          type: "object",
          properties: {
            id: { type: "string" },
            eventId: { type: "string" },
            kind: { type: "string", enum: ["refund", "correction", "billed"] },
            amountUsd: { type: "number", description: "Refunds are stored negative" },
            reason: { type: "string" },
            actor: { type: "string" },
            createdAt: { type: "integer" },
          },
        },
        UsageSummary: {
          type: "object",
          properties: {
            filter: { type: "object" },
            bucket: { type: "string", enum: ["hour", "day", "week"] },
            tzOffsetMinutes: { type: "integer" },
            kpis: {
              type: "object",
              description:
                "jobs, succeeded, failed, rejected, successRate, actualUsd, estimatedUsd, adjustmentsUsd, knownUsd, unknownCostRuns, uncertainRuns, credits, outputs, outputBytes, costPerOutputUsd, costPerSucceededRunUsd, p50Ms, p95Ms, httpRequests, httpErrors, tokensInput, tokensOutput",
            },
            series: { type: "array", items: { type: "object" } },
            breakdown: {
              type: "object",
              description:
                "Top rows by provider, model, source, command, client, project and status",
            },
          },
        },
        UsageImportInput: {
          type: "object",
          required: ["entries"],
          properties: {
            entries: {
              type: "array",
              maxItems: MAX_IMPORT_ENTRIES,
              items: {
                type: "object",
                required: ["id", "ts", "duration_ms", "command", "provider", "ok", "exit_code"],
                properties: {
                  id: { type: "string", pattern: "^h_[A-Za-z0-9_-]{1,64}$" },
                  ts: { type: "string", format: "date-time" },
                  duration_ms: { type: "integer" },
                  version: { type: "string" },
                  command: { type: "string" },
                  provider: { type: "string" },
                  model: { type: "string" },
                  ok: { type: "boolean" },
                  exit_code: { type: "integer" },
                  error_code: { type: "string" },
                  outputs: { type: "array", items: { type: "object" } },
                  usage: { type: "object" },
                  http: { type: "object" },
                  provider_ids: { type: "array", items: { type: "string" } },
                },
              },
            },
            project: { type: "string", pattern: "^[A-Za-z0-9._-]{1,64}$" },
          },
        },
        UsageImportResult: {
          type: "object",
          properties: {
            accepted: { type: "integer" },
            duplicates: { type: "integer" },
            rejected: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string" }, reason: { type: "string" } },
              },
            },
          },
        },
        BudgetInput: {
          type: "object",
          required: ["name", "scope", "period", "limitUsd"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 80 },
            scope: {
              type: "string",
              enum: ["account", "project", "provider", "model", "client", "task"],
            },
            scopeValue: { type: "string", description: "Required unless scope is account" },
            period: { type: "string", enum: ["day", "week", "month", "custom"] },
            windowStart: { type: "integer", description: "Epoch ms; custom period only" },
            windowEnd: { type: "integer", description: "Epoch ms; custom period only" },
            limitUsd: { type: "number", minimum: 0.01, maximum: 1000000 },
            mode: { type: "string", enum: ["alert", "block"], default: "alert" },
            reserveUsd: { type: ["number", "null"], minimum: 0, maximum: 10000 },
            unknownPrice: { type: "string", enum: ["allow", "block"], default: "allow" },
            thresholds: {
              type: "array",
              maxItems: 5,
              items: { type: "integer", minimum: 1, maximum: 1000 },
              default: [50, 80, 100],
            },
          },
        },
        Budget: {
          allOf: [
            ref("BudgetInput"),
            {
              type: "object",
              properties: {
                id: { type: "string" },
                createdAt: { type: "integer" },
                updatedAt: { type: "integer" },
              },
            },
          ],
        },
        BudgetStatus: {
          type: "object",
          properties: {
            budget: ref("Budget"),
            window: {
              type: "object",
              properties: { start: { type: "integer" }, end: { type: "integer" } },
            },
            actualUsd: { type: "number" },
            estimatedUsd: { type: "number" },
            heldUsd: { type: "number" },
            committedUsd: { type: "number" },
            unknownRuns: { type: "integer" },
            percent: { type: "number" },
            forecastUsd: nullable("number"),
            crossed: { type: "array", items: { type: "integer" } },
          },
        },
        Activity: {
          type: "object",
          properties: {
            seq: { type: "integer" },
            ts: { type: "integer" },
            actor: {
              type: "string",
              description: "`dashboard:<user>`, `api_key:<key id>`, `mcp:<client>` or `system`",
            },
            kind: { type: "string" },
            target: nullable("string"),
            meta: { type: "object" },
            hash: { type: "string" },
          },
        },
        RateCard: {
          type: "object",
          required: ["entries"],
          properties: {
            entries: {
              type: "array",
              maxItems: MAX_RATE_ENTRIES,
              items: {
                type: "object",
                required: ["provider", "unit", "usd", "effectiveFrom", "version"],
                properties: {
                  provider: { type: "string" },
                  model: { type: "string", default: "*" },
                  unit: { type: "string", enum: [...RATE_UNITS] },
                  usd: { type: "number", minimum: 0, maximum: 10000 },
                  effectiveFrom: { type: "string", format: "date" },
                  version: { type: "string" },
                },
              },
            },
          },
        },
        BalanceList: {
          type: "object",
          properties: {
            balances: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  provider: { type: "string" },
                  status: {
                    type: "string",
                    enum: ["ok", "no_key", "unsupported", "forbidden", "error"],
                  },
                  checkedAt: { type: "integer" },
                  kind: {
                    type: ["string", "null"],
                    enum: ["cash", "credits", "subscription_quota", null],
                  },
                  unit: nullable("string"),
                  remaining: nullable("number"),
                  used: nullable("number"),
                  limit: nullable("number"),
                  detail: nullable("string"),
                },
              },
            },
          },
        },
      },
    },
  };
}
