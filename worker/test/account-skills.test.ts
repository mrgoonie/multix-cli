import { describe, expect, it } from "vitest";
import { AccountSkills } from "../src/skills/account-skills.js";
import { fakeDoStorage } from "./fake-do-storage.js";
import { OTHER, OWNER, skillFiles } from "./skills-helpers.js";

function accountSkills(name: string | undefined) {
  let calls = 0;
  const ctx = {
    id: { name },
    storage: fakeDoStorage().storage,
    async blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      calls++;
      return await fn();
    },
  };
  const object = new AccountSkills(ctx as never, {} as never);
  return { object, calls: () => calls };
}

describe("AccountSkills", () => {
  it("refuses calls that name another owner than the addressed account", async () => {
    const { object } = accountSkills(OWNER);
    await expect(
      object.publish({ ownerId: OTHER, visibility: "private", files: skillFiles("a") }),
    ).rejects.toThrow(/owner/);
    await expect(object.listServed(OTHER, OTHER)).rejects.toThrow(/owner/);
    await expect(object.served(OTHER, OTHER, "a")).rejects.toThrow(/owner/);
    await expect(object.readFile(OTHER, OTHER, "a", "SKILL.md")).rejects.toThrow(/owner/);
  });

  it("publishes through blockConcurrencyWhile and serves the owner's skills", async () => {
    const { object, calls } = accountSkills(OWNER);
    await object.publish({ ownerId: OWNER, visibility: "private", files: skillFiles("a") });
    const second = await object.publish({
      ownerId: OWNER,
      visibility: "private",
      files: skillFiles("a", "changed"),
    });
    expect(second.revision.revision).toBe(2);
    expect(calls()).toBe(2);
    expect((await object.listServed(OWNER, OWNER)).map((s) => s.skill.name)).toEqual(["a"]);
  });
});
