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
  /** Highest revision number ever stored, so a deleted revision's number is never reused. */
  lastRevision?: number;
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
  /**
   * Random id of this grant. A grantee's share remembers it, so a share
   * accepted under a revoked grant stays dead after a later re-grant.
   */
  grantId: string;
}

/** An unpublished working copy of a skill's files, owned by the skill's account. */
export interface SkillDraft {
  name: string;
  /** Revision the draft started from, or null for a new skill or an empty start. */
  baseRevision: number | null;
  /**
   * Revision served when the draft started. Publishing without an explicit
   * expected revision fails if another revision is served by then.
   */
  servedRevision?: number | null;
  /** manifestDigest of the draft's files; callers pass it back to detect concurrent edits. */
  digest: string;
  files: SkillFile[];
  createdAt: number;
  updatedAt: number;
}

/** A team skill of another account that this account chose to list. */
export interface SkillShare {
  ownerId: string;
  name: string;
  grantId: string;
  addedAt: number;
}

/** Per-skill limits of the Skills extension (every conforming host accepts these). */
export const MAX_FILES_PER_SKILL = 512;
export const MAX_BYTES_PER_SKILL = 16 * 1024 * 1024;
/** Per-file cap of this server: one Durable Object storage value, and one read result. */
export const MAX_BYTES_PER_FILE = 1024 * 1024;
export const MAX_TAGS = 16;
export const MAX_TAG_CHARS = 32;
/** Revisions one skill may keep; delete old ones to publish more. */
export const MAX_REVISIONS_PER_SKILL = 100;
/** Accounts one team skill may be granted to. */
export const MAX_GRANTS_PER_SKILL = 100;
/** Account ids as the Worker issues them (GitHub sign-in). */
export const ACCOUNT_ID_RE = /^gh-\d{1,20}$/;
