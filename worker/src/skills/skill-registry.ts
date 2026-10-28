/**
 * One account's skills, on Durable Object storage (AccountSkills,
 * `MULTIX_SKILLS.getByName(accountId)`): the account's own skills, their
 * immutable revisions and content-addressed file blobs, the accounts granted
 * read access to its team skills, and an index of other accounts' team skills
 * shared with it. Keeping each account's registry in its own object means a
 * lookup can only ever see that account's records.
 *
 *   skill:<name>               Skill
 *   rev:<name>:<000001>        SkillRevision (never rewritten once published)
 *   blob:<sha256 hex>          file bytes, shared by every revision holding them
 *   access:<name>:<accountId>  SkillAccess (team skills only)
 *   share:<ownerId>:<name>     a team skill of another account readable here
 *
 * Writes put content first and metadata last: blobs are content-addressed and
 * immutable, so a write cut short leaves at most unreferenced blobs, never a
 * revision whose files are missing. Every read re-hashes the stored bytes.
 */

import { fileSetProblem, manifestDigest, mediaTypeFor, sha256Digest } from "./skill-files.js";
import { type Frontmatter, FrontmatterError, parseFrontmatter } from "./skill-frontmatter.js";
import {
  MAX_BYTES_PER_FILE,
  MAX_BYTES_PER_SKILL,
  MAX_FILES_PER_SKILL,
  MAX_TAGS,
  MAX_TAG_CHARS,
  type Skill,
  type SkillAccess,
  type SkillFile,
  type SkillRevision,
} from "./skill-types.js";

/** The subset of Durable Object storage the registry uses (same shape as the event hub's). */
export interface RegistryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T>(options: { prefix: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
}

/** A refused write or read; the message is safe to show the caller. */
export class SkillRegistryError extends Error {
  override name = "SkillRegistryError";
  constructor(
    message: string,
    readonly reason: "invalid" | "not_found" | "corrupt",
  ) {
    super(message);
  }
}

/** A skill as a reader sees it: identity plus the revision currently served. */
export interface ServedSkill {
  skill: Skill;
  revision: SkillRevision;
}

export interface PublishInput {
  ownerId: string;
  files: { path: string; bytes: Uint8Array }[];
  visibility: "private" | "team";
  tags?: string[];
  capabilities?: string[];
}

/** Most skills one account may hold. */
export const MAX_SKILLS_PER_ACCOUNT = 200;
const PUT_BATCH = 128;
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

const revKey = (name: string, revision: number) =>
  `rev:${name}:${String(revision).padStart(6, "0")}`;

function versionOf(frontmatter: Frontmatter): string | null {
  const metadata = frontmatter.metadata;
  const raw =
    frontmatter.version ??
    (metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata.version
      : undefined);
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
}

function cleanTags(tags: string[] | undefined, label: string): string[] {
  const out = [...new Set(tags ?? [])];
  if (out.length > MAX_TAGS)
    throw new SkillRegistryError(`at most ${MAX_TAGS} ${label}`, "invalid");
  for (const tag of out) {
    if (tag.length > MAX_TAG_CHARS || !TAG_RE.test(tag)) {
      throw new SkillRegistryError(
        `invalid ${label.slice(0, -1)} "${tag.slice(0, 40)}"`,
        "invalid",
      );
    }
  }
  return out;
}

export class SkillRegistry {
  constructor(
    private readonly storage: RegistryStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Store a new published revision of a skill (creating the skill on its
   * first revision). The skill's name comes from its SKILL.md frontmatter.
   */
  async publish(input: PublishInput): Promise<ServedSkill> {
    const problem = fileSetProblem(
      input.files.map((f) => ({ path: f.path, size: f.bytes.length })),
      {
        maxFiles: MAX_FILES_PER_SKILL,
        maxBytes: MAX_BYTES_PER_SKILL,
        maxFileBytes: MAX_BYTES_PER_FILE,
      },
    );
    if (problem) throw new SkillRegistryError(problem, "invalid");
    const skillMd = input.files.find((f) => f.path === "SKILL.md") as { bytes: Uint8Array };
    let frontmatter: Frontmatter;
    try {
      frontmatter = parseFrontmatter(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(skillMd.bytes),
      );
    } catch (error) {
      const message = error instanceof FrontmatterError ? error.message : "SKILL.md is not UTF-8";
      throw new SkillRegistryError(message, "invalid");
    }
    const tags = cleanTags(input.tags, "tags");
    const capabilities = cleanTags(input.capabilities, "capabilities");

    const files: SkillFile[] = [];
    const blobs: [string, Uint8Array][] = [];
    for (const file of input.files) {
      const digest = await sha256Digest(file.bytes);
      files.push({
        path: file.path,
        mediaType: mediaTypeFor(file.path) as string,
        size: file.bytes.length,
        digest,
      });
      blobs.push([`blob:${digest.slice("sha256:".length)}`, file.bytes]);
    }
    files.sort((a, b) => (a.path < b.path ? -1 : 1));

    const name = frontmatter.name;
    const existing = await this.storage.get<Skill>(`skill:${name}`);
    if (!existing) {
      const count = (await this.storage.list({ prefix: "skill:", limit: MAX_SKILLS_PER_ACCOUNT }))
        .size;
      if (count >= MAX_SKILLS_PER_ACCOUNT) {
        throw new SkillRegistryError(
          `an account may hold at most ${MAX_SKILLS_PER_ACCOUNT} skills`,
          "invalid",
        );
      }
    }
    const last = await this.storage.list<SkillRevision>({
      prefix: `rev:${name}:`,
      reverse: true,
      limit: 1,
    });
    const revision = ([...last.values()][0]?.revision ?? 0) + 1;

    for (let i = 0; i < blobs.length; i += PUT_BATCH) {
      await this.storage.put(Object.fromEntries(blobs.slice(i, i + PUT_BATCH)));
    }
    const at = this.now();
    const skill: Skill = {
      id: existing?.id ?? `sk_${crypto.randomUUID()}`,
      name,
      ownerId: input.ownerId,
      visibility: input.visibility,
      tags,
      capabilities,
      source: "user",
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      currentRevision: revision,
    };
    const record: SkillRevision = {
      skillId: skill.id,
      revision,
      version: versionOf(frontmatter),
      manifestDigest: await manifestDigest(files),
      status: "published",
      createdAt: at,
      publishedAt: at,
      frontmatter,
      files,
    };
    await this.storage.put({ [revKey(name, revision)]: record, [`skill:${name}`]: skill });
    return { skill, revision: record };
  }

  /** Let `principal` read a team skill of this account. */
  async grant(name: string, principal: string): Promise<SkillAccess> {
    const skill = await this.storage.get<Skill>(`skill:${name}`);
    if (!skill) throw new SkillRegistryError(`no skill named "${name}"`, "not_found");
    if (skill.visibility !== "team") {
      throw new SkillRegistryError("only team skills can be shared", "invalid");
    }
    const access: SkillAccess = {
      skillId: skill.id,
      principal,
      permissions: ["read"],
      grantedAt: this.now(),
    };
    await this.storage.put({ [`access:${name}:${principal}`]: access });
    return access;
  }

  /** Record (in the grantee's registry) that `ownerId` shared its skill `name`. */
  async addShare(ownerId: string, name: string): Promise<void> {
    await this.storage.put({ [`share:${ownerId}:${name}`]: { ownerId, name } });
  }

  /** Other accounts' team skills shared with this account, as `{ownerId, name}`. */
  async shares(): Promise<{ ownerId: string; name: string }[]> {
    const rows = await this.storage.list<{ ownerId: string; name: string }>({ prefix: "share:" });
    return [...rows.values()];
  }

  private async canRead(skill: Skill, ownerId: string, principal: string): Promise<boolean> {
    if (principal === ownerId) return true;
    if (skill.visibility !== "team") return false;
    return (await this.storage.get(`access:${skill.name}:${principal}`)) !== undefined;
  }

  /**
   * The served revision of skill `name` for `principal`, or null when it does
   * not exist, has nothing published, or `principal` may not read it (the
   * same answer, so a reader learns nothing about skills it cannot see).
   */
  async served(ownerId: string, principal: string, name: string): Promise<ServedSkill | null> {
    const skill = await this.storage.get<Skill>(`skill:${name}`);
    if (!skill || skill.currentRevision === null) return null;
    if (!(await this.canRead(skill, ownerId, principal))) return null;
    const revision = await this.storage.get<SkillRevision>(revKey(name, skill.currentRevision));
    if (!revision || revision.status !== "published") return null;
    return { skill, revision };
  }

  /** Every skill of this account `principal` may read, by name. */
  async listServed(ownerId: string, principal: string): Promise<ServedSkill[]> {
    const skills = await this.storage.list<Skill>({ prefix: "skill:" });
    const out: ServedSkill[] = [];
    for (const skill of skills.values()) {
      const served = await this.served(ownerId, principal, skill.name);
      if (served) out.push(served);
    }
    return out;
  }

  /**
   * Bytes of one file of the served revision, re-hashed against the revision's
   * digest. Fails as not found for a file the revision does not list.
   */
  async readFile(
    ownerId: string,
    principal: string,
    name: string,
    path: string,
  ): Promise<{ file: SkillFile; bytes: Uint8Array } | null> {
    const served = await this.served(ownerId, principal, name);
    const file = served?.revision.files.find((f) => f.path === path);
    if (!file) return null;
    const bytes = await this.storage.get<Uint8Array>(`blob:${file.digest.slice("sha256:".length)}`);
    if (!bytes || bytes.length !== file.size || (await sha256Digest(bytes)) !== file.digest) {
      throw new SkillRegistryError("stored skill content does not match its digest", "corrupt");
    }
    return { file, bytes };
  }
}
