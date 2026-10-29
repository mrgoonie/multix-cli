/**
 * The skills one caller may read, merged from the built-in catalog, the
 * caller's own registry and other accounts' team skills shared with them, and
 * addressed by `skill://` URIs:
 *
 *   skill://multix/SKILL.md                      built-in entry point (every caller)
 *   skill://multix/<task>/SKILL.md               built-in task skill, nested in `multix`
 *   skill://private/<name>/<file>                the caller's private skill
 *   skill://team/<ownerId>/<name>/<file>         a team skill the caller owns or was granted
 *
 * A URI is resolved for the caller alone: `private/` always means the
 * caller's own registry, and a team URI is answered only after the owner's
 * registry confirms the caller's grant. A shared team skill is listed only
 * after the grantee added it (so no account can push skills into another's
 * list), and only while the grant it was added under stands. Anything the
 * caller cannot read gets the same answer as a URI that does not exist.
 *
 * Read-only: nothing here writes, fetches a URL or runs a file.
 */

import type { SkillRegistryStub } from "./account-skills.js";
import { BUILTIN_CATALOG, type BuiltinCatalog } from "./builtin-skills.js";
import { isTextMediaType, manifestDigest, sha256Digest } from "./skill-files.js";
import type { Frontmatter } from "./skill-frontmatter.js";
import { type ServedSkill, registryRefusal } from "./skill-registry.js";
import { ACCOUNT_ID_RE, type SkillFile, type SkillVisibility } from "./skill-types.js";

export const SKILL_SCHEME = "skill://";
/** `_meta` key for this server's registry fields on entries (own reverse-domain prefix). */
export const SKILL_META_KEY = "me.zuey.multix/skill";
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
const MAX_URI_CHARS = 512;
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export type CatalogErrorCode =
  | "INVALID_URI"
  | "UNKNOWN_SKILL"
  | "NOT_FOUND"
  | "NOT_DIRECTORY"
  | "INVALID_CURSOR"
  | "STALE_REVISION"
  | "BINARY_FILE"
  | "PAYLOAD_TOO_LARGE"
  | "CORRUPT";

/** A deterministic refusal: `code` is stable, `message` names the URI. */
export class SkillCatalogError extends Error {
  override name = "SkillCatalogError";
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CatalogSkill {
  /** URI of the skill's SKILL.md. */
  uri: string;
  /** URI of the skill's root directory (no trailing slash). */
  root: string;
  frontmatter: Frontmatter;
  /** Every file of the skill, paths relative to `root`. */
  files: SkillFile[];
  id: string;
  visibility: SkillVisibility;
  ownerId: string | null;
  version: string | null;
  revision: number;
  manifestDigest: string;
  tags: string[];
  capabilities: string[];
}

export interface SkillEntry {
  uri: string;
  frontmatter: Frontmatter;
  resources: { uri: string; digest: string; size: number }[];
  _meta: Record<string, unknown>;
}

export interface FileContent {
  uri: string;
  mimeType: string;
  size: number;
  digest: string;
  bytes: Uint8Array;
}

export interface ResourceView {
  uri: string;
  name: string;
  mimeType: string;
  description?: string;
  size?: number;
}

export interface SkillsContext {
  /** The calling account. */
  userId: string;
  /** Account registries (`MULTIX_SKILLS`); built-ins only when absent. */
  registries?: { getByName(accountId: string): SkillRegistryStub };
}

type Located =
  | { kind: "builtin"; rel: string }
  | { kind: "private"; name: string; rel: string }
  | { kind: "team"; ownerId: string; name: string; rel: string };

/** Split a `skill://` URI into safe segments, or refuse it. */
export function parseSkillUri(uri: string): string[] {
  const refuse = (why: string): never => {
    throw new SkillCatalogError("INVALID_URI", `Invalid skill URI: ${why}`);
  };
  if (typeof uri !== "string" || uri.length > MAX_URI_CHARS) refuse("too long");
  if (!uri.startsWith(SKILL_SCHEME)) refuse("expected the skill:// scheme");
  const rest = uri.slice(SKILL_SCHEME.length);
  if (/[?#%\\\s]/.test(rest)) refuse("no query, fragment, percent-encoding or backslash");
  const segments = rest.split("/");
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment) || segment.includes("..") || segment.endsWith(".")) {
      refuse("every path segment must be a plain name (no `.`, `..` or empty segments)");
    }
  }
  return segments;
}

function locate(uri: string): Located {
  const [head, ...rest] = parseSkillUri(uri);
  if (head === "multix") return { kind: "builtin", rel: rest.join("/") };
  if (head === "private" && rest[0]) {
    return { kind: "private", name: rest[0], rel: rest.slice(1).join("/") };
  }
  // Team URIs name the owner by account id; anything else cannot address a registry.
  if (head === "team" && rest[0] && rest[1] && ACCOUNT_ID_RE.test(rest[0])) {
    return { kind: "team", ownerId: rest[0], name: rest[1], rel: rest.slice(2).join("/") };
  }
  throw new SkillCatalogError("UNKNOWN_SKILL", `No skill is served at ${uri}`);
}

function unknownSkill(uri: string): never {
  throw new SkillCatalogError("UNKNOWN_SKILL", `No skill is served at ${uri}`);
}

function notFound(uri: string): never {
  throw new SkillCatalogError("NOT_FOUND", `No resource is served at ${uri}`);
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Revision-level view of the built-in catalog, computed once per isolate. */
let builtinCache: Promise<CatalogSkill[]> | undefined;

async function builtinSkills(catalog: BuiltinCatalog): Promise<CatalogSkill[]> {
  const out: CatalogSkill[] = [];
  const metas = [...catalog.skills].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  for (const meta of metas) {
    const prefix = meta.dir === "" ? "" : `${meta.dir}/`;
    const files = catalog.files
      .filter((f) => f.path.startsWith(prefix))
      .map(({ text: _text, ...f }) => ({ ...f, path: f.path.slice(prefix.length) }))
      .sort(byPath);
    const root = `${SKILL_SCHEME}${catalog.root}${meta.dir === "" ? "" : `/${meta.dir}`}`;
    const version = meta.frontmatter.version;
    out.push({
      uri: `${root}/SKILL.md`,
      root,
      frontmatter: meta.frontmatter,
      files,
      id: `builtin:${catalog.root}${meta.dir === "" ? "" : `/${meta.dir}`}`,
      visibility: "builtin",
      ownerId: null,
      version: typeof version === "string" || typeof version === "number" ? String(version) : null,
      revision: 1,
      manifestDigest: await manifestDigest(files),
      tags: ["builtin"],
      capabilities: meta.capabilities,
    });
  }
  return out;
}

function fromServed(served: ServedSkill): CatalogSkill {
  const { skill, revision } = served;
  const root =
    skill.visibility === "team"
      ? `${SKILL_SCHEME}team/${skill.ownerId}/${skill.name}`
      : `${SKILL_SCHEME}private/${skill.name}`;
  return {
    uri: `${root}/SKILL.md`,
    root,
    frontmatter: revision.frontmatter,
    files: revision.files,
    id: skill.id,
    visibility: skill.visibility,
    ownerId: skill.ownerId,
    version: revision.version,
    revision: revision.revision,
    manifestDigest: revision.manifestDigest,
    tags: skill.tags,
    capabilities: skill.capabilities,
  };
}

/** The Skills extension entry for a skill (identical in skills/list and skills/get). */
export function skillEntry(skill: CatalogSkill): SkillEntry {
  return {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: skill.files.map((f) => ({
      uri: `${skill.root}/${f.path}`,
      digest: f.digest,
      size: f.size,
    })),
    _meta: {
      [SKILL_META_KEY]: {
        id: skill.id,
        version: skill.version,
        revision: skill.revision,
        manifestDigest: skill.manifestDigest,
        status: "published",
        visibility: skill.visibility,
        tags: skill.tags,
        capabilities: skill.capabilities,
      },
    },
  };
}

export function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ o: offset })).replace(/=+$/, "");
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(atob(cursor)) as { o?: unknown };
    if (Number.isSafeInteger(value.o) && (value.o as number) >= 0) return value.o as number;
  } catch {
    // fall through
  }
  throw new SkillCatalogError("INVALID_CURSOR", "Invalid cursor");
}

export function paginate<T>(
  items: T[],
  cursor: string | undefined,
  limit = DEFAULT_PAGE_SIZE,
): { page: T[]; nextCursor?: string } {
  const offset = decodeCursor(cursor);
  const size = Math.max(1, Math.min(limit, MAX_PAGE_SIZE));
  const page = items.slice(offset, offset + size);
  return offset + size < items.length
    ? { page, nextCursor: encodeCursor(offset + size) }
    : { page };
}

export class SkillCatalog {
  constructor(
    private readonly ctx: SkillsContext,
    private readonly catalog: BuiltinCatalog = BUILTIN_CATALOG,
  ) {}

  /** Whether any answer may depend on the caller (then results are cached privately). */
  get personal(): boolean {
    return this.ctx.registries !== undefined;
  }

  private builtins(): Promise<CatalogSkill[]> {
    if (this.catalog !== BUILTIN_CATALOG) return builtinSkills(this.catalog);
    builtinCache ??= builtinSkills(this.catalog);
    return builtinCache;
  }

  private registry(accountId: string): SkillRegistryStub | undefined {
    return this.ctx.registries?.getByName(accountId);
  }

  /** Every skill the caller may read: built-ins, then own skills, then shared team skills. */
  async list(): Promise<CatalogSkill[]> {
    const out = [...(await this.builtins())];
    const own = this.registry(this.ctx.userId);
    if (!own) return out;
    const me = this.ctx.userId;
    const mine = await own.listServed(me, me);
    out.push(...mine.map(fromServed).sort((a, b) => (a.uri < b.uri ? -1 : 1)));
    const shared: CatalogSkill[] = [];
    for (const share of await own.shares()) {
      if (share.ownerId === me) continue;
      // Only under the grant the share was accepted with: a revoke ends it for good.
      const served = await this.registry(share.ownerId)?.served(
        share.ownerId,
        me,
        share.name,
        share.grantId,
      );
      if (served && served.skill.visibility === "team") shared.push(fromServed(served));
    }
    out.push(...shared.sort((a, b) => (a.uri < b.uri ? -1 : 1)));
    return out;
  }

  /** The served revision behind a located URI, checked against its namespace. */
  private async servedFor(where: Exclude<Located, { kind: "builtin" }>) {
    const me = this.ctx.userId;
    const ownerId = where.kind === "private" ? me : where.ownerId;
    const served = await this.registry(ownerId)?.served(ownerId, me, where.name);
    const expected = where.kind === "private" ? "private" : "team";
    return served && served.skill.visibility === expected ? { served, ownerId } : null;
  }

  /** The skill whose SKILL.md is at `uri` (skills/get). */
  async get(uri: string): Promise<CatalogSkill> {
    const where = locate(uri);
    if (where.rel !== "SKILL.md" && !where.rel.endsWith("/SKILL.md")) {
      throw new SkillCatalogError("UNKNOWN_SKILL", `${uri} is not the URI of a SKILL.md`);
    }
    if (where.kind === "builtin") {
      const skill = (await this.builtins()).find((s) => s.uri === uri);
      return skill ?? unknownSkill(uri);
    }
    if (where.rel !== "SKILL.md") unknownSkill(uri);
    const found = await this.servedFor(where);
    return found ? fromServed(found.served) : unknownSkill(uri);
  }

  /** One file's bytes (resources/read), re-hashed against its digest. */
  async read(uri: string): Promise<FileContent> {
    const where = locate(uri);
    if (where.rel === "") notFound(uri);
    if (where.kind === "builtin") {
      const file = this.catalog.files.find((f) => f.path === where.rel);
      if (!file) notFound(uri);
      const bytes = new TextEncoder().encode(file.text);
      if (bytes.length !== file.size || (await sha256Digest(bytes)) !== file.digest) {
        throw new SkillCatalogError("CORRUPT", "Built-in skill content does not match its digest");
      }
      return { uri, mimeType: file.mediaType, size: file.size, digest: file.digest, bytes };
    }
    const found = await this.servedFor(where);
    if (!found) notFound(uri);
    let result: Awaited<ReturnType<SkillRegistryStub["readFile"]>>;
    try {
      result = await (this.registry(found.ownerId) as SkillRegistryStub).readFile(
        found.ownerId,
        this.ctx.userId,
        where.name,
        where.rel,
      );
    } catch (error) {
      if (registryRefusal(error) === "corrupt") {
        throw new SkillCatalogError("CORRUPT", "Stored skill content does not match its digest");
      }
      throw error;
    }
    if (!result) notFound(uri);
    const { file, bytes } = result;
    return { uri, mimeType: file.mediaType, size: file.size, digest: file.digest, bytes };
  }

  /** Direct children of a directory inside a skill (resources/directory/read). */
  async readDirectory(uri: string): Promise<ResourceView[]> {
    const where = locate(uri);
    let root: string;
    let files: SkillFile[];
    if (where.kind === "builtin") {
      root = `${SKILL_SCHEME}${this.catalog.root}`;
      files = this.catalog.files;
    } else {
      const found = await this.servedFor(where);
      if (!found) unknownSkill(uri);
      root = fromServed(found.served).root;
      files = found.served.revision.files;
    }
    const prefix = where.rel === "" ? "" : `${where.rel}/`;
    const children = new Map<string, ResourceView>();
    for (const file of files) {
      if (!file.path.startsWith(prefix)) continue;
      const rest = file.path.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      const childUri = `${root}/${prefix}${name}`;
      children.set(
        name,
        slash === -1
          ? { uri: childUri, name, mimeType: file.mediaType, size: file.size }
          : { uri: childUri, name, mimeType: "inode/directory" },
      );
    }
    if (children.size === 0) {
      throw new SkillCatalogError("NOT_DIRECTORY", `${uri} is not a directory resource`);
    }
    return [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }
}

/** A SKILL.md as a resource: named and described by its frontmatter. */
export function skillResource(skill: CatalogSkill): ResourceView {
  const size = skill.files.find((f) => f.path === "SKILL.md")?.size;
  return {
    uri: skill.uri,
    name: skill.frontmatter.name,
    mimeType: "text/markdown",
    description: skill.frontmatter.description,
    ...(size !== undefined ? { size } : {}),
  };
}

/** resources/read contents for a file: text for text types, base64 blob otherwise. */
export function resourceContents(file: FileContent) {
  if (isTextMediaType(file.mimeType)) {
    return { uri: file.uri, mimeType: file.mimeType, text: new TextDecoder().decode(file.bytes) };
  }
  let binary = "";
  for (const byte of file.bytes) binary += String.fromCharCode(byte);
  return { uri: file.uri, mimeType: file.mimeType, blob: btoa(binary) };
}
