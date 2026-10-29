/**
 * One account's skills, on Durable Object storage (AccountSkills,
 * `MULTIX_SKILLS.getByName(accountId)`): the account's own skills, their
 * immutable revisions and drafts, content-addressed file blobs, the accounts
 * granted read access to its team skills, and the other accounts' team skills
 * this account chose to list. Keeping each account's registry in its own
 * object means a lookup can only ever see that account's records.
 *
 *   skill:<name>               Skill
 *   rev:<name>:<000001>        SkillRevision (never rewritten once published)
 *   draft:<name>               SkillDraft (the owner's working copy)
 *   blob:<sha256 hex>          file bytes, shared by every revision and draft holding them
 *   ref:<sha256 hex>:<holder>  one revision or draft key holding that blob
 *   access:<name>:<accountId>  SkillAccess (team skills only)
 *   share:<ownerId>:<name>     SkillShare: a team skill of another account listed here
 *
 * Writes put content first and metadata last: blobs and their references are
 * written before the revision or draft naming them, so a write cut short
 * leaves at most unreferenced blobs, never a record whose files are missing.
 * Removals go the other way (record, then references, then blobs no holder
 * references any more). Every read re-hashes the stored bytes.
 */

import {
  decodeText,
  fileSetProblem,
  isSafeRelativePath,
  isTextMediaType,
  manifestDigest,
  mediaTypeFor,
  sha256Digest,
} from "./skill-files.js";
import {
  type Frontmatter,
  FrontmatterError,
  isValidSkillName,
  parseFrontmatter,
} from "./skill-frontmatter.js";
import {
  ACCOUNT_ID_RE,
  MAX_BYTES_PER_FILE,
  MAX_BYTES_PER_SKILL,
  MAX_FILES_PER_SKILL,
  MAX_GRANTS_PER_SKILL,
  MAX_REVISIONS_PER_SKILL,
  MAX_TAGS,
  MAX_TAG_CHARS,
  type Skill,
  type SkillAccess,
  type SkillDraft,
  type SkillFile,
  type SkillRevision,
  type SkillShare,
} from "./skill-types.js";

/** The subset of Durable Object storage the registry uses (same shape as the event hub's). */
export interface RegistryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T>(options: { prefix: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
}

export type RegistryErrorReason = "invalid" | "not_found" | "conflict" | "corrupt";

/** A refused write or read; the message is safe to show the caller. */
export class SkillRegistryError extends Error {
  override name = "SkillRegistryError";
  constructor(
    message: string,
    readonly reason: RegistryErrorReason,
  ) {
    super(message);
  }
}

/** A skill as a reader sees it: identity plus the revision currently served. */
export interface ServedSkill {
  skill: Skill;
  revision: SkillRevision;
}

export interface FileInput {
  path: string;
  bytes: Uint8Array;
}

/** Skill-level settings an owner may change; omitted fields stay as they are. */
export interface SkillSettings {
  visibility?: "private" | "team";
  tags?: string[];
  capabilities?: string[];
}

export interface PublishInput extends SkillSettings {
  ownerId: string;
  files: FileInput[];
  visibility: "private" | "team";
  /** Refuse unless the served revision is this one (null: no served revision). */
  expectedRevision?: number | null;
}

export interface DraftInput {
  ownerId: string;
  name: string;
  /** Files to add or replace. */
  files?: FileInput[];
  /** Paths to remove from the draft. */
  delete?: string[];
  /** Start from an empty file set instead of the existing draft or served revision. */
  replace?: boolean;
  /** Start a new draft from this revision instead of the served one. */
  fromRevision?: number;
  /** Refuse unless the existing draft has this digest (null: no draft may exist). */
  expectedDigest?: string | null;
}

export interface PublishDraftInput extends SkillSettings {
  ownerId: string;
  name: string;
  expectedDigest?: string;
  expectedRevision?: number | null;
}

/** Most skills one account may hold. */
export const MAX_SKILLS_PER_ACCOUNT = 200;
/** Most team skills of other accounts listed for one account. */
export const MAX_SHARES_PER_ACCOUNT = 200;
const PUT_BATCH = 128;
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

const skillKey = (name: string) => `skill:${name}`;
const draftKey = (name: string) => `draft:${name}`;
const revKey = (name: string, revision: number) =>
  `rev:${name}:${String(revision).padStart(6, "0")}`;
const hexOf = (digest: string) => digest.slice("sha256:".length);
const blobKey = (digest: string) => `blob:${hexOf(digest)}`;
const refKey = (digest: string, holder: string) => `ref:${hexOf(digest)}:${holder}`;

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

function checkName(name: string): void {
  if (!isValidSkillName(name)) {
    throw new SkillRegistryError(
      "a skill name is 1-64 lowercase letters, digits and single hyphens",
      "invalid",
    );
  }
}

function checkPrincipal(principal: string): void {
  if (!ACCOUNT_ID_RE.test(principal)) {
    throw new SkillRegistryError("an account id looks like gh-<digits>", "invalid");
  }
}

/** A text file's bytes must decode as UTF-8 without a BOM, so served text re-encodes to them. */
function checkFileContent(file: FileInput): void {
  if (isTextMediaType(mediaTypeFor(file.path) ?? "") && decodeText(file.bytes) === undefined) {
    throw new SkillRegistryError(`${file.path} is not UTF-8 text without a BOM`, "invalid");
  }
}

function checkFileSet(files: readonly { path: string; size: number }[]): void {
  const problem = fileSetProblem(files, {
    maxFiles: MAX_FILES_PER_SKILL,
    maxBytes: MAX_BYTES_PER_SKILL,
    maxFileBytes: MAX_BYTES_PER_FILE,
  });
  if (problem) throw new SkillRegistryError(problem, "invalid");
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function notFound(name: string): never {
  throw new SkillRegistryError(`no skill named "${name}"`, "not_found");
}

function conflict(message: string): never {
  throw new SkillRegistryError(message, "conflict");
}

export class SkillRegistry {
  constructor(
    private readonly storage: RegistryStorage,
    private readonly now: () => number = Date.now,
  ) {}

  private async putAll(entries: [string, unknown][]): Promise<void> {
    for (let i = 0; i < entries.length; i += PUT_BATCH) {
      await this.storage.put(Object.fromEntries(entries.slice(i, i + PUT_BATCH)));
    }
  }

  private async deleteAll(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += PUT_BATCH) {
      await this.storage.delete(keys.slice(i, i + PUT_BATCH));
    }
  }

  /** Describe files by digest without storing anything yet. */
  private async describe(files: readonly FileInput[]): Promise<SkillFile[]> {
    const out: SkillFile[] = [];
    for (const file of files) {
      out.push({
        path: file.path,
        mediaType: mediaTypeFor(file.path) as string,
        size: file.bytes.length,
        digest: await sha256Digest(file.bytes),
      });
    }
    return out;
  }

  /** Store file bytes under their digests (before any reference to them). */
  private async storeBlobs(files: readonly FileInput[], described: readonly SkillFile[]) {
    const blobs = new Map<string, Uint8Array>();
    files.forEach((file, i) => blobs.set((described[i] as SkillFile).digest, file.bytes));
    await this.putAll([...blobs].map(([digest, bytes]) => [blobKey(digest), bytes]));
  }

  private async addRefs(holder: string, files: readonly SkillFile[]): Promise<void> {
    const digests = new Set(files.map((f) => f.digest));
    await this.putAll([...digests].map((d) => [refKey(d, holder), 1]));
  }

  /**
   * Drop `holder`'s references to `digests` (after its record no longer names
   * them), then delete each blob no other revision or draft references.
   */
  private async release(holder: string, digests: Iterable<string>): Promise<void> {
    const unique = [...new Set(digests)];
    await this.deleteAll(unique.map((d) => refKey(d, holder)));
    const orphans: string[] = [];
    for (const digest of unique) {
      const left = await this.storage.list({ prefix: `ref:${hexOf(digest)}:`, limit: 1 });
      if (left.size === 0) orphans.push(blobKey(digest));
    }
    await this.deleteAll(orphans);
  }

  private async readBlob(file: SkillFile): Promise<Uint8Array> {
    const bytes = await this.storage.get<Uint8Array>(blobKey(file.digest));
    if (!bytes || bytes.length !== file.size || (await sha256Digest(bytes)) !== file.digest) {
      throw new SkillRegistryError("stored skill content does not match its digest", "corrupt");
    }
    return bytes;
  }

  private async skillOrThrow(name: string): Promise<Skill> {
    return (await this.storage.get<Skill>(skillKey(name))) ?? notFound(name);
  }

  private async revisionOrThrow(name: string, revision: number): Promise<SkillRevision> {
    const record = await this.storage.get<SkillRevision>(revKey(name, revision));
    if (!record) {
      throw new SkillRegistryError(`skill "${name}" has no revision ${revision}`, "not_found");
    }
    return record;
  }

  private expectRevision(skill: Skill | undefined, expected: number | null | undefined): void {
    if (expected === undefined) return;
    const current = skill?.currentRevision ?? null;
    if (current !== expected) {
      conflict(
        `the served revision is ${current ?? "none"}, not ${expected ?? "none"}; reload and retry`,
      );
    }
  }

  private async countSkills(): Promise<number> {
    return (await this.storage.list({ prefix: "skill:", limit: MAX_SKILLS_PER_ACCOUNT })).size;
  }

  /**
   * Validate a complete file set and store it as the next published revision
   * of the skill its SKILL.md names (creating the skill on its first one).
   * `storeContent` runs after every check passed and before any record is
   * written, so a refused publish stores nothing.
   */
  private async commit(
    ownerId: string,
    files: SkillFile[],
    skillMdText: string,
    settings: SkillSettings,
    storeContent: () => Promise<void>,
    expectedName?: string,
    expectedRevision?: number | null,
  ): Promise<ServedSkill> {
    checkFileSet(files);
    let frontmatter: Frontmatter;
    try {
      frontmatter = parseFrontmatter(skillMdText);
    } catch (error) {
      if (!(error instanceof FrontmatterError)) throw error;
      throw new SkillRegistryError(error.message, "invalid");
    }
    const name = frontmatter.name;
    if (expectedName !== undefined && name !== expectedName) {
      throw new SkillRegistryError(
        `SKILL.md names the skill "${name}", but the draft is for "${expectedName}"`,
        "invalid",
      );
    }
    const existing = await this.storage.get<Skill>(skillKey(name));
    this.expectRevision(existing, expectedRevision);
    if (!existing && (await this.countSkills()) >= MAX_SKILLS_PER_ACCOUNT) {
      throw new SkillRegistryError(
        `an account may hold at most ${MAX_SKILLS_PER_ACCOUNT} skills`,
        "invalid",
      );
    }
    const kept = await this.storage.list({
      prefix: `rev:${name}:`,
      limit: MAX_REVISIONS_PER_SKILL,
    });
    if (kept.size >= MAX_REVISIONS_PER_SKILL) {
      throw new SkillRegistryError(
        `a skill keeps at most ${MAX_REVISIONS_PER_SKILL} revisions; delete old ones first`,
        "invalid",
      );
    }
    const tags = cleanTags(settings.tags ?? existing?.tags, "tags");
    const capabilities = cleanTags(settings.capabilities ?? existing?.capabilities, "capabilities");
    const visibility = settings.visibility ?? existing?.visibility ?? "private";

    let last = existing?.lastRevision;
    if (last === undefined) {
      const newest = await this.storage.list<SkillRevision>({
        prefix: `rev:${name}:`,
        reverse: true,
        limit: 1,
      });
      last = [...newest.values()][0]?.revision ?? 0;
    }
    const revision = last + 1;
    const sorted = [...files].sort(byPath);
    const at = this.now();
    const skill: Skill = {
      id: existing?.id ?? `sk_${crypto.randomUUID()}`,
      name,
      ownerId,
      visibility: visibility as "private" | "team",
      tags,
      capabilities,
      source: "user",
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      currentRevision: revision,
      lastRevision: revision,
    };
    const record: SkillRevision = {
      skillId: skill.id,
      revision,
      version: versionOf(frontmatter),
      manifestDigest: await manifestDigest(sorted),
      status: "published",
      createdAt: at,
      publishedAt: at,
      frontmatter,
      files: sorted,
    };
    const key = revKey(name, revision);
    await storeContent();
    await this.addRefs(key, sorted);
    await this.storage.put({ [key]: record, [skillKey(name)]: skill });
    if (existing && existing.visibility !== skill.visibility) await this.revokeAll(name);
    return { skill, revision: record };
  }

  /**
   * Store a complete file set as a new published revision of a skill (creating
   * the skill on its first revision). The skill's name comes from SKILL.md.
   */
  async publish(input: PublishInput): Promise<ServedSkill> {
    checkFileSet(input.files.map((f) => ({ path: f.path, size: f.bytes.length })));
    for (const file of input.files) checkFileContent(file);
    const files = await this.describe(input.files);
    const skillMd = input.files.find((f) => f.path === "SKILL.md") as FileInput;
    return this.commit(
      input.ownerId,
      files,
      decodeText(skillMd.bytes) as string,
      input,
      () => this.storeBlobs(input.files, files),
      undefined,
      input.expectedRevision,
    );
  }

  /** Create or patch the draft of skill `name`; the draft is not served to anyone. */
  async saveDraft(input: DraftInput): Promise<SkillDraft> {
    checkName(input.name);
    const key = draftKey(input.name);
    const existing = await this.storage.get<SkillDraft>(key);
    if (input.expectedDigest !== undefined && (existing?.digest ?? null) !== input.expectedDigest) {
      conflict(
        existing
          ? `the draft changed (digest ${existing.digest}); reload and retry`
          : "there is no draft to update; start a new one",
      );
    }
    let base: SkillFile[] = [];
    let baseRevision: number | null = null;
    if (existing && !input.replace) {
      if (input.fromRevision !== undefined) {
        throw new SkillRegistryError(
          "a draft already exists; discard it or pass replace to start from a revision",
          "invalid",
        );
      }
      base = existing.files;
      baseRevision = existing.baseRevision;
    } else if (!input.replace || input.fromRevision !== undefined) {
      const skill = await this.storage.get<Skill>(skillKey(input.name));
      const from = input.fromRevision ?? skill?.currentRevision ?? null;
      if (from !== null) {
        base = (await this.revisionOrThrow(input.name, from)).files;
        baseRevision = from;
      }
    }
    if (
      !existing &&
      (await this.storage.list({ prefix: "draft:", limit: MAX_SKILLS_PER_ACCOUNT })).size >=
        MAX_SKILLS_PER_ACCOUNT
    ) {
      throw new SkillRegistryError(
        `an account may hold at most ${MAX_SKILLS_PER_ACCOUNT} drafts`,
        "invalid",
      );
    }

    const byFilePath = new Map(base.map((f) => [f.path, f]));
    for (const path of input.delete ?? []) {
      if (!byFilePath.delete(path)) {
        throw new SkillRegistryError(`the draft has no file "${path.slice(0, 80)}"`, "invalid");
      }
    }
    const incoming = input.files ?? [];
    for (const file of incoming) {
      if (!isSafeRelativePath(file.path)) {
        throw new SkillRegistryError(`unsafe file path "${file.path.slice(0, 80)}"`, "invalid");
      }
      checkFileContent(file);
    }
    const seen = new Set<string>();
    for (const file of incoming) {
      if (seen.has(file.path)) {
        throw new SkillRegistryError(`duplicate file path "${file.path}"`, "invalid");
      }
      seen.add(file.path);
      byFilePath.set(file.path, {
        path: file.path,
        mediaType: mediaTypeFor(file.path) ?? "",
        size: file.bytes.length,
        digest: "",
      });
    }
    checkFileSet([...byFilePath.values()]);
    const described = await this.describe(incoming);
    for (const file of described) byFilePath.set(file.path, file);

    const files = [...byFilePath.values()].sort(byPath);
    const at = this.now();
    const draft: SkillDraft = {
      name: input.name,
      baseRevision,
      digest: await manifestDigest(files),
      files,
      createdAt: existing && !input.replace ? existing.createdAt : at,
      updatedAt: at,
    };
    await this.storeBlobs(incoming, described);
    await this.addRefs(key, files);
    await this.storage.put({ [key]: draft });
    if (existing) {
      const now = new Set(files.map((f) => f.digest));
      await this.release(
        key,
        existing.files.map((f) => f.digest).filter((d) => !now.has(d)),
      );
    }
    return draft;
  }

  async draft(name: string): Promise<SkillDraft | null> {
    return (await this.storage.get<SkillDraft>(draftKey(name))) ?? null;
  }

  /** Remove the draft of `name`; false when there was none. */
  async discardDraft(name: string, expectedDigest?: string): Promise<boolean> {
    const key = draftKey(name);
    const existing = await this.storage.get<SkillDraft>(key);
    if (!existing) return false;
    if (expectedDigest !== undefined && existing.digest !== expectedDigest) {
      conflict(`the draft changed (digest ${existing.digest}); reload and retry`);
    }
    await this.storage.delete([key]);
    await this.release(
      key,
      existing.files.map((f) => f.digest),
    );
    return true;
  }

  /** Publish the draft of `name` as its next revision, then drop the draft. */
  async publishDraft(input: PublishDraftInput): Promise<ServedSkill> {
    const key = draftKey(input.name);
    const existing = await this.storage.get<SkillDraft>(key);
    if (!existing) {
      throw new SkillRegistryError(`skill "${input.name}" has no draft`, "not_found");
    }
    if (input.expectedDigest !== undefined && existing.digest !== input.expectedDigest) {
      conflict(`the draft changed (digest ${existing.digest}); reload and retry`);
    }
    // Re-hash every file: a draft is published only with all of its content intact.
    let skillMdText: string | undefined;
    for (const file of existing.files) {
      const bytes = await this.readBlob(file);
      if (file.path === "SKILL.md") skillMdText = decodeText(bytes);
    }
    const served = await this.commit(
      input.ownerId,
      existing.files,
      skillMdText ?? "",
      input,
      async () => {},
      input.name,
      input.expectedRevision,
    );
    await this.storage.delete([key]);
    await this.release(
      key,
      existing.files.map((f) => f.digest),
    );
    return served;
  }

  /** The account's own skills (served or not) and the names of its drafts. */
  async ownSkills(): Promise<{ skills: Skill[]; drafts: string[] }> {
    const skills = [...(await this.storage.list<Skill>({ prefix: "skill:" })).values()];
    const drafts = [...(await this.storage.list<SkillDraft>({ prefix: "draft:" })).values()].map(
      (d) => d.name,
    );
    return { skills, drafts };
  }

  async skill(name: string): Promise<Skill | null> {
    return (await this.storage.get<Skill>(skillKey(name))) ?? null;
  }

  /** Every stored revision of `name`, oldest first. */
  async revisions(name: string): Promise<SkillRevision[]> {
    await this.skillOrThrow(name);
    return [
      ...(
        await this.storage.list<SkillRevision>({
          prefix: `rev:${name}:`,
          limit: MAX_REVISIONS_PER_SKILL,
        })
      ).values(),
    ];
  }

  async revision(name: string, revision: number): Promise<SkillRevision> {
    await this.skillOrThrow(name);
    return this.revisionOrThrow(name, revision);
  }

  /** Bytes of one file of the draft or of a stored revision, for the owner. */
  async ownFile(
    name: string,
    from: "draft" | number,
    path: string,
  ): Promise<{ file: SkillFile; bytes: Uint8Array } | null> {
    const files =
      from === "draft"
        ? (await this.storage.get<SkillDraft>(draftKey(name)))?.files
        : (await this.storage.get<SkillRevision>(revKey(name, from)))?.files;
    const file = files?.find((f) => f.path === path);
    if (!file) return null;
    return { file, bytes: await this.readBlob(file) };
  }

  /** Serve `revision` of `name` (rollback or roll forward). */
  async setCurrent(
    name: string,
    revision: number,
    expectedRevision?: number | null,
  ): Promise<ServedSkill> {
    const skill = await this.skillOrThrow(name);
    this.expectRevision(skill, expectedRevision);
    const record = await this.revisionOrThrow(name, revision);
    const updated: Skill = { ...skill, currentRevision: revision, updatedAt: this.now() };
    await this.storage.put({ [skillKey(name)]: updated });
    return { skill: updated, revision: record };
  }

  /** Stop serving `name` without deleting anything. */
  async unpublish(name: string, expectedRevision?: number | null): Promise<Skill> {
    const skill = await this.skillOrThrow(name);
    this.expectRevision(skill, expectedRevision);
    const updated: Skill = { ...skill, currentRevision: null, updatedAt: this.now() };
    await this.storage.put({ [skillKey(name)]: updated });
    return updated;
  }

  /** Delete a stored revision that is not the served one. */
  async deleteRevision(name: string, revision: number): Promise<void> {
    const skill = await this.skillOrThrow(name);
    if (skill.currentRevision === revision) {
      throw new SkillRegistryError(
        "the served revision cannot be deleted; serve another one or unpublish first",
        "invalid",
      );
    }
    const record = await this.revisionOrThrow(name, revision);
    const key = revKey(name, revision);
    if (skill.lastRevision === undefined) {
      // Records from before lastRevision existed: pin the newest number before deleting it.
      const newest = await this.storage.list<SkillRevision>({
        prefix: `rev:${name}:`,
        reverse: true,
        limit: 1,
      });
      const last = [...newest.values()][0]?.revision ?? revision;
      await this.storage.put({ [skillKey(name)]: { ...skill, lastRevision: last } });
    }
    await this.storage.delete([key]);
    await this.release(
      key,
      record.files.map((f) => f.digest),
    );
  }

  /**
   * Change visibility, tags or capabilities. Changing visibility revokes every
   * grant, so a skill made private and later shared again starts with no readers.
   */
  async updateSettings(
    name: string,
    settings: SkillSettings,
    expectedRevision?: number | null,
  ): Promise<{ skill: Skill; revoked: string[] }> {
    const skill = await this.skillOrThrow(name);
    this.expectRevision(skill, expectedRevision);
    const updated: Skill = {
      ...skill,
      visibility: settings.visibility ?? skill.visibility,
      tags: settings.tags ? cleanTags(settings.tags, "tags") : skill.tags,
      capabilities: settings.capabilities
        ? cleanTags(settings.capabilities, "capabilities")
        : skill.capabilities,
      updatedAt: this.now(),
    };
    await this.storage.put({ [skillKey(name)]: updated });
    const revoked = updated.visibility !== skill.visibility ? await this.revokeAll(name) : [];
    return { skill: updated, revoked };
  }

  /** Delete a skill with its revisions, draft and grants; unreferenced blobs go too. */
  async deleteSkill(name: string): Promise<{ revoked: string[] }> {
    await this.skillOrThrow(name);
    await this.storage.delete([skillKey(name)]);
    const revoked = await this.revokeAll(name);
    const revisions = await this.storage.list<SkillRevision>({ prefix: `rev:${name}:` });
    for (const [key, record] of revisions) {
      await this.storage.delete([key]);
      await this.release(
        key,
        record.files.map((f) => f.digest),
      );
    }
    await this.discardDraft(name);
    return { revoked };
  }

  private async revokeAll(name: string): Promise<string[]> {
    const rows = await this.storage.list<SkillAccess>({ prefix: `access:${name}:` });
    await this.deleteAll([...rows.keys()]);
    return [...rows.values()].map((a) => a.principal);
  }

  /** Let `principal` read team skill `name`; granting again keeps the existing grant. */
  async grant(name: string, principal: string): Promise<SkillAccess> {
    checkPrincipal(principal);
    const skill = await this.skillOrThrow(name);
    if (skill.visibility !== "team") {
      throw new SkillRegistryError("only team skills can be shared", "invalid");
    }
    if (principal === skill.ownerId) {
      throw new SkillRegistryError("the owner always reads its own skills", "invalid");
    }
    const key = `access:${name}:${principal}`;
    const existing = await this.storage.get<SkillAccess>(key);
    if (existing) return existing;
    const grants = await this.storage.list({
      prefix: `access:${name}:`,
      limit: MAX_GRANTS_PER_SKILL,
    });
    if (grants.size >= MAX_GRANTS_PER_SKILL) {
      throw new SkillRegistryError(
        `a skill may be shared with at most ${MAX_GRANTS_PER_SKILL} accounts`,
        "invalid",
      );
    }
    const access: SkillAccess = {
      skillId: skill.id,
      principal,
      permissions: ["read"],
      grantedAt: this.now(),
      grantId: `gr_${crypto.randomUUID()}`,
    };
    await this.storage.put({ [key]: access });
    return access;
  }

  /** Withdraw `principal`'s grant; false when it had none. */
  async revoke(name: string, principal: string): Promise<boolean> {
    checkPrincipal(principal);
    await this.skillOrThrow(name);
    return (await this.storage.delete([`access:${name}:${principal}`])) > 0;
  }

  async grants(name: string): Promise<SkillAccess[]> {
    await this.skillOrThrow(name);
    return [...(await this.storage.list<SkillAccess>({ prefix: `access:${name}:` })).values()];
  }

  /** `principal`'s grant on team skill `name`, or null (also for a skill that is not team). */
  async access(name: string, principal: string): Promise<SkillAccess | null> {
    const skill = await this.storage.get<Skill>(skillKey(name));
    if (!skill || skill.visibility !== "team") return null;
    return (await this.storage.get<SkillAccess>(`access:${name}:${principal}`)) ?? null;
  }

  /** List (in this, the grantee's registry) a team skill `ownerId` granted under `grantId`. */
  async addShare(ownerId: string, name: string, grantId: string): Promise<SkillShare> {
    checkPrincipal(ownerId);
    checkName(name);
    const key = `share:${ownerId}:${name}`;
    const existing = await this.storage.get<SkillShare>(key);
    if (!existing) {
      const count = (await this.storage.list({ prefix: "share:", limit: MAX_SHARES_PER_ACCOUNT }))
        .size;
      if (count >= MAX_SHARES_PER_ACCOUNT) {
        throw new SkillRegistryError(
          `an account may list at most ${MAX_SHARES_PER_ACCOUNT} shared skills`,
          "invalid",
        );
      }
    }
    const share: SkillShare = { ownerId, name, grantId, addedAt: this.now() };
    await this.storage.put({ [key]: share });
    return share;
  }

  /** Stop listing another account's team skill; false when it was not listed. */
  async removeShare(ownerId: string, name: string): Promise<boolean> {
    return (await this.storage.delete([`share:${ownerId}:${name}`])) > 0;
  }

  /** Other accounts' team skills listed here. */
  async shares(): Promise<SkillShare[]> {
    const rows = await this.storage.list<SkillShare>({
      prefix: "share:",
      limit: MAX_SHARES_PER_ACCOUNT,
    });
    return [...rows.values()];
  }

  private async canRead(
    skill: Skill,
    ownerId: string,
    principal: string,
    grantId?: string,
  ): Promise<boolean> {
    if (principal === ownerId) return true;
    if (skill.visibility !== "team") return false;
    const access = await this.storage.get<SkillAccess>(`access:${skill.name}:${principal}`);
    return access !== undefined && (grantId === undefined || access.grantId === grantId);
  }

  /**
   * The served revision of skill `name` for `principal`, or null when it does
   * not exist, has nothing published, or `principal` may not read it (the
   * same answer, so a reader learns nothing about skills it cannot see).
   * With `grantId`, a grantee's read must also come from that very grant.
   */
  async served(
    ownerId: string,
    principal: string,
    name: string,
    grantId?: string,
  ): Promise<ServedSkill | null> {
    const skill = await this.storage.get<Skill>(skillKey(name));
    if (!skill || skill.currentRevision === null) return null;
    if (!(await this.canRead(skill, ownerId, principal, grantId))) return null;
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
    return { file, bytes: await this.readBlob(file) };
  }
}
