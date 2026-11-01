/**
 * Runs the Worker's Durable Object classes in this process, one instance per
 * (binding, name), with their storage and alarm in SQLite (`do_storage`,
 * `do_alarm`). It implements what the classes use: `ctx.id.name`,
 * `ctx.storage` get/put/delete/list/getAlarm/setAlarm/deleteAlarm,
 * `ctx.blockConcurrencyWhile`, `ctx.waitUntil` and the `alarm()` handler.
 *
 * Calls through `getByName(name).method(...)` behave like Workers RPC:
 * arguments and results are structured-cloned. Each call and each alarm of
 * one instance runs as a turn that holds the instance's lock, so a
 * read-then-write across `await storage.*` is atomic, as Cloudflare's input
 * gates make it. While a turn awaits an outgoing `fetch()` (see
 * `releaseTurnDuring`) it gives the lock up, again like an input gate, so a
 * slow webhook does not stall other calls; it takes the lock back before it
 * continues. `blockConcurrencyWhile` inside a turn runs directly (the turn
 * already holds the lock); outside one (the constructor) it takes the lock.
 * Storage values are serialized with v8.serialize (the structured clone
 * format Durable Objects also keep).
 *
 * Alarms fire at their time while the process runs and on the next start
 * when they came due while it was down. A failing alarm is retried with
 * exponential backoff (2 s … 64 s, 6 attempts), as on Cloudflare.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { deserialize, serialize } from "node:v8";
import type { MultixDatabase } from "./sqlite-database.js";

const MAX_KEYS_PER_CALL = 128;
const ALARM_RETRIES = 6;
/** setTimeout cannot wait longer than ~24.8 days; re-arm in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

type DurableObjectClass = new (ctx: DurableObjectState, env: unknown) => object;

export type HostLogger = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>,
) => void;

interface ListOptions {
  prefix?: string;
  start?: string;
  startAfter?: string;
  end?: string;
  limit?: number;
  reverse?: boolean;
}

/** A FIFO lock: `acquire()` resolves, in call order, with a release function. */
class Gate {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = this.tail.then(() => release);
    this.tail = this.tail.then(() => released);
    return ready;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** The turn (instance call or alarm) the current async context runs in, if any. */
interface Turn {
  gate: Gate;
  /** Whether the turn holds the lock now (false while every branch awaits a fetch). */
  held: boolean;
  release: () => void;
  reacquiring?: Promise<void>;
  done: boolean;
}

const currentTurn = new AsyncLocalStorage<Turn>();

/** Run `fn` as a turn of `gate`: alone, except while it awaits `releaseTurnDuring`. */
async function runTurn<T>(gate: Gate, fn: () => Promise<T>): Promise<T> {
  const turn: Turn = { gate, held: true, release: await gate.acquire(), done: false };
  try {
    return await currentTurn.run(turn, fn);
  } finally {
    turn.done = true;
    if (turn.held) {
      turn.held = false;
      turn.release();
    }
  }
}

function reacquire(turn: Turn): Promise<void> {
  if (turn.held || turn.done) return Promise.resolve();
  turn.reacquiring ??= turn.gate.acquire().then((release) => {
    turn.reacquiring = undefined;
    if (turn.done) {
      release(); // the turn ended while a detached fetch was still out
      return;
    }
    turn.release = release;
    turn.held = true;
  });
  return turn.reacquiring;
}

/**
 * Await `work` with the current turn's lock given up (no-op outside a turn),
 * then take the lock back. The standalone app wraps the global `fetch` with
 * it, which is what Durable Object input gates do for outgoing requests.
 * Parallel fetches in one turn share the lock: the first to finish takes it
 * back for the turn, and the others continue under it.
 */
export async function releaseTurnDuring<T>(work: () => Promise<T>): Promise<T> {
  const turn = currentTurn.getStore();
  if (!turn) return work();
  if (turn.held) {
    turn.held = false;
    turn.release();
  }
  try {
    return await currentTurn.exit(work);
  } finally {
    await reacquire(turn);
  }
}

class SqliteDurableStorage {
  constructor(
    private readonly store: MultixDatabase,
    private readonly ns: string,
    private readonly id: string,
    private readonly onAlarmChange: (time: number | null) => void,
  ) {}

  async get(keyOrKeys: string | string[]): Promise<unknown> {
    const stmt = this.store.db.prepare(
      "SELECT value FROM do_storage WHERE ns = ? AND id = ? AND key = ?",
    );
    const one = (key: string) => {
      const row = stmt.get(this.ns, this.id, key) as { value: Uint8Array } | undefined;
      return row ? deserialize(row.value) : undefined;
    };
    if (!Array.isArray(keyOrKeys)) return one(keyOrKeys);
    if (keyOrKeys.length > MAX_KEYS_PER_CALL) throw new RangeError("more than 128 keys");
    const out = new Map<string, unknown>();
    for (const key of keyOrKeys) {
      const value = one(key);
      if (value !== undefined) out.set(key, value);
    }
    return out;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    const entries: [string, unknown][] =
      typeof keyOrEntries === "string" ? [[keyOrEntries, value]] : Object.entries(keyOrEntries);
    if (entries.length > MAX_KEYS_PER_CALL) throw new RangeError("more than 128 keys");
    const stmt = this.store.db.prepare(
      `INSERT INTO do_storage (ns, id, key, value) VALUES (?, ?, ?, ?)
       ON CONFLICT(ns, id, key) DO UPDATE SET value = excluded.value`,
    );
    // Serialize first so an uncloneable value fails before anything is written.
    const rows = entries.map(([key, v]) => {
      if (v === undefined) throw new TypeError("Durable Object storage cannot store undefined");
      return [key, serialize(v)] as const;
    });
    this.store.transaction(() => {
      for (const [key, bytes] of rows) stmt.run(this.ns, this.id, key, bytes);
    });
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean | number> {
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
    if (keys.length > MAX_KEYS_PER_CALL) throw new RangeError("more than 128 keys");
    const stmt = this.store.db.prepare(
      "DELETE FROM do_storage WHERE ns = ? AND id = ? AND key = ?",
    );
    const removed = this.store.transaction(() =>
      keys.reduce((n, key) => n + Number(stmt.run(this.ns, this.id, key).changes), 0),
    );
    return Array.isArray(keyOrKeys) ? removed : removed > 0;
  }

  async deleteAll(): Promise<void> {
    this.store.db.prepare("DELETE FROM do_storage WHERE ns = ? AND id = ?").run(this.ns, this.id);
    await this.deleteAlarm();
  }

  async list(options: ListOptions = {}): Promise<Map<string, unknown>> {
    const where = ["ns = ?", "id = ?"];
    const params: (string | number)[] = [this.ns, this.id];
    if (options.prefix) {
      where.push("substr(key, 1, length(?)) = ?");
      params.push(options.prefix, options.prefix);
    }
    if (options.start !== undefined) {
      where.push("key >= ?");
      params.push(options.start);
    }
    if (options.startAfter !== undefined) {
      where.push("key > ?");
      params.push(options.startAfter);
    }
    if (options.end !== undefined) {
      where.push("key < ?");
      params.push(options.end);
    }
    let sql = `SELECT key, value FROM do_storage WHERE ${where.join(" AND ")} ORDER BY key ${options.reverse ? "DESC" : "ASC"}`;
    if (options.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(Math.max(0, Math.floor(options.limit)));
    }
    const rows = this.store.db.prepare(sql).all(...params) as { key: string; value: Uint8Array }[];
    return new Map(rows.map((row) => [row.key, deserialize(row.value)]));
  }

  async getAlarm(): Promise<number | null> {
    const row = this.store.db
      .prepare("SELECT scheduled_at FROM do_alarm WHERE ns = ? AND id = ?")
      .get(this.ns, this.id) as { scheduled_at: number } | undefined;
    return row ? Number(row.scheduled_at) : null;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    const time = typeof scheduledTime === "number" ? scheduledTime : scheduledTime.getTime();
    if (!Number.isFinite(time)) throw new TypeError("alarm time must be a finite number");
    this.store.db
      .prepare(
        `INSERT INTO do_alarm (ns, id, scheduled_at) VALUES (?, ?, ?)
         ON CONFLICT(ns, id) DO UPDATE SET scheduled_at = excluded.scheduled_at`,
      )
      .run(this.ns, this.id, Math.floor(time));
    this.onAlarmChange(Math.floor(time));
  }

  async deleteAlarm(): Promise<void> {
    this.store.db.prepare("DELETE FROM do_alarm WHERE ns = ? AND id = ?").run(this.ns, this.id);
    this.onAlarmChange(null);
  }

  /** Remove the alarm row that just fired, unless the handler path already replaced it. */
  clearFiredAlarm(time: number): void {
    this.store.db
      .prepare("DELETE FROM do_alarm WHERE ns = ? AND id = ? AND scheduled_at = ?")
      .run(this.ns, this.id, time);
  }
}

interface Instance {
  object: Record<string, unknown> & { alarm?: () => Promise<void> };
  gate: Gate;
  storage: SqliteDurableStorage;
  timer?: NodeJS.Timeout;
  alarmAttempts: number;
}

export class DurableObjectHost {
  private readonly namespaces = new Map<string, DurableObjectNamespaceShim>();
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly store: MultixDatabase,
    private readonly env: () => unknown,
    private readonly log: HostLogger,
    private readonly now: () => number = Date.now,
  ) {}

  namespace(binding: string, cls: DurableObjectClass): DurableObjectNamespaceShim {
    let ns = this.namespaces.get(binding);
    if (!ns) {
      ns = new DurableObjectNamespaceShim(this, binding, cls);
      this.namespaces.set(binding, ns);
    }
    return ns;
  }

  /** Re-arm every stored alarm (alarms that came due while stopped fire now). */
  resumeAlarms(): number {
    const rows = this.store.db.prepare("SELECT ns, id, scheduled_at FROM do_alarm").all() as {
      ns: string;
      id: string;
      scheduled_at: number;
    }[];
    let armed = 0;
    for (const row of rows) {
      const ns = this.namespaces.get(row.ns);
      if (!ns) continue;
      ns.instance(row.id);
      ns.arm(row.id, Number(row.scheduled_at));
      armed++;
    }
    return armed;
  }

  /** @internal */
  storageFor(ns: DurableObjectNamespaceShim, id: string): SqliteDurableStorage {
    return new SqliteDurableStorage(this.store, ns.binding, id, (time) => ns.arm(id, time));
  }

  /** @internal Track background work so shutdown can wait for it. */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get envValue(): unknown {
    return this.env();
  }

  get clock(): () => number {
    return this.now;
  }

  get logger(): HostLogger {
    return this.log;
  }

  /** Stop firing alarms and wait (up to `timeoutMs`) for running calls and alarms. */
  async stop(timeoutMs: number): Promise<void> {
    this.stopped = true;
    for (const ns of this.namespaces.values()) ns.clearTimers();
    const all = Promise.allSettled([...this.pending]);
    await Promise.race([all, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }
}

export class DurableObjectNamespaceShim {
  private readonly instances = new Map<string, Instance>();

  constructor(
    private readonly host: DurableObjectHost,
    readonly binding: string,
    private readonly cls: DurableObjectClass,
  ) {}

  /** @internal */
  instance(name: string): Instance {
    let inst = this.instances.get(name);
    if (inst) return inst;
    const gate = new Gate();
    const storage = this.host.storageFor(this, name);
    const ctx = {
      id: {
        name,
        toString: () => name,
        equals: (other: { name?: string }) => other?.name === name,
      },
      storage,
      blockConcurrencyWhile: <T>(fn: () => Promise<T>) =>
        currentTurn.getStore()?.gate === gate ? fn() : gate.run(fn),
      waitUntil: (promise: Promise<unknown>) => {
        this.host.track(Promise.resolve(promise)).catch(() => undefined);
      },
    } as unknown as DurableObjectState;
    const object = new this.cls(ctx, this.host.envValue) as Instance["object"];
    inst = { object, gate, storage, alarmAttempts: 0 };
    this.instances.set(name, inst);
    return inst;
  }

  /** An RPC-style stub: every method call is cloned in and out and runs as a turn. */
  getByName(name: string): never {
    if (typeof name !== "string" || name.length === 0)
      throw new TypeError("Durable Object name must be a non-empty string");
    const inst = this.instance(name);
    const host = this.host;
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") return undefined; // the stub is not a thenable
          if (typeof prop !== "string") return undefined;
          const member = inst.object[prop];
          if (
            typeof member !== "function" ||
            prop === "constructor" ||
            prop === "alarm" ||
            prop.startsWith("_")
          ) {
            return undefined;
          }
          return (...args: unknown[]) =>
            host.track(
              (async () => {
                const input = structuredClone(args);
                const result = await runTurn(inst.gate, async () =>
                  (member as (...a: unknown[]) => unknown).apply(inst.object, input),
                );
                return result === undefined ? undefined : structuredClone(result);
              })(),
            );
        },
      },
    ) as never;
  }

  idFromName(name: string): { name: string; toString(): string } {
    return { name, toString: () => name };
  }

  get(id: { name?: string }): never {
    if (!id?.name) throw new TypeError("Only ids from idFromName are supported");
    return this.getByName(id.name);
  }

  /** @internal Arm (or clear) the in-process timer for `name`'s stored alarm. */
  arm(name: string, time: number | null): void {
    const inst = this.instances.get(name) ?? (time === null ? undefined : this.instance(name));
    if (!inst) return;
    if (inst.timer) clearTimeout(inst.timer);
    inst.timer = undefined;
    if (time === null || this.host.isStopped) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, time - this.host.clock()));
    inst.timer = setTimeout(() => {
      inst.timer = undefined;
      if (time - this.host.clock() > 0) {
        this.arm(name, time); // a long wait re-armed in steps
        return;
      }
      void this.host.track(this.fire(name, inst, time));
    }, delay);
    inst.timer.unref();
  }

  private async fire(name: string, inst: Instance, time: number): Promise<void> {
    if (this.host.isStopped) return;
    // Like Cloudflare: the alarm is cleared before the handler runs; the handler may set a new one.
    const current = await inst.storage.getAlarm();
    if (current !== time) return;
    inst.storage.clearFiredAlarm(time);
    if (typeof inst.object.alarm !== "function") return;
    try {
      const alarm = inst.object.alarm as () => Promise<void>;
      await runTurn(inst.gate, () => alarm.call(inst.object));
      inst.alarmAttempts = 0;
    } catch (error) {
      inst.alarmAttempts++;
      const retry = inst.alarmAttempts <= ALARM_RETRIES;
      this.host.logger("warn", "durable_object_alarm_failed", {
        binding: this.binding,
        attempt: inst.alarmAttempts,
        retry,
        error: error instanceof Error ? error.name : "unknown",
      });
      if (retry && (await inst.storage.getAlarm()) === null) {
        await inst.storage.setAlarm(this.host.clock() + 1000 * 2 ** inst.alarmAttempts);
      } else if (!retry) {
        inst.alarmAttempts = 0;
      }
    }
  }

  /** @internal */
  clearTimers(): void {
    for (const inst of this.instances.values()) {
      if (inst.timer) clearTimeout(inst.timer);
      inst.timer = undefined;
    }
  }
}
