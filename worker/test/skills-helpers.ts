/**
 * Helpers for skills tests: in-memory account registries (one SkillRegistry
 * per account, like the AccountSkills Durable Objects) and SKILL.md bytes.
 */

import { SkillRegistry } from "../src/skills/skill-registry.js";
import { fakeDoStorage } from "./fake-do-storage.js";

export const OWNER = "gh-1001";
export const OTHER = "gh-2002";

export function fakeRegistries(now: () => number = () => 1_000) {
  const registries = new Map<string, SkillRegistry>();
  const data = new Map<string, Map<string, unknown>>();
  return {
    getByName(accountId: string): SkillRegistry {
      let registry = registries.get(accountId);
      if (!registry) {
        const fake = fakeDoStorage();
        registry = new SkillRegistry(fake.storage, now);
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
