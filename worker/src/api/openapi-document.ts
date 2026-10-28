/**
 * OpenAPI 3.1 description of the REST API, served at /api/v1/openapi.json and
 * rendered as the human-readable reference at /api/docs. Keep it in step with
 * api-router.ts: test/rest-api.test.ts checks that every documented path and
 * method is routed.
 */

import { TASKS } from "../../../src/capabilities/capability-types.js";
import { PRICE_BOOK_VIEWS } from "../../../src/catalog/price-book-view.js";
import { MAX_API_KEYS_PER_ACCOUNT } from "../accounts/api-key-store.js";
import { EVENT_NAMES } from "../events/event-catalog.js";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  MAX_ACTIVE_SUBSCRIPTIONS,
  MAX_SUBSCRIPTION_TTL_SECONDS,
  MIN_SUBSCRIPTION_TTL_SECONDS,
} from "../events/event-hub.js";
import { MAX_WAIT_SECONDS } from "../jobs/job-runner.js";

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
            "Without group: every group, its commands and whether your saved keys cover it. With group: positionals, options, file inputs and server caps of each command. With task: only the commands and verified models for that task (combine with group to stay in one group). With model (group then names its provider, task is ignored): a verified model's inputs, voices and output formats, or verified null when its inputs are unknown.",
          operationId: "getCatalog",
          parameters: [
            {
              name: "group",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "gemini",
            },
            {
              name: "task",
              in: "query",
              required: false,
              schema: { type: "string", enum: [...TASKS] },
              example: "speech",
            },
            {
              name: "model",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "elevenlabs/tts/eleven-v4",
            },
          ],
          responses: { ...ok("Catalog", { type: "object" }), ...ERRORS },
        },
      },
      "/price-book": {
        get: {
          summary: "Providers, offerings and sourced list prices",
          description:
            "The same data as multix_price_book and `multix catalog --json`. view=providers: providers with tasks, docs, pricing page and whether your saved keys cover them. view=models: offerings with price status; unknown prices stay unknown, never 0. view=show&ref=provider:model: every rate with source, check date and freshness, quoted at the configuration given. view=compare&family=…: one model family across providers at one configuration, like-for-like quotes ranked cheapest first, the rest listed with the reason they are not comparable. List prices only.",
          operationId: "getPriceBook",
          parameters: [
            {
              name: "view",
              in: "query",
              required: true,
              schema: { type: "string", enum: [...PRICE_BOOK_VIEWS] },
              example: "compare",
            },
            {
              name: "ref",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "fal:bytedance/seedance-2.0/text-to-video",
              description: "view show: <provider>:<model>",
            },
            {
              name: "family",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "seedance-2.0",
              description: "view compare (required) or models",
            },
            {
              name: "provider",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "fal",
              description: "view models: one provider group",
            },
            {
              name: "task",
              in: "query",
              required: false,
              schema: { type: "string", enum: [...TASKS] },
              example: "video",
            },
            {
              name: "priced",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description: "view models: only offerings with a current price",
            },
            {
              name: "verified",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              description: "view models: only offerings verified by multix",
            },
            {
              name: "resolution",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "720p",
            },
            {
              name: "duration",
              in: "query",
              required: false,
              schema: { type: "number", exclusiveMinimum: 0, maximum: 3600 },
              example: 10,
              description: "seconds",
            },
            {
              name: "aspect_ratio",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "16:9",
            },
            { name: "audio", in: "query", required: false, schema: { type: "boolean" } },
            {
              name: "count",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 100 },
            },
          ],
          responses: { ...ok("Price book view", { type: "object" }), ...ERRORS },
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
      },
    },
  };
}
