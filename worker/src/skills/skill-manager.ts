/**
 * Skills authoring for the calling account, shared by the MCP tool
 * (multix_skills_manage) and the REST API (/api/v1/skills…): input decoding,
 * the owner's view of skills, drafts and revisions, and team sharing.
 *
 * Every owner operation goes to the caller's own registry
 * (`MULTIX_SKILLS.getByName(userId)`), so an account can only ever change
 * its own skills. The one cross-account call reads a grant on the owner's
 * registry before the caller lists a shared skill.
 */

import { TASKS } from "../../../src/capabilities/capability-types.js";
import { base64ToBytes, bytesToBase64 } from "../accounts/base64.js";
import type { SkillAuthoringStub } from "./account-skills.js";
import { SKILL_SCHEME, parseSkillUri } from "./skill-catalog.js";
import { isTextMediaType } from "./skill-files.js";
import {
  type FileInput,
  type ServedSkill,
  SkillRegistryError,
  type SkillSettings,
} from "./skill-registry.js";
import {
  ACCOUNT_ID_RE,
  MAX_FILES_PER_SKILL,
  type Skill,
  type SkillAccess,
  type SkillDraft,
  type SkillFile,
  type SkillRevision,
} from "./skill-types.js";

const CAPABILITIES: ReadonlySet<string> = new Set([...TASKS, "any"]);

/** Decoded bytes one draft update may carry (larger skills are uploaded in several updates). */
export const MAX_PATCH_BYTES = 8 * 1024 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface AuthoringContext {
  userId: string;
  registries: { getByName(accountId: string): SkillAuthoringStub };
}

/** One file in a draft update: UTF-8 `text`, or `base64` bytes for any file type. */
export interface FilePatch {
  path: string;
  text?: string;
  base64?: string;
}

export interface DraftPatch {
  files?: FilePatch[];
  delete?: string[];
  replace?: boolean;
  from_revision?: number;
  expected_digest?: string | null;
}

export interface PublishOptions {
  expected_digest?: string;
  expected_revision?: number | null;
  visibility?: "private" | "team";
  tags?: string[];
  capabilities?: string[];
}

function invalid(message: string): never {
  throw new SkillRegistryError(message, "invalid");
}

/** Turn file patches into bytes, refusing ambiguous or oversized input. */
export function decodeFiles(files: readonly FilePatch[]): FileInput[] {
  if (files.length > MAX_FILES_PER_SKILL) invalid(`at most ${MAX_FILES_PER_SKILL} files`);
  const encoder = new TextEncoder();
  let total = 0;
  return files.map((file) => {
    if (typeof file.path !== "string") invalid("every file needs a path");
    const hasText = typeof file.text === "string";
    const hasBase64 = typeof file.base64 === "string";
    if (hasText === hasBase64)
      invalid(`${file.path.slice(0, 80)}: send exactly one of text or base64`);
    let bytes: Uint8Array;
    if (hasText) {
      bytes = encoder.encode(file.text as string);
    } else {
      const value = file.base64 as string;
      if (!BASE64_RE.test(value) || value.length % 4 !== 0) {
        invalid(`${file.path.slice(0, 80)}: base64 is not valid`);
      }
      bytes = base64ToBytes(value);
    }
    total += bytes.length;
    if (total > MAX_PATCH_BYTES) {
      invalid(`one update may carry at most ${MAX_PATCH_BYTES} bytes; send the rest in another`);
    }
    return { path: file.path, bytes };
  });
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The URI a skill is served at (its SKILL.md), by visibility. */
export function skillUri(skill: Pick<Skill, "name" | "ownerId" | "visibility">): string {
  return skill.visibility === "team"
    ? `${SKILL_SCHEME}team/${skill.ownerId}/${skill.name}/SKILL.md`
    : `${SKILL_SCHEME}private/${skill.name}/SKILL.md`;
}

export function skillView(skill: Skill) {
  return {
    name: skill.name,
    id: skill.id,
    uri: skillUri(skill),
    visibility: skill.visibility,
    tags: skill.tags,
    capabilities: skill.capabilities,
    current_revision: skill.currentRevision,
    created_at: iso(skill.createdAt),
    updated_at: iso(skill.updatedAt),
  };
}

const fileView = (f: SkillFile) => ({
  path: f.path,
  media_type: f.mediaType,
  size: f.size,
  digest: f.digest,
});

export function revisionSummary(revision: SkillRevision) {
  return {
    revision: revision.revision,
    version: revision.version,
    manifest_digest: revision.manifestDigest,
    description: revision.frontmatter.description,
    files: revision.files.length,
    bytes: revision.files.reduce((n, f) => n + f.size, 0),
    published_at: iso(revision.publishedAt),
  };
}

export function revisionView(revision: SkillRevision) {
  return {
    ...revisionSummary(revision),
    frontmatter: revision.frontmatter,
    files: revision.files.map(fileView),
  };
}

export function draftView(draft: SkillDraft) {
  return {
    name: draft.name,
    base_revision: draft.baseRevision,
    digest: draft.digest,
    files: draft.files.map(fileView),
    bytes: draft.files.reduce((n, f) => n + f.size, 0),
    created_at: iso(draft.createdAt),
    updated_at: iso(draft.updatedAt),
  };
}

function servedView(served: ServedSkill) {
  return { skill: skillView(served.skill), revision: revisionSummary(served.revision) };
}

const grantView = (access: SkillAccess) => ({
  principal: access.principal,
  grant_id: access.grantId,
  granted_at: iso(access.grantedAt),
});

/** `skill://team/<owner>/<name>[/SKILL.md]` → owner and name, or a refusal. */
function teamSkill(uri: string): { ownerId: string; name: string } {
  let segments: string[];
  try {
    segments = parseSkillUri(uri.replace(/\/SKILL\.md$/, ""));
  } catch {
    invalid("expected a team skill URI: skill://team/<owner>/<name>/SKILL.md");
  }
  const [head, ownerId, name, ...rest] = segments;
  if (head !== "team" || !ownerId || !name || rest.length > 0 || !ACCOUNT_ID_RE.test(ownerId)) {
    invalid("expected a team skill URI: skill://team/<owner>/<name>/SKILL.md");
  }
  return { ownerId, name };
}

export class SkillManager {
  constructor(private readonly ctx: AuthoringContext) {}

  private get me(): string {
    return this.ctx.userId;
  }

  private get own(): SkillAuthoringStub {
    return this.ctx.registries.getByName(this.me);
  }

  /** The account's skills (served or not), drafts, and the shared skills it lists. */
  async list() {
    const { skills, drafts } = await this.own.ownSkills(this.me);
    const shares = await this.own.shares();
    const served = await Promise.all(
      shares.map((share) =>
        this.ctx.registries
          .getByName(share.ownerId)
          .served(share.ownerId, this.me, share.name, share.grantId),
      ),
    );
    const shared = shares.map((share, i) => {
      const found = served[i] ?? null;
      return {
        uri: `${SKILL_SCHEME}team/${share.ownerId}/${share.name}/SKILL.md`,
        owner: share.ownerId,
        name: share.name,
        // false once the owner revoked the grant, unpublished or deleted the skill
        available: found !== null && found.skill.visibility === "team",
        added_at: iso(share.addedAt),
      };
    });
    return {
      skills: skills.map(skillView).sort((a, b) => (a.name < b.name ? -1 : 1)),
      drafts: drafts.sort(),
      shared,
    };
  }

  async get(name: string) {
    const skill = await this.own.skill(this.me, name);
    const draft = await this.own.draft(this.me, name);
    if (!skill && !draft) {
      throw new SkillRegistryError(`no skill or draft named "${name}"`, "not_found");
    }
    const current =
      skill?.currentRevision != null
        ? await this.own.revision(this.me, name, skill.currentRevision)
        : null;
    return {
      skill: skill ? skillView(skill) : null,
      current: current ? revisionView(current) : null,
      draft: draft ? draftView(draft) : null,
      grants:
        skill?.visibility === "team" ? (await this.own.grants(this.me, name)).map(grantView) : [],
    };
  }

  async saveDraft(name: string, patch: DraftPatch) {
    const draft = await this.own.saveDraft({
      ownerId: this.me,
      name,
      files: decodeFiles(patch.files ?? []),
      delete: patch.delete,
      replace: patch.replace,
      fromRevision: patch.from_revision,
      expectedDigest: patch.expected_digest,
    });
    return { draft: draftView(draft) };
  }

  async draft(name: string) {
    const draft = await this.own.draft(this.me, name);
    if (!draft) throw new SkillRegistryError(`skill "${name}" has no draft`, "not_found");
    return { draft: draftView(draft) };
  }

  async discardDraft(name: string, expectedDigest?: string) {
    return { discarded: await this.own.discardDraft(this.me, name, expectedDigest) };
  }

  /** One file of the draft or of a stored revision: text, or base64 for other types. */
  async readFile(name: string, from: "draft" | number, path: string) {
    const found = await this.own.ownFile(this.me, name, from, path);
    if (!found) {
      throw new SkillRegistryError(
        `${from === "draft" ? "the draft" : `revision ${from}`} of "${name}" has no file "${path.slice(0, 80)}"`,
        "not_found",
      );
    }
    const { file, bytes } = found;
    return {
      ...fileView(file),
      ...(isTextMediaType(file.mediaType)
        ? { text: new TextDecoder().decode(bytes) }
        : { base64: bytesToBase64(bytes) }),
    };
  }

  async publishDraft(name: string, options: PublishOptions) {
    const served = await this.own.publishDraft({
      ownerId: this.me,
      name,
      expectedDigest: options.expected_digest,
      expectedRevision: options.expected_revision,
      ...this.settings(options),
    });
    return servedView(served);
  }

  private settings(options: SkillSettings): SkillSettings {
    const unknown = options.capabilities?.find((c) => !CAPABILITIES.has(c));
    if (unknown !== undefined) {
      invalid(`unknown capability "${unknown.slice(0, 40)}"; use a task id or "any"`);
    }
    const out: SkillSettings = {};
    if (options.visibility !== undefined) out.visibility = options.visibility;
    if (options.tags !== undefined) out.tags = options.tags;
    if (options.capabilities !== undefined) out.capabilities = options.capabilities;
    return out;
  }

  async revisions(name: string) {
    const skill = await this.own.skill(this.me, name);
    const revisions = await this.own.revisions(this.me, name);
    return {
      current_revision: skill?.currentRevision ?? null,
      revisions: revisions.map(revisionSummary),
    };
  }

  async revision(name: string, revision: number) {
    return { revision: revisionView(await this.own.revision(this.me, name, revision)) };
  }

  async setCurrent(name: string, revision: number, expectedRevision?: number | null) {
    return servedView(await this.own.setCurrent(this.me, name, revision, expectedRevision));
  }

  async unpublish(name: string, expectedRevision?: number | null) {
    return { skill: skillView(await this.own.unpublish(this.me, name, expectedRevision)) };
  }

  async deleteRevision(name: string, revision: number) {
    await this.own.deleteRevision(this.me, name, revision);
    return { deleted: true, revision };
  }

  async update(name: string, settings: SkillSettings, expectedRevision?: number | null) {
    const { skill, revoked } = await this.own.updateSettings(
      this.me,
      name,
      this.settings(settings),
      expectedRevision,
    );
    return { skill: skillView(skill), revoked_grants: revoked };
  }

  async delete(name: string) {
    const { revoked } = await this.own.deleteSkill(this.me, name);
    return { deleted: true, name, revoked_grants: revoked };
  }

  async grant(name: string, principal: string) {
    const access = await this.own.grant(this.me, name, principal);
    const skill = (await this.own.skill(this.me, name)) as Skill;
    return { grant: grantView(access), uri: skillUri(skill) };
  }

  async revoke(name: string, principal: string) {
    return { revoked: await this.own.revoke(this.me, name, principal) };
  }

  async grants(name: string) {
    return { grants: (await this.own.grants(this.me, name)).map(grantView) };
  }

  /**
   * List another account's team skill in the caller's catalog. The owner's
   * registry must hold a grant for the caller; the share remembers it.
   */
  async addShared(uri: string) {
    const { ownerId, name } = teamSkill(uri);
    if (ownerId === this.me) invalid("your own team skills are listed already");
    const access = await this.ctx.registries.getByName(ownerId).access(ownerId, name, this.me);
    if (!access) {
      throw new SkillRegistryError(`no team skill at ${uri} is shared with you`, "not_found");
    }
    await this.own.addShare(this.me, ownerId, name, access.grantId);
    return { uri: `${SKILL_SCHEME}team/${ownerId}/${name}/SKILL.md`, added: true };
  }

  async removeShared(uri: string) {
    const { ownerId, name } = teamSkill(uri);
    return { removed: await this.own.removeShare(this.me, ownerId, name) };
  }
}
