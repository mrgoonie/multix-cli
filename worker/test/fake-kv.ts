/**
 * In-memory KVNamespace for tests: get (text/json), put (with expirationTtl
 * and metadata), delete and prefix list with cursors. Strongly consistent,
 * unlike real KV.
 */

interface Entry {
  value: string;
  expiresAt?: number;
  metadata?: unknown;
}

export function fakeKv(): KVNamespace & { dump(): Map<string, Entry> } {
  const store = new Map<string, Entry>();
  const live = (key: string): Entry | undefined => {
    const entry = store.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  };
  const kv = {
    async get(key: string, options?: unknown) {
      const entry = live(key);
      if (!entry) return null;
      const type = typeof options === "string" ? options : (options as { type?: string })?.type;
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number; expiration?: number; metadata?: unknown },
    ) {
      const expiresAt = options?.expirationTtl
        ? Date.now() + options.expirationTtl * 1000
        : options?.expiration
          ? options.expiration * 1000
          : undefined;
      store.set(key, { value, expiresAt, metadata: options?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const names = [...store.keys()]
        .filter((k) => live(k) && k.startsWith(options.prefix ?? ""))
        .sort();
      const start = options.cursor ? Number(options.cursor) : 0;
      const limit = options.limit ?? 1000;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return {
        keys: page.map((name) => ({
          name,
          expiration: store.get(name)?.expiresAt
            ? Math.floor((store.get(name)?.expiresAt ?? 0) / 1000)
            : undefined,
          metadata: store.get(name)?.metadata,
        })),
        list_complete: done,
        cursor: done ? undefined : String(start + limit),
        cacheStatus: null,
      };
    },
    dump: () => store,
  };
  return kv as unknown as KVNamespace & { dump(): Map<string, Entry> };
}
