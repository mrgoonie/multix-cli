/**
 * REST handlers for skill workflows (/api/v1/workflows,
 * /workflow-authorizations, /workflow-runs). They reuse WorkflowManager, the
 * code path of multix_workflow, and add the one thing MCP cannot do:
 * authorizing a workflow for the calling account.
 */

import { toolEnvFor } from "../accounts/account-store.js";
import type { AppContext, AppDeps } from "../app-context.js";
import { limitsFrom, serverSettings } from "../config.js";
import { json } from "../http-responses.js";
import { jobsContextFor } from "../jobs/job-context.js";
import type { ProviderKeys } from "../provider-secret-names.js";
import { isValidSkillName } from "../skills/skill-frontmatter.js";
import { ACCOUNT_ID_RE } from "../skills/skill-types.js";
import { WorkflowManager } from "../skills/workflow-manager.js";
import { ApiError, readJsonObject } from "./api-http.js";

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

function methodNotAllowed(allow: string): never {
  throw new ApiError(405, "method_not_allowed", "Method not allowed", { allow });
}

function bad(message: string): never {
  throw new ApiError(400, "bad_request", message);
}

export function workflowManager(
  app: AppContext,
  deps: AppDeps,
  userId: string,
  keys: ProviderKeys,
): WorkflowManager {
  const registries = deps.skills ?? app.env.MULTIX_SKILLS;
  if (!registries)
    throw new ApiError(503, "unavailable", "Skills are not available on this server");
  return new WorkflowManager({
    userId,
    registries,
    jobs: jobsContextFor(app.env, app, userId, keys, deps),
    limits: limitsFrom(toolEnvFor(serverSettings(app.env), keys)),
  });
}

function uriOf(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) {
    bad("uri must be a skill URI such as skill://private/<name>/SKILL.md");
  }
  return value;
}

/** `GET /workflows?uri=`: the served workflow and whether the caller authorized it. */
export async function routeWorkflows(
  manager: WorkflowManager,
  request: Request,
  parts: string[],
  url: URL,
): Promise<Response> {
  if (parts.length > 0) throw new ApiError(404, "not_found", "Not found");
  if (request.method !== "GET") methodNotAllowed("GET");
  return json(200, await manager.describe(uriOf(url.searchParams.get("uri") ?? undefined)));
}

/** `/workflow-authorizations[/<owner>/<skill>]`: list, grant and withdraw. */
export async function routeWorkflowAuthorizations(
  manager: WorkflowManager,
  request: Request,
  parts: string[],
): Promise<Response> {
  const method = request.method;
  const [ownerId, name, extra] = parts;
  if (!ownerId) {
    if (method === "GET") return json(200, await manager.authorizations());
    if (method !== "POST") methodNotAllowed("GET, POST");
    const body = await readJsonObject(request);
    const { revision, digest, max_cost_usd: maxCost, cost_policy: policy } = body;
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
      bad("revision must be the revision number GET /workflows returns");
    }
    if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
      bad("digest must be the sha256 digest GET /workflows returns");
    }
    if (maxCost !== undefined && typeof maxCost !== "number") bad("max_cost_usd must be a number");
    if (policy !== undefined && typeof policy !== "string") bad("cost_policy must be a string");
    const result = await manager.authorize(uriOf(body.uri), {
      revision,
      digest,
      max_cost_usd: maxCost,
      cost_policy: policy,
    });
    return json(201, result);
  }
  if (name && extra === undefined && ACCOUNT_ID_RE.test(ownerId) && isValidSkillName(name)) {
    if (method !== "DELETE") methodNotAllowed("DELETE");
    return json(200, await manager.revoke(`skill://team/${ownerId}/${name}/SKILL.md`));
  }
  throw new ApiError(404, "not_found", "Not found");
}

/** `/workflow-runs[/<id>[/cancel]]`: list, start, read (advances the run) and cancel. */
export async function routeWorkflowRuns(
  manager: WorkflowManager,
  request: Request,
  parts: string[],
): Promise<Response> {
  const method = request.method;
  const [runId, action, extra] = parts;
  if (!runId) {
    if (method === "GET") return json(200, await manager.list());
    if (method !== "POST") methodNotAllowed("GET, POST");
    const body = await readJsonObject(request);
    const inputs = body.inputs;
    if (inputs !== undefined && (!inputs || typeof inputs !== "object" || Array.isArray(inputs))) {
      bad("inputs must be an object");
    }
    return json(
      201,
      await manager.start(uriOf(body.uri), inputs as Record<string, unknown> | undefined),
    );
  }
  if (!action) {
    if (method !== "GET") methodNotAllowed("GET");
    return json(200, await manager.status(runId));
  }
  if (action === "cancel" && extra === undefined) {
    if (method !== "POST") methodNotAllowed("POST");
    return json(200, await manager.cancel(runId));
  }
  throw new ApiError(404, "not_found", "Not found");
}
