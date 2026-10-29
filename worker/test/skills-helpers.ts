/**
 * Helpers for skills tests: in-memory account registries (one AccountSkills
 * object per account over fake Durable Object storage, addressed by the
 * account id like `MULTIX_SKILLS.getByName`) and SKILL.md bytes.
 */

import { AccountSkills } from "../src/skills/account-skills.js";
import { fakeDoStorage } from "./fake-do-storage.js";

export const OWNER = "gh-1001";
export const OTHER = "gh-2002";

/**
 * Call the object the way a Durable Object stub does: a thrown error comes
 * back as a plain Error carrying its name, message and own properties, but
 * not its class.
 */
function overRpc<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        try {
          return await value.apply(obj, args);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          throw Object.assign(new Error(error.message), { ...error, name: error.name });
        }
      };
    },
  });
}

export function fakeRegistries(now: () => number = () => 1_000) {
  const registries = new Map<string, AccountSkills>();
  const data = new Map<string, Map<string, unknown>>();
  return {
    getByName(accountId: string): AccountSkills {
      let registry = registries.get(accountId);
      if (!registry) {
        const fake = fakeDoStorage();
        const ctx = {
          id: { name: accountId },
          storage: fake.storage,
          blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
        };
        registry = overRpc(new AccountSkills(ctx as never, {} as never, now));
        registries.set(accountId, registry);
        data.set(accountId, fake.data);
      }
      return registry;
    },
    /** Raw storage of one account, to tamper with in tests. */
    data(accountId: string): Map<string, unknown> {
      this.getByName(accountId);
      return data.get(accountId) as Map<string, unknown>;
    },
  };
}

const encoder = new TextEncoder();

export function skillFiles(
  name: string,
  description = `The ${name} skill`,
  extra: Record<string, string | Uint8Array> = {},
) {
  const files = [
    {
      path: "SKILL.md",
      bytes: encoder.encode(`---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`),
    },
  ];
  for (const [path, content] of Object.entries(extra)) {
    files.push({ path, bytes: typeof content === "string" ? encoder.encode(content) : content });
  }
  return files;
}
