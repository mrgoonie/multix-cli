/**
 * multix_skills: the skills catalog as one read-only tool, for clients that
 * do not speak the Skills extension (and older protocol versions). It serves
 * the same skills, URIs and digests as skills/list, skills/get and
 * resources/read, and never runs or activates a skill.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TASKS } from "../../../src/capabilities/capability-types.js";
import { MultixError } from "../../../src/core/errors.js";
import type { RunToolFn } from "../jobs/job-tools.js";
import { toolInput } from "../jobs/tool-input-schema.js";
import {
  type CatalogSkill,
  SkillCatalog,
  SkillCatalogError,
  type SkillsContext,
  skillEntry,
} from "./skill-catalog.js";
import { isTextMediaType } from "./skill-files.js";

const MAX_QUERY_CHARS = 200;
const MAX_SEARCH_RESULTS = 50;
/** Largest file the tool returns inline; resources/read serves bigger ones. */
export const MAX_TOOL_TEXT_BYTES = 256 * 1024;

/** Catalog refusals as expected tool errors, their code leading the message. */
function refusal(error: unknown): never {
  if (error instanceof SkillCatalogError && error.code !== "CORRUPT") {
    throw new MultixError(`${error.code}: ${error.message}`, error.code);
  }
  throw error;
}

function summary(skill: CatalogSkill) {
  return {
    uri: skill.uri,
    name: skill.frontmatter.name,
    description: skill.frontmatter.description,
    version: skill.version,
    revision: skill.revision,
    visibility: skill.visibility,
    capabilities: skill.capabilities,
  };
}

function matches(skill: CatalogSkill, query: string | undefined, task: string | undefined) {
  if (task && !skill.capabilities.includes(task) && !skill.capabilities.includes("any")) {
    return false;
  }
  if (!query) return true;
  const haystack = [skill.frontmatter.name, skill.frontmatter.description, ...skill.tags]
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** The skill a file URI belongs to: the innermost root enclosing it. */
function owningSkill(skills: CatalogSkill[], uri: string): CatalogSkill | undefined {
  return skills
    .filter((s) => uri.startsWith(`${s.root}/`))
    .sort((a, b) => b.root.length - a.root.length)[0];
}

export function registerSkillsTool(server: McpServer, ctx: SkillsContext, runTool: RunToolFn) {
  const catalog = new SkillCatalog(ctx);

  server.registerTool(
    "multix_skills",
    {
      title: "multix skills catalog",
      description:
        "Read the agent skills this server publishes (how to use multix for a task), read-only. action=search: skills matching query and/or task, newest revision each. action=get: one skill's frontmatter and files (uri of its SKILL.md). action=read: one file's text by uri; pass digest (or, for account skills, revision) from an earlier get to fail with STALE_REVISION if the file changed since; built-in skills stay at revision 1 across deploys, so only digest detects their changes. Never runs a skill.",
      inputSchema: toolInput({
        action: z.enum(["search", "get", "read"]),
        query: z.string().max(MAX_QUERY_CHARS).optional().describe("Words to match (search)"),
        task: z.enum(TASKS).optional().describe("Task filter (search), e.g. image, speech"),
        uri: z
          .string()
          .max(512)
          .optional()
          .describe("skill:// URI: a SKILL.md (get) or any file of a skill (read)"),
        revision: z.number().int().positive().optional().describe("Expected skill revision (read)"),
        digest: z
          .string()
          .regex(/^sha256:[0-9a-f]{64}$/)
          .optional()
          .describe("Expected file digest (read)"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      runTool("multix_skills", { action: args.action, task: args.task }, async () => {
        try {
          if (args.action === "search") {
            const found = (await catalog.list()).filter((s) => matches(s, args.query, args.task));
            return {
              skills: found.slice(0, MAX_SEARCH_RESULTS).map(summary),
              total: found.length,
            };
          }
          if (!args.uri) {
            throw new MultixError(`uri is required for action=${args.action}`, "INVALID_INPUT");
          }
          if (args.action === "get") return { skill: skillEntry(await catalog.get(args.uri)) };

          const file = await catalog.read(args.uri);
          const skill = owningSkill(await catalog.list(), args.uri);
          if (
            (args.revision !== undefined && skill?.revision !== args.revision) ||
            (args.digest !== undefined && file.digest !== args.digest)
          ) {
            throw new SkillCatalogError(
              "STALE_REVISION",
              `${args.uri} changed: now revision ${skill?.revision ?? "unknown"}, digest ${file.digest}`,
            );
          }
          if (!isTextMediaType(file.mimeType)) {
            throw new SkillCatalogError(
              "BINARY_FILE",
              `${args.uri} is ${file.mimeType}; read it with resources/read`,
            );
          }
          if (file.size > MAX_TOOL_TEXT_BYTES) {
            throw new SkillCatalogError(
              "PAYLOAD_TOO_LARGE",
              `${args.uri} is ${file.size} bytes, over the ${MAX_TOOL_TEXT_BYTES}-byte tool limit; read it with resources/read`,
            );
          }
          return {
            uri: file.uri,
            mimeType: file.mimeType,
            size: file.size,
            digest: file.digest,
            revision: skill?.revision ?? null,
            text: new TextDecoder().decode(file.bytes),
          };
        } catch (error) {
          refusal(error);
        }
      }),
  );
}
