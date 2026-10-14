/**
 * OpenAPI 3.1 description of the REST API, served at /api/v1/openapi.json and
 * rendered as the human-readable reference at /api/docs. Keep it in step with
 * api-router.ts: test/rest-api.test.ts checks that every documented path and
 * method is routed.
 */

import { MAX_API_KEYS_PER_ACCOUNT } from "../accounts/api-key-store.js";
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
  "429": { $ref: "#/components/responses/RateLimited" },
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
          responses: { ...ok("Saved and removed names", ref("KeyChange")), ...ERRORS },
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
          responses: { ...ok("Saved", ref("KeyChange")), ...ERRORS },
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
            "Lists the bucket, uploads and deletes an empty `.multix-probe-*` object, and saves only if every step succeeds (422 otherwise). Use an R2 token with Object Read & Write on the bucket.",
          operationId: "putStorage",
          requestBody: jsonBody(ref("StorageInput"), {
            account_id: "0123456789abcdef0123456789abcdef",
            access_key_id: "<access key id>",
            secret_access_key: "<secret access key>",
            bucket: "multix-outputs",
            public_base_url: "https://media.example.com",
          }),
          responses: {
            ...ok("Saved", ref("Storage")),
            "422": { $ref: "#/components/responses/StorageCheckFailed" },
            ...ERRORS,
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
            ...ERRORS,
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
      },
    },
  };
}
