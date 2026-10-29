/**
 * MCP Skills Extension (`io.modelcontextprotocol/skills`, protocol
 * 2026-07-28): `skills/list`, `skills/get` and `resources/directory/read`,
 * plus the `resources/list` and `resources/read` methods every client can use
 * to read the same files. Read-only: no method writes, fetches or runs
 * anything, and reading a skill never activates it.
 *
 * The extension methods are registered on modern (2026-07-28) servers only,
 * where the server also declares the extension in server/discover. Older
 * clients keep the resources methods and the multix_skills tool.
 */

import { type McpServer, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";
import { logEvent, sanitizeText } from "../redaction.js";
import {
  type ResourceView,
  SkillCatalog,
  SkillCatalogError,
  type SkillsContext,
  paginate,
  resourceContents,
  skillEntry,
  skillResource,
} from "./skill-catalog.js";

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";
/** Built-ins are the same for everyone and change only on deploy. */
export const PUBLIC_TTL_MS = 300_000;
/** Answers that include an account's own or shared skills. */
export const PRIVATE_TTL_MS = 60_000;

const MAX_URI_CHARS = 512;
const cursorParam = z.string().max(256).optional();
const listParams = z.object({ cursor: cursorParam }).loose();
const uriParams = z.object({ uri: z.string().max(MAX_URI_CHARS) }).loose();
const directoryParams = z
  .object({ uri: z.string().max(MAX_URI_CHARS), cursor: cursorParam })
  .loose();

/** The extension's capability entry (server/discover `capabilities.extensions`). */
export function skillsCapabilities() {
  return { extensions: { [SKILLS_EXTENSION]: { directoryRead: true } }, resources: {} };
}

function protocolError(error: SkillCatalogError): ProtocolError {
  if (error.code === "CORRUPT") {
    return new ProtocolError(ProtocolErrorCode.InternalError, error.message);
  }
  return new ProtocolError(ProtocolErrorCode.InvalidParams, error.message, { code: error.code });
}

function guarded<P, R>(method: string, handler: (params: P) => Promise<R>) {
  return async (params: P): Promise<R> => {
    try {
      return await handler(params);
    } catch (error) {
      if (error instanceof ProtocolError) throw error;
      if (error instanceof SkillCatalogError) {
        logEvent(error.code === "CORRUPT" ? "error" : "warn", "skill_method", {
          method,
          ok: false,
          code: error.code,
        });
        throw protocolError(error);
      }
      logEvent("error", "skill_method_failed", {
        method,
        error: error instanceof Error ? error.name : typeof error,
        detail: sanitizeText(error instanceof Error ? error.message : String(error), []),
      });
      throw new ProtocolError(ProtocolErrorCode.InternalError, "Internal error");
    }
  };
}

function cache(catalog: SkillCatalog) {
  return catalog.personal
    ? { ttlMs: PRIVATE_TTL_MS, cacheScope: "private" as const }
    : { ttlMs: PUBLIC_TTL_MS, cacheScope: "public" as const };
}

function resource(view: ResourceView) {
  return {
    uri: view.uri,
    name: view.name,
    mimeType: view.mimeType,
    ...(view.description !== undefined ? { description: view.description } : {}),
    ...(view.size !== undefined ? { size: view.size } : {}),
  };
}

/** resources/list and resources/read: every protocol era. */
export function registerSkillResources(server: McpServer, ctx: SkillsContext): void {
  const catalog = new SkillCatalog(ctx);

  server.server.setRequestHandler(
    "resources/list",
    guarded("resources/list", async (request: { params?: { cursor?: string } }) => {
      const cursor = cursorParam.safeParse(request.params?.cursor);
      if (!cursor.success) throw new SkillCatalogError("INVALID_CURSOR", "Invalid cursor");
      const { page, nextCursor } = paginate(await catalog.list(), cursor.data);
      return {
        resources: page.map((skill) => resource(skillResource(skill))),
        ...(nextCursor ? { nextCursor } : {}),
        ...cache(catalog),
      };
    }),
  );

  server.server.setRequestHandler(
    "resources/read",
    guarded("resources/read", async (request: { params: { uri: string } }) => {
      const params = uriParams.safeParse(request.params);
      if (!params.success) throw new SkillCatalogError("INVALID_URI", "Invalid skill URI");
      const file = await catalog.read(params.data.uri);
      logEvent("info", "skill_method", { method: "resources/read", ok: true, size: file.size });
      return { contents: [resourceContents(file)], ...cache(catalog) };
    }),
  );
}

/** skills/list, skills/get and resources/directory/read: modern servers only. */
export function registerSkillMethods(server: McpServer, ctx: SkillsContext): void {
  const catalog = new SkillCatalog(ctx);

  server.server.setRequestHandler(
    "skills/list",
    { params: listParams },
    guarded("skills/list", async (p: z.infer<typeof listParams>) => {
      const { page, nextCursor } = paginate(await catalog.list(), p.cursor);
      return {
        skills: page.map(skillEntry),
        ...(nextCursor ? { nextCursor } : {}),
        ...cache(catalog),
      };
    }),
  );

  server.server.setRequestHandler(
    "skills/get",
    { params: uriParams },
    guarded("skills/get", async (p: z.infer<typeof uriParams>) => ({
      skill: skillEntry(await catalog.get(p.uri)),
      ...cache(catalog),
    })),
  );

  server.server.setRequestHandler(
    "resources/directory/read",
    { params: directoryParams },
    guarded("resources/directory/read", async (p: z.infer<typeof directoryParams>) => {
      const { page, nextCursor } = paginate(await catalog.readDirectory(p.uri), p.cursor);
      return {
        resources: page.map(resource),
        ...(nextCursor ? { nextCursor } : {}),
        ...cache(catalog),
      };
    }),
  );
}
