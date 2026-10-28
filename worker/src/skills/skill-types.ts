/**
 * The Skills registry model (MCP Skills Extension, io.modelcontextprotocol/skills).
 *
 *   Skill          stable identity: id, name, owner, visibility, tags, capabilities, source
 *   SkillRevision  immutable published content: version, manifest digest, status, files
 *   SkillFile      one file of a revision: safe relative path, media type, size, sha256
 *   SkillAccess    who besides the owner may read a team skill, and with which permission
 *
 * Metadata only: nothing here describes how to execute a skill. Reading a
 * skill returns bytes and never runs a script (a later execution manifest is
 * a separate, explicitly authorized surface).
 */

import type { Frontmatter } from "./skill-frontmatter.js";

/** Who can read a skill: every caller, only its owner, or its owner and granted accounts. */
export type SkillVisibility = "builtin" | "private" | "team";
export type SkillSource = "builtin" | "user";
/** Only `published` revisions are served; drafts belong to the authoring flow. */
export type RevisionStatus = "draft" | "published";

export interface Skill {
  /** Stable id: `builtin:<skill-path>` or a random id for user skills. */
  id: string;
  name: string;
  /** Account id of the owner; null for built-ins. */
  ownerId: string | null;
  visibility: SkillVisibility;
  tags: string[];
  /** multix task ids the skill serves (src/capabilities TASKS). */
  capabilities: string[];
  source: SkillSource;
  createdAt: number;
  updatedAt: number;
  /** Revision number currently served, or null when nothing is published. */
  currentRevision: number | null;
}

export interface SkillFile {
  /** Path relative to the skill root, `/`-separated (see isSafeRelativePath). */
  path: string;
  mediaType: string;
  size: number;
  /** `sha256:<64 lowercase hex>` of the raw bytes. */
  digest: string;
}

export interface SkillRevision {
  skillId: string;
  /** 1, 2, 3, … per skill; never reused. */
  revision: number;
  /** Author-facing version from the frontmatter (`version` or `metadata.version`), if any. */
  version: string | null;
  /** sha256 over the sorted `path digest` lines: names the whole file set. */
  manifestDigest: string;
  status: RevisionStatus;
  createdAt: number;
  publishedAt: number | null;
  frontmatter: Frontmatter;
  files: SkillFile[];
}

export interface SkillAccess {
  skillId: string;
  /** Account id granted access. */
  principal: string;
  permissions: "read"[];
  grantedAt: number;
}

/** Per-skill limits of the Skills extension (every conforming host accepts these). */
export const MAX_FILES_PER_SKILL = 512;
export const MAX_BYTES_PER_SKILL = 16 * 1024 * 1024;
/** Per-file cap of this server: one Durable Object storage value, and one read result. */
export const MAX_BYTES_PER_FILE = 1024 * 1024;
export const MAX_TAGS = 16;
export const MAX_TAG_CHARS = 32;
