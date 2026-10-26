/**
 * Account activity log: sign-ins, client grants, key and storage changes,
 * budget changes, blocks and alerts, imports, exports, deletions. Each row
 * carries the SHA-256 of the previous row's hash and its own content, so an
 * edited or removed row in the middle breaks the chain and `verify` reports
 * where. Pruning old rows keeps the chain valid: the oldest kept row's
 * `prev_hash` is the anchor.
 */

import { sha256Hex } from "./sha256-sync.js";
import { type SqlPort, type SqlRow, v } from "./sql-port.js";
import type { Activity, ActivityInput } from "./usage-types.js";

const GENESIS = "genesis";
const MAX_META_KEYS = 20;
const MAX_TEXT = 200;
export const MAX_ACTIVITY_PAGE = 100;

interface ActivityRow extends SqlRow {
  seq: number;
  ts: number;
  actor: string;
  kind: string;
  target: string | null;
  meta_json: string;
  prev_hash: string;
  hash: string;
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Keep only scalar metadata, short strings, at most MAX_META_KEYS keys. */
export function safeMeta(
  meta: ActivityInput["meta"] = {},
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(meta).slice(0, MAX_META_KEYS)) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(key)) continue;
    if (typeof value === "string") out[key] = clip(value);
    else if (typeof value === "number") out[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === "boolean" || value === null) out[key] = value;
  }
  return out;
}

function rowHash(prev: string, row: Omit<ActivityRow, "seq" | "prev_hash" | "hash">): string {
  return sha256Hex(
    `${prev}\n${JSON.stringify([row.ts, row.actor, row.kind, row.target, row.meta_json])}`,
  );
}

function toActivity(row: ActivityRow): Activity {
  return {
    seq: row.seq,
    ts: row.ts,
    actor: row.actor,
    kind: row.kind,
    target: row.target,
    meta: JSON.parse(row.meta_json) as Activity["meta"],
    hash: row.hash,
  };
}

export interface ActivityQuery {
  /** Exact kind, or a prefix ending in `.` such as `budget.`. */
  kind?: string;
  q?: string;
  from?: number;
  to?: number;
  /** Return rows with a smaller `seq` (next page). */
  before?: number;
  limit?: number;
}

export class ActivityLog {
  constructor(
    private readonly sql: SqlPort,
    private readonly now: () => number,
  ) {}

  /** Append one entry; callers already inside a transaction keep it atomic with their write. */
  record(input: ActivityInput): Activity {
    const last = this.sql.exec<{ hash: string }>(
      "SELECT hash FROM activities ORDER BY seq DESC LIMIT 1",
    )[0];
    const prev = last?.hash ?? GENESIS;
    const row = {
      ts: this.now(),
      actor: clip(input.actor),
      kind: clip(input.kind),
      target: input.target === undefined ? null : clip(input.target),
      meta_json: JSON.stringify(safeMeta(input.meta)),
    };
    const hash = rowHash(prev, row);
    const inserted = this.sql.exec<{ seq: number }>(
      "INSERT INTO activities (ts, actor, kind, target, meta_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq",
      row.ts,
      row.actor,
      row.kind,
      row.target,
      row.meta_json,
      prev,
      hash,
    );
    return toActivity({ ...row, seq: Number(inserted[0]?.seq), prev_hash: prev, hash });
  }

  list(query: ActivityQuery = {}): { items: Activity[]; next: number | null } {
    const where: string[] = [];
    const params: (string | number | null)[] = [];
    if (query.kind) {
      if (query.kind.endsWith(".")) {
        where.push("substr(kind, 1, ?) = ?");
        params.push(query.kind.length, query.kind);
      } else {
        where.push("kind = ?");
        params.push(query.kind);
      }
    }
    if (query.q) {
      where.push(
        "(instr(kind, ?) > 0 OR instr(actor, ?) > 0 OR instr(coalesce(target, ''), ?) > 0 OR instr(meta_json, ?) > 0)",
      );
      params.push(query.q, query.q, query.q, query.q);
    }
    if (query.from !== undefined) {
      where.push("ts >= ?");
      params.push(query.from);
    }
    if (query.to !== undefined) {
      where.push("ts < ?");
      params.push(query.to);
    }
    if (query.before !== undefined) {
      where.push("seq < ?");
      params.push(query.before);
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), MAX_ACTIVITY_PAGE);
    const rows = this.sql.exec<ActivityRow>(
      `SELECT * FROM activities ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`,
      ...params,
      limit + 1,
    );
    const items = rows.slice(0, limit).map(toActivity);
    return { items, next: rows.length > limit ? (items[items.length - 1]?.seq ?? null) : null };
  }

  /** Recompute the chain from the oldest kept row. */
  verify(): { ok: boolean; checked: number; brokenAtSeq: number | null } {
    let prev: string | undefined;
    let checked = 0;
    let after = 0;
    for (;;) {
      const rows = this.sql.exec<ActivityRow>(
        "SELECT * FROM activities WHERE seq > ? ORDER BY seq LIMIT 500",
        after,
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        if (prev !== undefined && row.prev_hash !== prev) {
          return { ok: false, checked, brokenAtSeq: row.seq };
        }
        if (rowHash(row.prev_hash, row) !== row.hash) {
          return { ok: false, checked, brokenAtSeq: row.seq };
        }
        prev = row.hash;
        checked++;
        after = row.seq;
      }
    }
    return { ok: true, checked, brokenAtSeq: null };
  }

  prune(before: number): void {
    this.sql.exec("DELETE FROM activities WHERE ts < ?", v(before));
  }
}
