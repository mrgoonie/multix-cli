/**
 * multix_skills_manage: author the caller's own skills over MCP: drafts,
 * publishing, revisions, settings, deletion and team sharing (SkillManager).
 * It only ever writes the caller's own registry, and it never runs a skill.
 * Readers keep using skills/list, resources/read and multix_skills.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { TASKS } from "../../../src/capabilities/capability-types.js";
import { MultixError } from "../../../src/core/errors.js";
import type { RunToolFn } from "../jobs/job-tools.js";
import { toolInput } from "../jobs/tool-input-schema.js";
import { MAX_SKILL_NAME_CHARS } from "./skill-frontmatter.js";
import { type AuthoringContext, SkillManager } from "./skill-manager.js";
import { SkillRegistryError } from "./skill-registry.js";
import { MAX_FILES_PER_SKILL, MAX_TAGS } from "./skill-types.js";

const ACTIONS = [
  "list",
  "get",
  "save_draft",
  "get_draft",
  "read_file",
  "discard_draft",
  "publish",
  "revisions",
  "revision",
  "set_current",
  "unpublish",
  "delete_revision",
  "update",
  "delete",
  "grant",
  "revoke",
  "grants",
  "add_shared",
  "remove_shared",
] as const;

/** Actions that address one of the caller's skills by name. */
const NAMED = new Set<string>(
  ACTIONS.filter((a) => !["list", "add_shared", "remove_shared"].includes(a)),
);

const REASON_CODES = {
  invalid: "INVALID_INPUT",
  not_found: "NOT_FOUND",
  conflict: "CONFLICT",
} as const;

/** Registry refusals as expected tool errors, their code leading the message. */
function refusal(error: unknown): never {
  if (error instanceof SkillRegistryError && error.reason !== "corrupt") {
    const code = REASON_CODES[error.reason];
    throw new MultixError(`${code}: ${error.message}`, code);
  }
  throw error;
}

function required<T>(value: T | undefined, field: string, action: string): T {
  if (value === undefined) {
    throw new MultixError(
      `INVALID_INPUT: ${field} is required for action=${action}`,
      "INVALID_INPUT",
    );
  }
  return value;
}

const tag = z.string().max(32);

export function registerSkillsManageTool(
  server: McpServer,
  ctx: AuthoringContext,
  runTool: RunToolFn,
) {
  const manager = new SkillManager(ctx);

  server.registerTool(
    "multix_skills_manage",
    {
      title: "multix skills authoring",
      description:
        "Create and maintain your own agent skills (SKILL.md plus files); nothing here runs a skill. Workflow: save_draft (files as text or base64, delete paths; a new draft starts from the served revision) → get_draft → publish (the draft becomes the next immutable revision, served at its skill:// URI). Pass expected_digest (draft) or expected_revision (served revision) to fail with CONFLICT instead of overwriting someone else's change. revisions/revision list and inspect stored revisions; set_current rolls back or forward; unpublish stops serving; delete_revision removes an old revision; update changes visibility (private or team; a change revokes every grant), tags and capabilities; delete removes the skill with all revisions, its draft and grants. Team sharing: grant/revoke an account id (gh-<digits>), grants lists them; the grantee calls add_shared with the skill:// team URI to list it, remove_shared to drop it. read_file returns a draft file, or a stored revision's with revision.",
      inputSchema: toolInput({
        action: z.enum(ACTIONS),
        name: z
          .string()
          .max(MAX_SKILL_NAME_CHARS)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
          .optional()
          .describe("Skill name (as in its SKILL.md frontmatter)"),
        files: z
          .array(
            z.object({
              path: z
                .string()
                .max(256)
                .describe("Path in the skill, e.g. SKILL.md or refs/tone.md"),
              text: z.string().optional().describe("UTF-8 content"),
              base64: z.string().optional().describe("Content as base64 (images, PDFs)"),
            }),
          )
          .max(MAX_FILES_PER_SKILL)
          .optional()
          .describe("Files to add or replace (save_draft)"),
        delete: z
          .array(z.string().max(256))
          .max(MAX_FILES_PER_SKILL)
          .optional()
          .describe("Paths to remove (save_draft)"),
        replace: z
          .boolean()
          .optional()
          .describe("Start the draft from no files, or from from_revision (save_draft)"),
        from_revision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Revision a new draft starts from"),
        expected_digest: z
          .string()
          .regex(/^sha256:[0-9a-f]{64}$/)
          .optional()
          .describe("Draft digest you last saw (save_draft, discard_draft, publish)"),
        expected_revision: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Served revision you last saw; 0 means none is served"),
        revision: z.number().int().positive().optional().describe("Revision number"),
        path: z.string().max(256).optional().describe("File path (read_file)"),
        visibility: z.enum(["private", "team"]).optional(),
        tags: z.array(tag).max(MAX_TAGS).optional(),
        capabilities: z
          .array(z.enum([...TASKS, "any"]))
          .max(MAX_TAGS)
          .optional(),
        principal: z.string().max(32).optional().describe("Account id gh-<digits> (grant, revoke)"),
        uri: z.string().max(512).optional().describe("Team skill URI (add_shared, remove_shared)"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) =>
      runTool("multix_skills_manage", { action: args.action, skill: args.name }, async () => {
        const a = args.action;
        const name = NAMED.has(a) ? required(args.name, "name", a) : "";
        const expectedRevision =
          args.expected_revision === undefined
            ? undefined
            : args.expected_revision === 0
              ? null
              : args.expected_revision;
        const settings = {
          visibility: args.visibility,
          tags: args.tags,
          capabilities: args.capabilities,
        };
        try {
          switch (a) {
            case "list":
              return await manager.list();
            case "get":
              return await manager.get(name);
            case "save_draft":
              return await manager.saveDraft(name, {
                files: args.files,
                delete: args.delete,
                replace: args.replace,
                from_revision: args.from_revision,
                expected_digest: args.expected_digest,
              });
            case "get_draft":
              return await manager.draft(name);
            case "read_file":
              return await manager.readFile(
                name,
                args.revision ?? "draft",
                required(args.path, "path", a),
              );
            case "discard_draft":
              return await manager.discardDraft(name, args.expected_digest);
            case "publish":
              return await manager.publishDraft(name, {
                expected_digest: args.expected_digest,
                expected_revision: expectedRevision,
                ...settings,
              });
            case "revisions":
              return await manager.revisions(name);
            case "revision":
              return await manager.revision(name, required(args.revision, "revision", a));
            case "set_current":
              return await manager.setCurrent(
                name,
                required(args.revision, "revision", a),
                expectedRevision,
              );
            case "unpublish":
              return await manager.unpublish(name, expectedRevision);
            case "delete_revision":
              return await manager.deleteRevision(name, required(args.revision, "revision", a));
            case "update":
              return await manager.update(name, settings, expectedRevision);
            case "delete":
              return await manager.delete(name);
            case "grant":
              return await manager.grant(name, required(args.principal, "principal", a));
            case "revoke":
              return await manager.revoke(name, required(args.principal, "principal", a));
            case "grants":
              return await manager.grants(name);
            case "add_shared":
              return await manager.addShared(required(args.uri, "uri", a));
            case "remove_shared":
              return await manager.removeShared(required(args.uri, "uri", a));
          }
        } catch (error) {
          refusal(error);
        }
      }),
  );
}
