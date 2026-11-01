/**
 * The subset of Cloudflare's KVNamespace that the Worker and
 * workers-oauth-provider use, on the SQLite `kv` table: get (text, json,
 * arrayBuffer), getWithMetadata, put (expirationTtl / expiration, metadata),
 * delete and prefix list with cursors. Unlike Workers KV it is strongly
 * consistent, which only removes the propagation delays the Worker tolerates.
 *
 * Expired rows are invisible at once and swept by `sweepExpired`.
 */

import type { MultixDatabase } from "./sqlite-database.js";

/** Workers KV refuses TTLs below 60 s; keep the same floor so behaviour matches. */
const MIN_TTL_SECONDS = 60;
const MAX_LIST_LIMIT = 1000;
const MAX_KEY_BYTES = 512;
const MAX_VALUE_BYTES = 25 * 1024 * 1024;

type GetType = "text" | "json" | "arrayBuffer";

interface Row {
  value: Uint8Array;
  expires_at: number | null;
  metadata: string | null;
}

function typeOf(options: unknown): GetType {
  const type =
    typeof options === "string" ? options : (options as { type?: string } | undefined)?.type;
  if (type === undefined || type === "text") return "text";
  if (type === "json" || type === "arrayBuffer") return type;
  throw new TypeError(`Unsupported KV get type: ${type}`);
}

function checkKey(key: string): void {
  if (typeof key !== "string" || key.length === 0)
    throw new TypeError("KV key must be a non-empty string");
  if (Buffer.byteLength(key) > MAX_KEY_BYTES)
    throw new RangeError("KV key is longer than 512 bytes");
}

async function toBytes(value: unknown): Promise<Uint8Array> {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ReadableStream)
    return new Uint8Array(await new Response(value).arrayBuffer());
  throw new TypeError("KV value must be a string, ArrayBuffer, ArrayBufferView or ReadableStream");
}

function decode(row: Row, type: GetType): unknown {
  if (type === "arrayBuffer") return row.value.slice().buffer;
  const text = new TextDecoder().decode(row.value);
  return type === "json" ? JSON.parse(text) : text;
}

export class SqliteKvNamespace {
  constructor(
    private readonly store: MultixDatabase,
    private readonly ns: string,
    private readonly now: () => number = Date.now,
  ) {}

  private row(key: string): Row | undefined {
    const row = this.store.db
      .prepare("SELECT value, expires_at, metadata FROM kv WHERE ns = ? AND key = ?")
      .get(this.ns, key) as Row | undefined;
    if (!row) return undefined;
    if (row.expires_at !== null && row.expires_at <= this.now()) return undefined;
    return row;
  }

  async get(key: string, options?: unknown): Promise<unknown> {
    checkKey(key);
    const type = typeOf(options);
    const row = this.row(key);
    return row ? decode(row, type) : null;
  }

  async getWithMetadata(
    key: string,
    options?: unknown,
  ): Promise<{ value: unknown; metadata: unknown; cacheStatus: null }> {
    checkKey(key);
    const type = typeOf(options);
    const row = this.row(key);
    if (!row) return { value: null, metadata: null, cacheStatus: null };
    return {
      value: decode(row, type),
      metadata: row.metadata === null ? null : JSON.parse(row.metadata),
      cacheStatus: null,
    };
  }

  async put(
    key: string,
    value: unknown,
    options: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {},
  ): Promise<void> {
    checkKey(key);
    const bytes = await toBytes(value);
    if (bytes.byteLength > MAX_VALUE_BYTES) throw new RangeError("KV value is larger than 25 MiB");
    let expiresAt: number | null = null;
    if (options.expirationTtl !== undefined) {
      const ttl = Number(options.expirationTtl);
      if (!Number.isFinite(ttl) || ttl < MIN_TTL_SECONDS) {
        throw new RangeError(`KV expirationTtl must be at least ${MIN_TTL_SECONDS} seconds`);
      }
      expiresAt = this.now() + Math.floor(ttl) * 1000;
    } else if (options.expiration !== undefined) {
      const at = Number(options.expiration) * 1000;
      if (!Number.isFinite(at) || at < this.now() + MIN_TTL_SECONDS * 1000) {
        throw new RangeError(
          `KV expiration must be at least ${MIN_TTL_SECONDS} seconds in the future`,
        );
      }
      expiresAt = Math.floor(at);
    }
    const metadata = options.metadata === undefined ? null : JSON.stringify(options.metadata);
    this.store.db
      .prepare(
        `INSERT INTO kv (ns, key, value, expires_at, metadata) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(ns, key) DO UPDATE SET value = excluded.value,
           expires_at = excluded.expires_at, metadata = excluded.metadata`,
      )
      .run(this.ns, key, bytes, expiresAt, metadata);
  }

  async delete(key: string): Promise<void> {
    checkKey(key);
    this.store.db.prepare("DELETE FROM kv WHERE ns = ? AND key = ?").run(this.ns, key);
  }

  /** Keys in byte order after an opaque cursor (the last key of the previous page). */
  async list(options: { prefix?: string | null; cursor?: string | null; limit?: number } = {}) {
    const prefix = options.prefix ?? "";
    const limit = Math.max(
      1,
      Math.min(MAX_LIST_LIMIT, Math.floor(options.limit ?? MAX_LIST_LIMIT)),
    );
    const after = options.cursor ? Buffer.from(options.cursor, "base64url").toString("utf8") : null;
    const rows = this.store.db
      .prepare(
        `SELECT key, expires_at, metadata FROM kv
         WHERE ns = ? AND substr(key, 1, length(?)) = ? AND (? IS NULL OR key > ?)
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY key LIMIT ?`,
      )
      .all(this.ns, prefix, prefix, after, after, this.now(), limit + 1) as {
      key: string;
      expires_at: number | null;
      metadata: string | null;
    }[];
    const page = rows.slice(0, limit);
    const complete = rows.length <= limit;
    const last = page.at(-1)?.key;
    return {
      keys: page.map((row) => ({
        name: row.key,
        ...(row.expires_at !== null ? { expiration: Math.floor(row.expires_at / 1000) } : {}),
        ...(row.metadata !== null ? { metadata: JSON.parse(row.metadata) } : {}),
      })),
      list_complete: complete,
      ...(complete || last === undefined
        ? {}
        : { cursor: Buffer.from(last, "utf8").toString("base64url") }),
      cacheStatus: null,
    };
  }
}

/** Delete expired rows of every namespace; returns how many were removed. */
export function sweepExpired(store: MultixDatabase, now = Date.now()): number {
  const result = store.db
    .prepare("DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?")
    .run(now);
  return Number(result.changes);
}
