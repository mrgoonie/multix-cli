/**
 * In-memory MULTIX_EVENT_SUBSCRIPTIONS namespace: one real EventSubscriptions
 * object per name over Map-backed storage, with values cloned like Durable
 * Object storage does.
 */

import {
  EventSubscriptions,
  type EventSubscriptionsNamespace,
  type SubscriptionStorage,
} from "../src/events/event-subscriptions.js";

export function memoryStorage(): SubscriptionStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async get<T>(key: string) {
      const value = data.get(key);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    async put<T>(key: string, value: T) {
      data.set(key, structuredClone(value));
    },
    async delete(key: string) {
      return data.delete(key);
    },
    async list<T>({ prefix }: { prefix: string }) {
      const out = new Map<string, T>();
      for (const [key, value] of [...data].sort(([a], [b]) => a.localeCompare(b))) {
        if (key.startsWith(prefix)) out.set(key, structuredClone(value) as T);
      }
      return out;
    },
  };
}

export function fakeEventSubscriptions(): EventSubscriptionsNamespace & {
  storage(name: string): ReturnType<typeof memoryStorage>;
  names(): string[];
} {
  const objects = new Map<
    string,
    { object: EventSubscriptions; storage: ReturnType<typeof memoryStorage> }
  >();
  const entry = (name: string) => {
    let found = objects.get(name);
    if (!found) {
      const storage = memoryStorage();
      found = { object: new EventSubscriptions({ storage } as never, {} as never), storage };
      objects.set(name, found);
    }
    return found;
  };
  return {
    getByName: (name) => entry(name).object,
    storage: (name) => entry(name).storage,
    names: () => [...objects.keys()],
  };
}
