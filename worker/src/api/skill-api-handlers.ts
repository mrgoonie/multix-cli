/**
 * REST handlers for skills authoring (/api/v1/skills…, /api/v1/skill-shares).
 * They reuse SkillManager, the same code path as multix_skills_manage, so
 * ownership, validation, conflicts and limits are identical on both
 * surfaces. Every write goes to the calling account's own registry.
 */

import type { AppContext, AppDeps } from "../app-context.js";
import { json } from "../http-responses.js";
import { isValidSkillName } from "../skills/skill-frontmatter.js";
import { MAX_PATCH_BYTES, type PublishOptions, SkillManager } from "../skills/skill-manager.js";
import type { SkillSettings } from "../skills/skill-registry.js";
import { ApiError, readJsonObject } from "./api-http.js";

/** A draft update carries up to MAX_PATCH_BYTES of files, base64 adds a third, plus JSON. */
export const MAX_SKILL_BODY_BYTES = Math.ceil((MAX_PATCH_BYTES * 4) / 3) + 512 * 1024;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const REVISION_RE = /^[1-9]\d{0,8}$/;

function methodNotAllowed(allow: string): never {
  throw new ApiError(405, "method_not_allowed", "Method not allowed", { allow });
}

function bad(message: string): never {
  throw new ApiError(400, "bad_request", message);
}

export function skillManager(app: AppContext, deps: AppDeps, userId: string): SkillManager {
  const registries = deps.skills ?? app.env.MULTIX_SKILLS;
  if (!registries)
    throw new ApiError(503, "unavailable", "Skills are not available on this server");
  return new SkillManager({ userId, registries });
}

/** A JSON object body, or `{}` when the request has none. */
async function optionalBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-length") === "0") return {};
  if (!request.headers.get("content-type") && request.body === null) return {};
  return readJsonObject(request);
}

function optional<T>(
  body: Record<string, unknown>,
  key: string,
  check: (v: unknown) => v is T,
  what: string,
): T | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (!check(value)) bad(`${key} must be ${what}`);
  return value;
}

const isRevision = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isRevisionOrNull = (v: unknown): v is number | null => v === null || isRevision(v);
const isDigest = (v: unknown): v is string => typeof v === "string" && DIGEST_RE.test(v);
const isDigestOrNull = (v: unknown): v is string | null => v === null || isDigest(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isVisibility = (v: unknown): v is "private" | "team" => v === "private" || v === "team";
const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");
const isFiles = (v: unknown): v is { path: string; text?: string; base64?: string }[] =>
  Array.isArray(v) &&
  v.every(
    (f) =>
      f !== null &&
      typeof f === "object" &&
      typeof (f as Record<string, unknown>).path === "string" &&
      ["text", "base64"].every((k) => {
        const value = (f as Record<string, unknown>)[k];
        return value === undefined || typeof value === "string";
      }),
  );

function settingsFrom(body: Record<string, unknown>): SkillSettings {
  return {
    visibility: optional(body, "visibility", isVisibility, '"private" or "team"'),
    tags: optional(body, "tags", isStrings, "an array of strings"),
    capabilities: optional(body, "capabilities", isStrings, "an array of strings"),
  };
}

const expectedRevision = (body: Record<string, unknown>) =>
  optional(body, "expected_revision", isRevisionOrNull, "a revision number or null");

function revisionParam(value: string): number {
  if (!REVISION_RE.test(value)) throw new ApiError(404, "not_found", "Not found");
  return Number(value);
}

/** Route `/skills[/<name>[/<sub>[/<id>]]]` for the calling account. */
export async function routeSkills(
  manager: SkillManager,
  request: Request,
  parts: string[],
  url: URL,
): Promise<Response> {
  const method = request.method;
  const [name, sub, id, extra] = parts;
  if (!name) {
    if (method !== "GET") methodNotAllowed("GET");
    return json(200, await manager.list());
  }
  if (!isValidSkillName(name) || extra !== undefined) {
    throw new ApiError(404, "not_found", "Not found");
  }

  if (!sub) {
    if (method === "GET") return json(200, await manager.get(name));
    if (method === "PATCH") {
      const body = await readJsonObject(request);
      return json(200, await manager.update(name, settingsFrom(body), expectedRevision(body)));
    }
    if (method === "DELETE") return json(200, await manager.delete(name));
    methodNotAllowed("GET, PATCH, DELETE");
  }

  if (sub === "draft" && !id) {
    if (method === "GET") return json(200, await manager.draft(name));
    if (method === "PUT") {
      const body = await readJsonObject(request, MAX_SKILL_BODY_BYTES);
      const result = await manager.saveDraft(name, {
        files: optional(body, "files", isFiles, "an array of {path, text | base64}"),
        delete: optional(body, "delete", isStrings, "an array of paths"),
        replace: optional(body, "replace", isBool, "true or false"),
        from_revision: optional(body, "from_revision", isRevision, "a revision number"),
        expected_digest: optional(
          body,
          "expected_digest",
          isDigestOrNull,
          "a sha256 digest or null",
        ),
      });
      return json(200, result);
    }
    if (method === "DELETE") {
      const digest = url.searchParams.get("expected_digest") ?? undefined;
      if (digest !== undefined && !isDigest(digest)) bad("expected_digest must be a sha256 digest");
      return json(200, await manager.discardDraft(name, digest));
    }
    methodNotAllowed("GET, PUT, DELETE");
  }

  if (sub === "files" && !id) {
    if (method !== "GET") methodNotAllowed("GET");
    const path = url.searchParams.get("path");
    if (!path || path.length > 256) bad("path is required");
    const revision = url.searchParams.get("revision");
    if (revision !== null && !REVISION_RE.test(revision)) bad("revision must be a revision number");
    return json(
      200,
      await manager.readFile(name, revision === null ? "draft" : Number(revision), path),
    );
  }

  if (sub === "publish" && !id) {
    if (method !== "POST") methodNotAllowed("POST");
    const body = await optionalBody(request);
    const options: PublishOptions = {
      expected_digest: optional(body, "expected_digest", isDigest, "a sha256 digest"),
      expected_revision: expectedRevision(body),
      ...settingsFrom(body),
    };
    return json(201, await manager.publishDraft(name, options));
  }

  if (sub === "revisions") {
    if (!id) {
      if (method !== "GET") methodNotAllowed("GET");
      return json(200, await manager.revisions(name));
    }
    const revision = revisionParam(id);
    if (method === "GET") return json(200, await manager.revision(name, revision));
    if (method === "DELETE") return json(200, await manager.deleteRevision(name, revision));
    methodNotAllowed("GET, DELETE");
  }

  if (sub === "current" && !id) {
    if (method !== "POST") methodNotAllowed("POST");
    const body = await readJsonObject(request);
    const revision = optional(body, "revision", isRevision, "a revision number");
    if (revision === undefined) bad("revision is required");
    return json(200, await manager.setCurrent(name, revision, expectedRevision(body)));
  }

  if (sub === "unpublish" && !id) {
    if (method !== "POST") methodNotAllowed("POST");
    const body = await optionalBody(request);
    return json(200, await manager.unpublish(name, expectedRevision(body)));
  }

  if (sub === "grants") {
    if (!id) {
      if (method !== "GET") methodNotAllowed("GET");
      return json(200, await manager.grants(name));
    }
    if (method === "PUT") return json(200, await manager.grant(name, id));
    if (method === "DELETE") return json(200, await manager.revoke(name, id));
    methodNotAllowed("PUT, DELETE");
  }

  throw new ApiError(404, "not_found", "Not found");
}

/** `/skill-shares`: list another account's team skill shared with the caller, or drop it. */
export async function routeSkillShares(
  manager: SkillManager,
  request: Request,
  parts: string[],
): Promise<Response> {
  const method = request.method;
  const [ownerId, name, extra] = parts;
  if (!ownerId) {
    if (method === "GET") return json(200, { shared: (await manager.list()).shared });
    if (method === "POST") {
      const body = await readJsonObject(request);
      if (typeof body.uri !== "string") bad("uri must be a skill://team/<owner>/<name> URI");
      return json(201, await manager.addShared(body.uri));
    }
    methodNotAllowed("GET, POST");
  }
  if (name && extra === undefined) {
    if (method !== "DELETE") methodNotAllowed("DELETE");
    return json(200, await manager.removeShared(`skill://team/${ownerId}/${name}/SKILL.md`));
  }
  throw new ApiError(404, "not_found", "Not found");
}
