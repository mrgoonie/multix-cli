/**
 * OpenAPI 3.1 description of the REST API, served at /api/v1/openapi.json and
 * rendered as the human-readable reference at /api/docs. Keep it in step with
 * api-router.ts: test/rest-api.test.ts checks that every documented path and
 * method is routed.
 */

import { TASKS } from "../../../src/capabilities/capability-types.js";
import { MAX_API_KEYS_PER_ACCOUNT } from "../accounts/api-key-store.js";
import { EVENT_NAMES } from "../events/event-catalog.js";
import {
  DEFAULT_SUBSCRIPTION_TTL_SECONDS,
  MAX_ACTIVE_SUBSCRIPTIONS,
  MAX_SUBSCRIPTION_TTL_SECONDS,
  MIN_SUBSCRIPTION_TTL_SECONDS,
} from "../events/event-hub.js";
import { MAX_WAIT_SECONDS } from "../jobs/job-runner.js";
import { MAX_WORKFLOW_COST_USD } from "../skills/workflow-manager.js";
import { MAX_ACTIVE_RUNS, MAX_AUTHORIZATIONS } from "../skills/workflow-store.js";

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

/** Extra errors of the skills operations: no skills store, a stale expected digest or revision. */
const SKILL_ERRORS: Json = {
  "404": { $ref: "#/components/responses/NotFound" },
  "409": { $ref: "#/components/responses/Conflict" },
  "503": { $ref: "#/components/responses/Unavailable" },
};

const SKILL_NAME = {
  name: "skill",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 },
  description: "Skill name, as in its SKILL.md frontmatter",
};

const REVISION = {
  name: "revision",
  in: "path",
  required: true,
  schema: { type: "integer", minimum: 1 },
  description: "Revision number",
};

const EXPECTED_REVISION = {
  type: ["integer", "null"],
  minimum: 1,
  description: "Served revision you last saw (null: none is served); 409 if it changed",
};

const SKILL_SETTINGS: Json = {
  visibility: { type: "string", enum: ["private", "team"] },
  tags: { type: "array", items: { type: "string", maxLength: 32 } },
  capabilities: { type: "array", items: { type: "string" } },
};

const optionalJsonBody = (schema: Json, example: unknown): Json => ({
  ...jsonBody(schema, example),
  required: false,
});

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

const WORKFLOW_RUN_ID = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Run id returned by POST /api/v1/workflow-runs",
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
      "/model-catalog": {
        get: {
          summary: "Model & provider catalogue",
          description:
            "The same views as `multix catalog --json`. view=providers: provider links and whether your saved keys cover each. view=models (default): offerings (provider + model) with tasks, the multix command and prices per configuration, each with its source URL and check date; a price that is unknown, unverified or stale says so and is never $0. view=show&offering=<provider>:<model>: one offering. view=compare: quote every offering for one exact request (task, resolution, duration_s, audio, aspect_ratio, images); only prices the source confirms for that configuration are ranked.",
          operationId: "getModelCatalog",
          parameters: [
            {
              name: "view",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["providers", "models", "show", "compare"] },
              example: "compare",
            },
            {
              name: "task",
              in: "query",
              required: false,
              schema: { type: "string", enum: [...TASKS] },
              example: "video",
            },
            {
              name: "provider",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "fal",
            },
            {
              name: "family",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "seedance-2.5",
            },
            { name: "q", in: "query", required: false, schema: { type: "string" } },
            {
              name: "offering",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "fal:bytedance/seedance-2.5/text-to-video",
            },
            { name: "priced", in: "query", required: false, schema: { type: "boolean" } },
            { name: "ready", in: "query", required: false, schema: { type: "boolean" } },
            {
              name: "resolution",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "720p",
            },
            {
              name: "duration_s",
              in: "query",
              required: false,
              schema: { type: "number" },
              example: 10,
            },
            {
              name: "audio",
              in: "query",
              required: false,
              schema: { type: "boolean" },
              example: true,
            },
            {
              name: "aspect_ratio",
              in: "query",
              required: false,
              schema: { type: "string" },
              example: "16:9",
            },
            { name: "images", in: "query", required: false, schema: { type: "integer" } },
            {
              name: "sort",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["id", "provider", "price", "checked"] },
            },
          ],
          responses: { ...ok("Catalogue view", { type: "object" }), ...ERRORS },
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
      "/skills": {
        get: {
          summary: "List your skills",
          description:
            "Your skills (served or not), the names of your drafts, and the team skills of other accounts you added with POST /skill-shares (`available` is false once the owner revoked, unpublished or deleted it).",
          operationId: "listSkills",
          responses: { ...ok("Skills", ref("SkillList")), ...ERRORS, ...SKILL_ERRORS },
        },
      },
      "/skills/{skill}": {
        parameters: [SKILL_NAME],
        get: {
          summary: "One skill",
          description: "Settings, the served revision with its files, the draft and the grants.",
          operationId: "getSkill",
          responses: { ...ok("Skill", ref("SkillDetail")), ...ERRORS, ...SKILL_ERRORS },
        },
        patch: {
          summary: "Change visibility, tags or capabilities",
          description:
            "A visibility change revokes every grant; the revoked account ids are returned.",
          operationId: "updateSkill",
          requestBody: jsonBody(
            {
              type: "object",
              properties: { ...SKILL_SETTINGS, expected_revision: EXPECTED_REVISION },
            },
            { visibility: "team", tags: ["brand"] },
          ),
          responses: {
            ...ok("Updated", {
              type: "object",
              properties: {
                skill: ref("Skill"),
                revoked_grants: { type: "array", items: { type: "string" } },
              },
            }),
            ...ERRORS,
            ...BODY_ERRORS,
            ...SKILL_ERRORS,
          },
        },
        delete: {
          summary: "Delete a skill",
          description: "Removes every revision, the draft and the grants.",
          operationId: "deleteSkill",
          responses: {
            ...ok("Deleted", {
              type: "object",
              properties: {
                deleted: { type: "boolean" },
                name: { type: "string" },
                revoked_grants: { type: "array", items: { type: "string" } },
              },
            }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skills/{skill}/draft": {
        parameters: [SKILL_NAME],
        get: {
          summary: "The draft",
          operationId: "getSkillDraft",
          responses: {
            ...ok("Draft", { type: "object", properties: { draft: ref("SkillDraft") } }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
        put: {
          summary: "Create or update the draft",
          description:
            "Adds or replaces files (`text`, or `base64` for any file type) and removes `delete` paths. A new draft starts from the served revision, from `from_revision`, or from nothing with `replace`. One update carries at most 8 MiB of decoded files; upload a larger skill in several updates. Send `expected_digest` (null when you expect no draft) to get 409 instead of overwriting another change.",
          operationId: "putSkillDraft",
          requestBody: jsonBody(ref("SkillDraftInput"), {
            files: [
              {
                path: "SKILL.md",
                text: "---\nname: brand-voice\ndescription: Write in our brand voice\n---\n\nUse short sentences.",
              },
            ],
            expected_digest: null,
          }),
          responses: {
            ...ok("Draft", { type: "object", properties: { draft: ref("SkillDraft") } }),
            ...ERRORS,
            ...BODY_ERRORS,
            ...SKILL_ERRORS,
          },
        },
        delete: {
          summary: "Discard the draft",
          operationId: "deleteSkillDraft",
          parameters: [
            {
              name: "expected_digest",
              in: "query",
              schema: { type: "string" },
              description: "Draft digest you last saw; 409 if it changed",
            },
          ],
          responses: {
            ...ok("Discarded", { type: "object", properties: { discarded: { type: "boolean" } } }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skills/{skill}/files": {
        parameters: [SKILL_NAME],
        get: {
          summary: "Read one file",
          description:
            "A file of the draft, or of a stored revision with `revision`. Text files come back as `text`, others as `base64`.",
          operationId: "getSkillFile",
          parameters: [
            { name: "path", in: "query", required: true, schema: { type: "string" } },
            { name: "revision", in: "query", schema: { type: "integer", minimum: 1 } },
          ],
          responses: { ...ok("File", ref("SkillFileContent")), ...ERRORS, ...SKILL_ERRORS },
        },
      },
      "/skills/{skill}/publish": {
        parameters: [SKILL_NAME],
        post: {
          summary: "Publish the draft",
          description:
            "The draft becomes the next immutable revision and is served at the skill's `skill://` URI; the draft is removed. Settings in the body apply with it.",
          operationId: "publishSkill",
          requestBody: optionalJsonBody(
            {
              type: "object",
              properties: {
                ...SKILL_SETTINGS,
                expected_digest: { type: "string" },
                expected_revision: EXPECTED_REVISION,
              },
            },
            { visibility: "private" },
          ),
          responses: {
            ...ok("Published", ref("ServedSkill"), "201"),
            ...ERRORS,
            ...BODY_ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skills/{skill}/revisions": {
        parameters: [SKILL_NAME],
        get: {
          summary: "List revisions",
          operationId: "listSkillRevisions",
          responses: {
            ...ok("Revisions", {
              type: "object",
              properties: {
                current_revision: { type: ["integer", "null"] },
                revisions: { type: "array", items: ref("SkillRevisionSummary") },
              },
            }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skills/{skill}/revisions/{revision}": {
        parameters: [SKILL_NAME, REVISION],
        get: {
          summary: "One revision with its files",
          operationId: "getSkillRevision",
          responses: {
            ...ok("Revision", { type: "object", properties: { revision: ref("SkillRevision") } }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
        delete: {
          summary: "Delete a stored revision",
          description: "The served revision cannot be deleted; its number is never reused.",
          operationId: "deleteSkillRevision",
          responses: {
            ...ok("Deleted", {
              type: "object",
              properties: { deleted: { type: "boolean" }, revision: { type: "integer" } },
            }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skills/{skill}/current": {
        parameters: [SKILL_NAME],
        post: {
          summary: "Serve another revision (roll back or forward)",
          operationId: "setSkillCurrent",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["revision"],
              properties: {
                revision: { type: "integer", minimum: 1 },
                expected_revision: EXPECTED_REVISION,
              },
            },
            { revision: 1, expected_revision: 2 },
          ),
          responses: {
            ...ok("Served", ref("ServedSkill")),
            ...ERRORS,
            ...BODY_ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skills/{skill}/unpublish": {
        parameters: [SKILL_NAME],
        post: {
          summary: "Stop serving the skill",
          description: "Keeps its revisions; publish or set a current revision to serve it again.",
          operationId: "unpublishSkill",
          requestBody: optionalJsonBody(
            { type: "object", properties: { expected_revision: EXPECTED_REVISION } },
            { expected_revision: 2 },
          ),
          responses: {
            ...ok("Unpublished", { type: "object", properties: { skill: ref("Skill") } }),
            ...ERRORS,
            ...BODY_ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skills/{skill}/grants": {
        parameters: [SKILL_NAME],
        get: {
          summary: "Accounts a team skill is shared with",
          operationId: "listSkillGrants",
          responses: {
            ...ok("Grants", {
              type: "object",
              properties: { grants: { type: "array", items: ref("SkillGrant") } },
            }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skills/{skill}/grants/{account}": {
        parameters: [
          SKILL_NAME,
          {
            name: "account",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^gh-[0-9]{1,20}$" },
            description: "Account id of the grantee (`gh-<digits>`, the `id` of GET /me)",
          },
        ],
        put: {
          summary: "Share a team skill with an account",
          description:
            "The grantee then lists it with POST /skill-shares; nothing appears in their catalog before that. Idempotent.",
          operationId: "grantSkill",
          responses: {
            ...ok("Granted", {
              type: "object",
              properties: { grant: ref("SkillGrant"), uri: { type: "string" } },
            }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
        delete: {
          summary: "Revoke a grant",
          operationId: "revokeSkill",
          responses: {
            ...ok("Revoked", { type: "object", properties: { revoked: { type: "boolean" } } }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skill-shares": {
        get: {
          summary: "Team skills shared with you that you listed",
          operationId: "listSkillShares",
          responses: {
            ...ok("Shared skills", {
              type: "object",
              properties: { shared: { type: "array", items: ref("SharedSkill") } },
            }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
        post: {
          summary: "List a team skill shared with you",
          description:
            "The owner must have granted it to you. Revoking (even with a later re-grant) drops it until you add it again.",
          operationId: "addSkillShare",
          requestBody: jsonBody(
            { type: "object", required: ["uri"], properties: { uri: { type: "string" } } },
            { uri: "skill://team/gh-123/brand-voice/SKILL.md" },
          ),
          responses: {
            ...ok(
              "Added",
              {
                type: "object",
                properties: { uri: { type: "string" }, added: { type: "boolean" } },
              },
              "201",
            ),
            ...ERRORS,
            ...BODY_ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/skill-shares/{owner}/{skill}": {
        parameters: [
          {
            name: "owner",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Owner account id (`gh-<digits>`)",
          },
          SKILL_NAME,
        ],
        delete: {
          summary: "Stop listing a shared skill",
          operationId: "removeSkillShare",
          responses: {
            ...ok("Removed", { type: "object", properties: { removed: { type: "boolean" } } }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/workflows": {
        get: {
          summary: "Describe a skill's workflow",
          description:
            "The workflow (`multix.workflow.json`) the skill serves to you: inputs, steps, revision and digest, and whether your account authorized exactly that revision and digest. Review the steps before authorizing them. 404 when the skill serves no workflow.",
          operationId: "describeWorkflow",
          parameters: [
            {
              name: "uri",
              in: "query",
              required: true,
              schema: { type: "string", maxLength: 512 },
              description:
                "skill://private/<name>/SKILL.md or skill://team/<owner>/<name>/SKILL.md",
            },
          ],
          responses: {
            ...ok("Workflow", ref("Workflow")),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/workflow-authorizations": {
        get: {
          summary: "Workflows you authorized",
          operationId: "listWorkflowAuthorizations",
          responses: {
            ...ok("Authorizations", {
              type: "object",
              properties: {
                authorizations: { type: "array", items: ref("WorkflowAuthorization") },
              },
            }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
        post: {
          summary: "Authorize a workflow",
          description: `Lets your account run the workflow the skill serves now. revision and digest must be the ones GET /workflows returns (409 otherwise); a new revision, another digest or a recreated skill voids the authorization. Only this endpoint can authorize: MCP clients cannot. Optional max_cost_usd (0 to ${MAX_WORKFLOW_COST_USD}) caps a whole run: each step then needs a known price that fits what is left. Replaces your earlier authorization of the same skill (at most ${MAX_AUTHORIZATIONS}).`,
          operationId: "authorizeWorkflow",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["uri", "revision", "digest"],
              properties: {
                uri: { type: "string" },
                revision: { type: "integer", minimum: 1 },
                digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
                max_cost_usd: { type: "number", minimum: 0, maximum: MAX_WORKFLOW_COST_USD },
                cost_policy: { type: "string", enum: ["strict", "estimate"] },
              },
            },
            {
              uri: "skill://private/storyboard/SKILL.md",
              revision: 3,
              digest: `sha256:${"0".repeat(64)}`,
              max_cost_usd: 2,
            },
          ),
          responses: {
            ...ok(
              "Authorized",
              { type: "object", properties: { authorization: ref("WorkflowAuthorization") } },
              "201",
            ),
            ...ERRORS,
            ...BODY_ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/workflow-authorizations/{owner}/{skill}": {
        parameters: [
          {
            name: "owner",
            in: "path",
            required: true,
            schema: { type: "string" },
            description: "Owner account id (`gh-<digits>`); your own id for a private skill",
          },
          SKILL_NAME,
        ],
        delete: {
          summary: "Withdraw an authorization",
          description: "Runs under it stop before their next step.",
          operationId: "revokeWorkflowAuthorization",
          responses: {
            ...ok("Revoked", { type: "object", properties: { revoked: { type: "boolean" } } }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/workflow-runs": {
        get: {
          summary: "Your workflow runs and authorizations",
          operationId: "listWorkflowRuns",
          responses: {
            ...ok("Runs", {
              type: "object",
              properties: {
                runs: { type: "array", items: ref("WorkflowRunSummary") },
                authorizations: { type: "array", items: ref("WorkflowAuthorization") },
              },
            }),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
        post: {
          summary: "Run an authorized workflow",
          description: `Starts the run and its first step. 403 when your account has not authorized the served revision and digest. Each step is one job with the same command policy, caps, URL guard and cost checks as POST /jobs. A run advances when it is read: poll GET /workflow-runs/{id}. 429 \`busy\` with ${MAX_ACTIVE_RUNS} runs active.`,
          operationId: "startWorkflowRun",
          requestBody: jsonBody(
            {
              type: "object",
              required: ["uri"],
              properties: { uri: { type: "string" }, inputs: { type: "object" } },
            },
            { uri: "skill://private/storyboard/SKILL.md", inputs: { subject: "a red fox" } },
          ),
          responses: {
            ...ok("Run", ref("WorkflowRun"), "201"),
            ...ERRORS,
            ...BODY_ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/workflow-runs/{id}": {
        parameters: [WORKFLOW_RUN_ID],
        get: {
          summary: "Read a run",
          description:
            "Advances the run first: collects a finished step's outputs and starts the next step.",
          operationId: "getWorkflowRun",
          responses: {
            ...ok("Run", ref("WorkflowRun")),
            ...ERRORS,
            ...SKILL_ERRORS,
          },
        },
      },
      "/workflow-runs/{id}/cancel": {
        parameters: [WORKFLOW_RUN_ID],
        post: {
          summary: "Cancel a run",
          description: "Stops the run and the job of its current step.",
          operationId: "cancelWorkflowRun",
          responses: {
            ...ok("Run", ref("WorkflowRun")),
            ...ERRORS,
            ...SKILL_ERRORS,
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
          description:
            "Body larger than 64 KiB (PUT /skills/{skill}/draft: about 11 MiB, 8 MiB of decoded files)",
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
        Conflict: {
          description:
            "The draft digest or served revision changed since you read it (code conflict); read it again and retry",
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
            max_cost_usd: {
              type: "number",
              minimum: 0,
              description:
                "Refuse to start unless the cost is at most this many USD. Required for a command the server caps cannot bound (uncapped_spend in the catalog) when the server runs them only within a budget.",
            },
            cost_policy: {
              type: "string",
              enum: ["strict", "estimate"],
              description:
                "With max_cost_usd: strict (proven ceiling only, default) or estimate (accept the estimated high end)",
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
        Skill: {
          type: "object",
          properties: {
            name: { type: "string" },
            id: { type: "string" },
            uri: { type: "string", description: "skill:// URI of its SKILL.md" },
            visibility: { type: "string", enum: ["private", "team"] },
            tags: { type: "array", items: { type: "string" } },
            capabilities: { type: "array", items: { type: "string" } },
            current_revision: { type: ["integer", "null"] },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        SkillFile: {
          type: "object",
          properties: {
            path: { type: "string" },
            media_type: { type: "string" },
            size: { type: "integer" },
            digest: { type: "string" },
          },
        },
        SkillFileContent: {
          allOf: [
            ref("SkillFile"),
            {
              type: "object",
              properties: { text: { type: "string" }, base64: { type: "string" } },
            },
          ],
        },
        SkillRevisionSummary: {
          type: "object",
          properties: {
            revision: { type: "integer" },
            version: { type: ["string", "null"] },
            manifest_digest: { type: "string" },
            description: { type: "string" },
            files: { type: "integer" },
            bytes: { type: "integer" },
            published_at: { type: "string", format: "date-time" },
          },
        },
        SkillRevision: {
          allOf: [
            ref("SkillRevisionSummary"),
            {
              type: "object",
              properties: {
                frontmatter: { type: "object" },
                files: { type: "array", items: ref("SkillFile") },
              },
            },
          ],
        },
        SkillDraft: {
          type: "object",
          properties: {
            name: { type: "string" },
            base_revision: { type: ["integer", "null"] },
            digest: { type: "string", description: "Pass as expected_digest" },
            files: { type: "array", items: ref("SkillFile") },
            bytes: { type: "integer" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
        SkillDraftInput: {
          type: "object",
          properties: {
            files: {
              type: "array",
              items: {
                type: "object",
                required: ["path"],
                properties: {
                  path: { type: "string", maxLength: 256 },
                  text: { type: "string" },
                  base64: { type: "string" },
                },
              },
            },
            delete: { type: "array", items: { type: "string" } },
            replace: { type: "boolean" },
            from_revision: { type: "integer", minimum: 1 },
            expected_digest: { type: ["string", "null"] },
          },
        },
        SkillGrant: {
          type: "object",
          properties: {
            principal: { type: "string" },
            grant_id: { type: "string" },
            granted_at: { type: "string", format: "date-time" },
          },
        },
        SharedSkill: {
          type: "object",
          properties: {
            uri: { type: "string" },
            owner: { type: "string" },
            name: { type: "string" },
            available: { type: "boolean" },
            added_at: { type: "string", format: "date-time" },
          },
        },
        SkillList: {
          type: "object",
          properties: {
            skills: { type: "array", items: ref("Skill") },
            drafts: { type: "array", items: { type: "string" } },
            shared: { type: "array", items: ref("SharedSkill") },
          },
        },
        SkillDetail: {
          type: "object",
          properties: {
            skill: { oneOf: [ref("Skill"), { type: "null" }] },
            current: { oneOf: [ref("SkillRevision"), { type: "null" }] },
            draft: { oneOf: [ref("SkillDraft"), { type: "null" }] },
            grants: { type: "array", items: ref("SkillGrant") },
          },
        },
        ServedSkill: {
          type: "object",
          properties: { skill: ref("Skill"), revision: ref("SkillRevisionSummary") },
        },
        Workflow: {
          type: "object",
          properties: {
            uri: { type: "string" },
            owner: { type: "string" },
            skill: { type: "string" },
            revision: { type: "integer" },
            digest: { type: "string" },
            description: { type: ["string", "null"] },
            inputs: { type: "object", description: "Declared inputs by name" },
            steps: { type: "array", items: { type: "object" } },
            authorized: { type: "boolean" },
            authorization: { oneOf: [ref("WorkflowAuthorization"), { type: "null" }] },
            authorize: {
              type: "object",
              description: "Present when not authorized: the request that would authorize it",
            },
          },
        },
        WorkflowAuthorization: {
          type: "object",
          properties: {
            authorization_id: { type: "string" },
            uri: { type: "string" },
            owner: { type: "string" },
            skill: { type: "string" },
            revision: { type: "integer" },
            digest: { type: "string" },
            max_cost_usd: { type: ["number", "null"] },
            cost_policy: { type: "string" },
            granted_at: { type: "string", format: "date-time" },
          },
        },
        WorkflowRunSummary: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            status: { type: "string", enum: ["running", "succeeded", "failed", "canceled"] },
            uri: { type: "string" },
            current_step: { type: ["string", "null"] },
            created_at: { type: "string", format: "date-time" },
          },
        },
        WorkflowRun: {
          type: "object",
          properties: {
            run_id: { type: "string" },
            status: { type: "string", enum: ["running", "succeeded", "failed", "canceled"] },
            uri: { type: "string" },
            revision: { type: "integer" },
            digest: { type: "string" },
            inputs: { type: "object" },
            current_step: { type: ["string", "null"] },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  command: { type: "string" },
                  status: { type: "string" },
                  job_id: { type: ["string", "null"] },
                  outputs: { type: "array", items: { type: "object" } },
                  estimate_usd: { type: ["number", "null"] },
                  error: { type: "string" },
                  note: { type: "string" },
                },
              },
            },
            max_cost_usd: { type: ["number", "null"] },
            spent_usd: {
              type: "number",
              description: "Sum of the started steps' price ceilings (only under max_cost_usd)",
            },
            error: { type: "string" },
            created_at: { type: "string", format: "date-time" },
            updated_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
  };
}
