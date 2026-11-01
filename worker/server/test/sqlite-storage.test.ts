import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapTokenValid } from "../../src/accounts/local-auth.js";
import { DurableObjectHost, releaseTurnDuring } from "../durable-object-host.js";
import { type MultixDatabase, SCHEMA_VERSION, openDatabase } from "../sqlite-database.js";
import { SqliteKvNamespace, sweepExpired } from "../sqlite-kv-namespace.js";
import { prepareBootstrap } from "../standalone-bootstrap.js";

const dirs: string[] = [];
const dbs: MultixDatabase[] = [];

function tempDb(): { path: string; db: MultixDatabase } {
  const dir = mkdtempSync(join(tmpdir(), "multix-server-test-"));
  dirs.push(dir);
  const path = join(dir, "data", "multix.sqlite");
  const db = openDatabase(path);
  dbs.push(db);
  return { path, db };
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SqliteKvNamespace", () => {
  it("stores text, json and bytes, and survives reopening the file", async () => {
    const { path, db } = tempDb();
    const kv = new SqliteKvNamespace(db, "ACCOUNTS_KV");
    await kv.put("account:1", JSON.stringify({ id: "1" }));
    await kv.put("bytes", new Uint8Array([1, 2, 3]));
    expect(await kv.get("account:1", { type: "json" })).toEqual({ id: "1" });
    expect(await kv.get("account:1", "text")).toBe('{"id":"1"}');
    expect(new Uint8Array((await kv.get("bytes", "arrayBuffer")) as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    db.close();
    const reopened = openDatabase(path);
    dbs.push(reopened);
    expect(await new SqliteKvNamespace(reopened, "ACCOUNTS_KV").get("account:1", "json")).toEqual({
      id: "1",
    });
  });

  it("keeps namespaces apart", async () => {
    const { db } = tempDb();
    await new SqliteKvNamespace(db, "OAUTH_KV").put("k", "oauth");
    expect(await new SqliteKvNamespace(db, "ACCOUNTS_KV").get("k")).toBeNull();
  });

  it("expires entries by TTL and sweeps them", async () => {
    const { db } = tempDb();
    let now = 1_000_000;
    const kv = new SqliteKvNamespace(db, "OAUTH_KV", () => now);
    await kv.put("t", "v", { expirationTtl: 60, metadata: { a: 1 } });
    expect((await kv.getWithMetadata("t")).metadata).toEqual({ a: 1 });
    now += 60_000;
    expect(await kv.get("t")).toBeNull();
    expect((await kv.list()).keys).toEqual([]);
    expect(sweepExpired(db, now)).toBe(1);
  });

  it("rejects TTLs below the Workers KV minimum", async () => {
    const { db } = tempDb();
    await expect(
      new SqliteKvNamespace(db, "OAUTH_KV").put("t", "v", { expirationTtl: 30 }),
    ).rejects.toThrow(RangeError);
  });

  it("lists by prefix in key order with cursors", async () => {
    const { db } = tempDb();
    const kv = new SqliteKvNamespace(db, "OAUTH_KV");
    for (const k of ["grant:b", "grant:a", "grant:c", "token:a", "grant%x", "grant_y"])
      await kv.put(k, "1");
    const first = await kv.list({ prefix: "grant:", limit: 2 });
    expect(first.keys.map((k) => k.name)).toEqual(["grant:a", "grant:b"]);
    expect(first.list_complete).toBe(false);
    const second = await kv.list({ prefix: "grant:", limit: 2, cursor: first.cursor });
    expect(second.keys.map((k) => k.name)).toEqual(["grant:c"]);
    expect(second.list_complete).toBe(true);
    // LIKE wildcards in a prefix are literal.
    expect((await kv.list({ prefix: "grant%" })).keys.map((k) => k.name)).toEqual(["grant%x"]);
  });

  it("refuses a database written by a newer schema", () => {
    const { path, db } = tempDb();
    db.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer/);
  });
});

class Counter {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: unknown,
  ) {}
  async add(by: number): Promise<number> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const current = ((await this.ctx.storage.get<number>("n")) ?? 0) + by;
      await new Promise((r) => setTimeout(r, 1));
      await this.ctx.storage.put({ n: current });
      return current;
    });
  }
  async read(): Promise<{
    n: number | undefined;
    name: string | undefined;
    map: Map<string, unknown>;
  }> {
    return {
      n: await this.ctx.storage.get<number>("n"),
      name: this.ctx.id.name,
      map: await this.ctx.storage.list({ prefix: "" }),
    };
  }
  async schedule(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(at);
  }
  async alarm(): Promise<void> {
    await this.ctx.storage.put({ fired: ((await this.ctx.storage.get<number>("fired")) ?? 0) + 1 });
  }
  /** Read-then-write with no blockConcurrencyWhile: atomic per turn, as with input gates. */
  async incr(): Promise<number> {
    const n = ((await this.ctx.storage.get<number>("plain")) ?? 0) + 1;
    await new Promise((r) => setTimeout(r, 1));
    await this.ctx.storage.put({ plain: n });
    return n;
  }
  /** A simulated outgoing request; the lock is given up while it is out. */
  async slowFetch(): Promise<number> {
    slow.started = true;
    await releaseTurnDuring(() => slow.response);
    return this.incr();
  }
  /** Parallel simulated requests in one turn take the lock back without deadlock. */
  async parallelFetches(): Promise<number> {
    await Promise.all(
      [3, 1, 2].map((ms) => releaseTurnDuring(() => new Promise((r) => setTimeout(r, ms)))),
    );
    return this.incr();
  }
  async fired(): Promise<number> {
    return (await this.ctx.storage.get<number>("fired")) ?? 0;
  }
}

const log = () => {};
const slow: { started: boolean; response: Promise<void> } = {
  started: false,
  response: Promise.resolve(),
};

describe("DurableObjectHost", () => {
  it("serializes blockConcurrencyWhile writes and persists across restarts", async () => {
    const { path, db } = tempDb();
    const host = new DurableObjectHost(db, () => ({}), log);
    const ns = host.namespace("COUNTER", Counter as never);
    const stub = ns.getByName("acct-1") as unknown as Counter;
    await Promise.all(Array.from({ length: 20 }, () => stub.add(1)));
    expect((await stub.read()).n).toBe(20);
    expect((await stub.read()).name).toBe("acct-1");
    await expect((ns.getByName("acct-2") as unknown as Counter).read()).resolves.toMatchObject({
      n: undefined,
    });
    await host.stop(100);
    db.close();
    const reopened = openDatabase(path);
    dbs.push(reopened);
    const again = new DurableObjectHost(reopened, () => ({}), log)
      .namespace("COUNTER", Counter as never)
      .getByName("acct-1") as unknown as Counter;
    expect((await again.read()).n).toBe(20);
  });

  it("runs each call as one turn, so read-then-write is not lost", async () => {
    const { db } = tempDb();
    const host = new DurableObjectHost(db, () => ({}), log);
    const stub = host.namespace("COUNTER", Counter as never).getByName("a") as unknown as Counter;
    const results = await Promise.all(Array.from({ length: 10 }, () => stub.incr()));
    expect(results.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    await host.stop(100);
  });

  it("lets other calls run while a turn awaits an outgoing request", async () => {
    const { db } = tempDb();
    const host = new DurableObjectHost(db, () => ({}), log);
    const stub = host.namespace("COUNTER", Counter as never).getByName("a") as unknown as Counter;
    let respond!: () => void;
    slow.started = false;
    slow.response = new Promise<void>((r) => {
      respond = r;
    });
    const pending = stub.slowFetch();
    await expect.poll(() => slow.started).toBe(true);
    await expect(stub.incr()).resolves.toBe(1);
    respond();
    await expect(pending).resolves.toBe(2);
    await expect(stub.incr()).resolves.toBe(3);
    const parallel = await Promise.all([
      stub.parallelFetches(),
      stub.incr(),
      stub.parallelFetches(),
    ]);
    expect(parallel.sort((a, b) => a - b)).toEqual([4, 5, 6]);
    await host.stop(100);
  });

  it("does not expose alarm, private or missing members through the stub", () => {
    const { db } = tempDb();
    const stub = new DurableObjectHost(db, () => ({}), log)
      .namespace("COUNTER", Counter as never)
      .getByName("a") as unknown as Record<string, unknown>;
    expect(stub.alarm).toBeUndefined();
    expect(stub.nope).toBeUndefined();
    expect(stub.then).toBeUndefined();
  });

  it("fires an alarm that came due while the process was down", async () => {
    const { db } = tempDb();
    const host = new DurableObjectHost(db, () => ({}), log);
    const stub = host.namespace("COUNTER", Counter as never).getByName("a") as unknown as Counter;
    await stub.schedule(Date.now() + 60_000);
    await host.stop(10);
    db.db.prepare("UPDATE do_alarm SET scheduled_at = ?").run(Date.now() - 1);
    const host2 = new DurableObjectHost(db, () => ({}), log);
    const ns2 = host2.namespace("COUNTER", Counter as never);
    expect(host2.resumeAlarms()).toBe(1);
    const stub2 = ns2.getByName("a") as unknown as Counter;
    await expect.poll(() => stub2.fired(), { timeout: 2000 }).toBe(1);
    expect(db.db.prepare("SELECT COUNT(*) AS n FROM do_alarm").get()).toEqual({ n: 0 });
    await host2.stop(100);
  });
});

describe("prepareBootstrap", () => {
  it("revokes a generated token once MULTIX_BOOTSTRAP_TOKEN is set", async () => {
    const { db } = tempDb();
    const kv = new SqliteKvNamespace(db, "ACCOUNTS_KV") as unknown as KVNamespace;
    const lines: string[] = [];
    const base = {
      ACCOUNTS_KV: kv,
      MULTIX_LOCAL_AUTH: "true",
      MULTIX_PUBLIC_URL: "https://m.example",
    };
    expect(await prepareBootstrap(base as never, (l) => lines.push(l))).toBe("generated");
    const generated = /token[^:]*: (\S+)$/.exec(lines.find((l) => l.includes("token")) ?? "")?.[1];
    expect(generated).toBeTruthy();
    expect(await bootstrapTokenValid({}, kv, generated as string)).toBe(true);
    const configured = "c".repeat(40);
    const withEnv = { ...base, MULTIX_BOOTSTRAP_TOKEN: configured };
    expect(await prepareBootstrap(withEnv as never, () => {})).toBe("env_token");
    expect(await bootstrapTokenValid(withEnv, kv, generated as string)).toBe(false);
    expect(await bootstrapTokenValid(withEnv, kv, configured)).toBe(true);
  });
});
