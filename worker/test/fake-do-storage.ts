/**
 * In-memory stand-in for Durable Object storage as the event hub uses it:
 * get/put/delete, ordered `list` with prefix, start, end, limit and reverse,
 * and one alarm. Values are cloned like the real storage does.
 */

import type { HubStorage } from "../src/events/event-hub.js";

export function fakeDoStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage: HubStorage = {
    get: async <T>(key: string) => structuredClone(data.get(key)) as T | undefined,
    put: async (entries) => {
      for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value));
    },
    delete: async (keys) => {
      let n = 0;
      for (const key of keys) if (data.delete(key)) n++;
      return n;
    },
    list: async <T>(options: {
      prefix: string;
      start?: string;
      end?: string;
      limit?: number;
      reverse?: boolean;
    }) => {
      let keys = [...data.keys()]
        .filter((k) => k.startsWith(options.prefix))
        .filter((k) => options.start === undefined || k >= options.start)
        .filter((k) => options.end === undefined || k < options.end)
        .sort();
      if (options.reverse) keys.reverse();
      if (options.limit !== undefined) keys = keys.slice(0, options.limit);
      return new Map(keys.map((k) => [k, structuredClone(data.get(k)) as T]));
    },
    getAlarm: async () => alarm,
    setAlarm: async (time) => {
      alarm = time;
    },
  };
  return {
    storage,
    data,
    alarm: () => alarm,
    clearAlarm: () => {
      alarm = null;
    },
  };
}
