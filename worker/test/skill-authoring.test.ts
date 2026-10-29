import { describe, expect, it } from "vitest";
import { SkillCatalog, SkillCatalogError } from "../src/skills/skill-catalog.js";
import { MAX_PATCH_BYTES, SkillManager, decodeFiles } from "../src/skills/skill-manager.js";
import { registryRefusal } from "../src/skills/skill-registry.js";
import { MAX_REVISIONS_PER_SKILL } from "../src/skills/skill-types.js";
import { callTool, fullEnv } from "./helpers.js";
import { OTHER, OWNER, fakeRegistries } from "./skills-helpers.js";

const THIRD = "gh-3003";
const skillMd = (name: string, description = `The ${name} skill`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;

function setup() {
  const registries = fakeRegistries();
  const as = (userId: string) => new SkillManager({ userId, registries });
  return { registries, owner: as(OWNER), other: as(OTHER), third: as(THIRD) };
}

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const reason = registryRefusal(error);
    if (reason) return reason;
    throw error;
  }
  throw new Error("expected a SkillRegistryError");
}

const blobKeys = (data: Map<string, unknown>) =>
  [...data.keys()].filter((k) => k.startsWith("blob:")).sort();

describe("skill drafts", () => {
  it("creates, patches and publishes a draft as the next revision", async () => {
    const { owner } = setup();
    const created = await owner.saveDraft("brand-voice", {
      files: [{ path: "SKILL.md", text: skillMd("brand-voice") }],
    });
    expect(created.draft).toMatchObject({ name: "brand-voice", base_revision: null });
    const patched = await owner.saveDraft("brand-voice", {
      files: [
        { path: "refs/tone.md", text: "warm" },
        { path: "logo.png", base64: "iVBORw==" },
      ],
      expected_digest: created.draft.digest,
    });
    expect(patched.draft.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "logo.png",
      "refs/tone.md",
    ]);
    expect(await owner.readFile("brand-voice", "draft", "logo.png")).toMatchObject({
      media_type: "image/png",
      base64: "iVBORw==",
    });

    // A stale digest is a conflict, not an overwrite.
    expect(
      await reason(
        owner.saveDraft("brand-voice", {
          delete: ["logo.png"],
          expected_digest: created.draft.digest,
        }),
      ),
    ).toBe("conflict");

    const published = await owner.publishDraft("brand-voice", {
      expected_digest: patched.draft.digest,
      expected_revision: null,
      tags: ["writing"],
    });
    expect(published.revision).toMatchObject({ revision: 1, files: 3 });
    expect(published.skill).toMatchObject({
      uri: "skill://private/brand-voice/SKILL.md",
      current_revision: 1,
      tags: ["writing"],
    });
    expect(await reason(owner.draft("brand-voice"))).toBe("not_found");

    // The next draft starts from the served revision.
    const next = await owner.saveDraft("brand-voice", { delete: ["logo.png"] });
    expect(next.draft).toMatchObject({ base_revision: 1 });
    expect(next.draft.files.map((f) => f.path)).toEqual(["SKILL.md", "refs/tone.md"]);
    // A publish that expects another served revision is refused.
    expect(await reason(owner.publishDraft("brand-voice", { expected_revision: 7 }))).toBe(
      "conflict",
    );
    expect((await owner.publishDraft("brand-voice", {})).revision.revision).toBe(2);
  });

  it("refuses a draft whose SKILL.md names another skill, and bad file sets", async () => {
    const { owner } = setup();
    await owner.saveDraft("one", { files: [{ path: "SKILL.md", text: skillMd("two") }] });
    expect(await reason(owner.publishDraft("one", {}))).toBe("invalid");
    expect(await reason(owner.saveDraft("one", { delete: ["SKILL.md"] }))).toBe("invalid");
    expect(await reason(owner.saveDraft("one", { delete: ["missing.md"] }))).toBe("invalid");
    expect(await reason(owner.saveDraft("one", { files: [{ path: "../x.md", text: "x" }] }))).toBe(
      "invalid",
    );
    expect(await reason(owner.saveDraft("one", { files: [{ path: "run.exe", text: "x" }] }))).toBe(
      "invalid",
    );
    expect(await reason(owner.saveDraft("one", { files: [{ path: "a.md", base64: "ÿþ" }] }))).toBe(
      "invalid",
    );
    expect(await reason(owner.saveDraft("Bad_Name", { files: [] }))).toBe("invalid");
    // A first draft must bring SKILL.md.
    expect(await reason(owner.saveDraft("new", { files: [{ path: "a.md", text: "a" }] }))).toBe(
      "invalid",
    );
  });

  it("checks file patches before decoding", () => {
    expect(() => decodeFiles([{ path: "a.md", text: "a", base64: "YQ==" }])).toThrow(/exactly one/);
    expect(() => decodeFiles([{ path: "a.md", base64: "not base64!" }])).toThrow(/base64/);
    const big = "x".repeat(MAX_PATCH_BYTES / 2 + 1);
    expect(() =>
      decodeFiles([
        { path: "a.md", text: big },
        { path: "b.md", text: big },
      ]),
    ).toThrow(/at most/);
  });

  it("discards drafts and collects their blobs", async () => {
    const { owner, registries } = setup();
    const data = registries.data(OWNER);
    const saved = await owner.saveDraft("tmp", {
      files: [
        { path: "SKILL.md", text: skillMd("tmp") },
        { path: "a.md", text: "only in the draft" },
      ],
    });
    expect(blobKeys(data)).toHaveLength(2);
    // Replacing a file drops the blob nothing else holds.
    await owner.saveDraft("tmp", { files: [{ path: "a.md", text: "second" }] });
    expect(blobKeys(data)).toHaveLength(2);
    expect(await reason(owner.discardDraft("tmp", saved.draft.digest))).toBe("conflict");
    expect(await owner.discardDraft("tmp")).toEqual({ discarded: true });
    expect([...data.keys()]).toEqual([]);
  });
});

describe("skill revisions", () => {
  async function published(owner: SkillManager, ...texts: string[]) {
    for (const text of texts) {
      await owner.saveDraft("notes", {
        files: [
          { path: "SKILL.md", text: skillMd("notes") },
          { path: "body.md", text },
        ],
        replace: true,
      });
      await owner.publishDraft("notes", {});
    }
  }

  it("rolls back, unpublishes and never reuses a revision number", async () => {
    const { owner, registries } = setup();
    await published(owner, "one", "two", "three");
    expect((await owner.revisions("notes")).revisions.map((r) => r.revision)).toEqual([1, 2, 3]);

    expect((await owner.setCurrent("notes", 1, 3)).skill.current_revision).toBe(1);
    expect(await reason(owner.setCurrent("notes", 2, 3))).toBe("conflict");
    const catalog = new SkillCatalog({ userId: OWNER, registries });
    expect(
      new TextDecoder().decode((await catalog.read("skill://private/notes/body.md")).bytes),
    ).toBe("one");

    expect(await reason(owner.deleteRevision("notes", 1))).toBe("invalid");
    await owner.deleteRevision("notes", 3);
    await published(owner, "four");
    expect((await owner.revisions("notes")).revisions.map((r) => r.revision)).toEqual([1, 2, 4]);
    expect(await reason(owner.revision("notes", 3))).toBe("not_found");
    expect(await owner.readFile("notes", 2, "body.md")).toMatchObject({ text: "two" });

    await owner.unpublish("notes", 4);
    await expect(catalog.get("skill://private/notes/SKILL.md")).rejects.toBeInstanceOf(
      SkillCatalogError,
    );
    expect((await owner.get("notes")).skill?.current_revision).toBeNull();
  });

  it("keeps at most the revision limit", async () => {
    const { owner, registries } = setup();
    await published(owner, "one");
    const data = registries.data(OWNER);
    const first = data.get("rev:notes:000001");
    for (let i = 2; i <= MAX_REVISIONS_PER_SKILL; i++) {
      data.set(`rev:notes:${String(i).padStart(6, "0")}`, { ...(first as object), revision: i });
    }
    expect(await reason(published(owner, "too many"))).toBe("invalid");
  });

  it("refuses to publish a draft over a revision served after the draft started", async () => {
    const { owner } = setup();
    await published(owner, "one", "two");
    await owner.saveDraft("notes", { files: [{ path: "body.md", text: "three" }] });
    await owner.setCurrent("notes", 1);
    expect(await reason(owner.publishDraft("notes", {}))).toBe("conflict");
    const forced = await owner.publishDraft("notes", { expected_revision: 1 });
    expect(forced.revision.revision).toBe(3);
  });

  it("refuses capabilities that are not task ids", async () => {
    const { owner } = setup();
    await published(owner, "one");
    expect(await reason(owner.update("notes", { capabilities: ["mind-reading"] }))).toBe("invalid");
    expect((await owner.update("notes", { capabilities: ["image", "any"] })).skill).toMatchObject({
      capabilities: ["image", "any"],
    });
  });

  it("finishes a delete that was cut short when it is retried", async () => {
    const { owner, registries } = setup();
    const data = registries.data(OWNER);
    await published(owner, "one", "two");
    const realDelete = data.delete.bind(data);
    let cut = false;
    data.delete = (key: string) => {
      if (!cut && key.startsWith("rev:")) {
        cut = true;
        throw new Error("storage went away");
      }
      return realDelete(key);
    };
    await expect(owner.delete("notes")).rejects.toThrow("storage went away");
    // The record survives, no longer served, so the retry can finish the job.
    expect((await owner.get("notes")).skill).toMatchObject({ current_revision: null });
    expect(await owner.delete("notes")).toMatchObject({ deleted: true });
    expect([...data.keys()].filter((k) => k.includes("notes"))).toEqual([]);
    expect(blobKeys(data)).toEqual([]);
  });

  it("deletes a skill with its revisions, draft and grants, keeping shared blobs", async () => {
    const { owner, registries } = setup();
    const data = registries.data(OWNER);
    await published(owner, "same body");
    await owner.saveDraft("keeper", {
      files: [
        { path: "SKILL.md", text: skillMd("keeper") },
        { path: "body.md", text: "same body" },
      ],
    });
    await owner.publishDraft("keeper", {});
    await owner.saveDraft("notes", { files: [{ path: "extra.md", text: "draft only" }] });
    await owner.update("notes", { visibility: "team" });
    await owner.grant("notes", OTHER);

    expect(await owner.delete("notes")).toEqual({
      deleted: true,
      name: "notes",
      revoked_grants: [OTHER],
    });
    const keys = [...data.keys()];
    expect(keys.filter((k) => k.includes("notes"))).toEqual([]);
    // "same body" is still held by keeper; its blob stays, the draft-only one is gone.
    expect(blobKeys(data)).toHaveLength(2);
    const catalog = new SkillCatalog({ userId: OWNER, registries });
    expect(
      new TextDecoder().decode((await catalog.read("skill://private/keeper/body.md")).bytes),
    ).toBe("same body");
  });
});

describe("skill sharing", () => {
  async function teamSkill(owner: SkillManager) {
    await owner.saveDraft("style", { files: [{ path: "SKILL.md", text: skillMd("style") }] });
    await owner.publishDraft("style", { visibility: "team" });
  }
  const URI = `skill://team/${OWNER}/style/SKILL.md`;
  const listed = async (registries: ReturnType<typeof fakeRegistries>, userId: string) =>
    (await new SkillCatalog({ userId, registries }).list()).map((s) => s.uri);

  it("lists a shared skill only after the grantee adds it", async () => {
    const { owner, other, registries } = setup();
    await teamSkill(owner);
    const granted = await owner.grant("style", OTHER);
    expect(granted.uri).toBe(URI);
    // A grant alone pushes nothing into the grantee's list.
    expect(await listed(registries, OTHER)).not.toContain(URI);
    expect(await other.addShared(URI)).toEqual({ uri: URI, added: true });
    expect(await listed(registries, OTHER)).toContain(URI);
    expect((await other.list()).shared).toEqual([
      expect.objectContaining({ uri: URI, available: true }),
    ]);
    expect(await other.removeShared(URI)).toEqual({ removed: true });
    expect(await listed(registries, OTHER)).not.toContain(URI);
  });

  it("refuses to add a skill that is not shared with the caller", async () => {
    const { owner, third } = setup();
    await teamSkill(owner);
    expect(await reason(third.addShared(URI))).toBe("not_found");
    expect(await reason(third.addShared("skill://team/not-an-account/style/SKILL.md"))).toBe(
      "invalid",
    );
    expect(await reason(owner.addShared(URI))).toBe("invalid");
    expect(await reason(owner.grant("style", "octocat"))).toBe("invalid");
    expect(await reason(owner.grant("style", OWNER))).toBe("invalid");
  });

  it("does not revive a share after a revoke and a re-grant", async () => {
    const { owner, other, registries } = setup();
    await teamSkill(owner);
    await owner.grant("style", OTHER);
    await other.addShared(URI);
    expect(await owner.revoke("style", OTHER)).toEqual({ revoked: true });
    expect(await listed(registries, OTHER)).not.toContain(URI);

    await owner.grant("style", OTHER);
    // Still hidden: the share was accepted under the revoked grant.
    expect(await listed(registries, OTHER)).not.toContain(URI);
    expect((await other.list()).shared[0]).toMatchObject({ available: false });
    // Direct reads work under the new grant; listing again needs a new add.
    const catalog = new SkillCatalog({ userId: OTHER, registries });
    expect((await catalog.get(URI)).frontmatter.name).toBe("style");
    await other.addShared(URI);
    expect(await listed(registries, OTHER)).toContain(URI);
  });

  it("revokes every grant when visibility changes", async () => {
    const { owner, other, registries } = setup();
    await teamSkill(owner);
    await owner.grant("style", OTHER);
    await other.addShared(URI);
    expect(await owner.update("style", { visibility: "private" })).toMatchObject({
      revoked_grants: [OTHER],
    });
    await owner.update("style", { visibility: "team" });
    expect(await listed(registries, OTHER)).not.toContain(URI);
    expect((await owner.grants("style")).grants).toEqual([]);
  });

  it("ignores a grant left over from an earlier skill of the same name", async () => {
    const { owner, other, registries } = setup();
    await teamSkill(owner);
    await owner.grant("style", OTHER);
    const key = `access:style:${OTHER}`;
    const data = registries.data(OWNER);
    data.set(key, { ...(data.get(key) as object), skillId: "sk_earlier" });
    expect(await reason(other.addShared(URI))).toBe("not_found");
    expect((await owner.grants("style")).grants).toEqual([]);
    // Granting again replaces the stale record.
    await owner.grant("style", OTHER);
    expect(await other.addShared(URI)).toEqual({ uri: URI, added: true });
  });

  it("refuses team URIs whose owner segment is not an account id", async () => {
    const { registries } = setup();
    const catalog = new SkillCatalog({ userId: OTHER, registries });
    await expect(catalog.get("skill://team/anything/style/SKILL.md")).rejects.toMatchObject({
      code: "UNKNOWN_SKILL",
    });
  });

  it("only ever writes the caller's own registry", async () => {
    const { registries } = setup();
    const object = registries.getByName(OWNER);
    await expect(object.saveDraft({ ownerId: OTHER, name: "x", files: [] })).rejects.toThrow(
      /owner/,
    );
    await expect(object.deleteSkill(OTHER, "x")).rejects.toThrow(/owner/);
    await expect(object.grant(OTHER, "x", THIRD)).rejects.toThrow(/owner/);
    await expect(object.addShare(OTHER, THIRD, "x", "gr_1")).rejects.toThrow(/owner/);
    await expect(object.ownSkills(OTHER)).rejects.toThrow(/owner/);
  });
});

describe("multix_skills_manage", () => {
  const env = fullEnv();

  it("authors a skill end to end over MCP", async () => {
    const registries = fakeRegistries();
    const deps = {
      skills: { userId: OWNER, registries },
      authoring: { userId: OWNER, registries },
    };
    const call = (args: Record<string, unknown>) =>
      callTool(env, "multix_skills_manage", args, deps);
    const saved = await call({
      action: "save_draft",
      name: "brief",
      files: [{ path: "SKILL.md", text: skillMd("brief") }],
    });
    expect(saved.isError).toBeFalsy();
    const digest = saved.structuredContent.draft.digest;
    // null: "I expect no draft yet"; one exists, so this is a conflict.
    const again = await call({
      action: "save_draft",
      name: "brief",
      files: [{ path: "SKILL.md", text: skillMd("brief") }],
      expected_digest: null,
    });
    expect(again.content[0].text).toMatch(/^CONFLICT: /);
    const published = await call({
      action: "publish",
      name: "brief",
      expected_digest: digest,
      expected_revision: 0,
      capabilities: ["image"],
    });
    expect(published.structuredContent.revision.revision).toBe(1);

    const search = await callTool(env, "multix_skills", { action: "search", task: "image" }, deps);
    expect(search.structuredContent.skills.map((s: { uri: string }) => s.uri)).toContain(
      "skill://private/brief/SKILL.md",
    );

    const conflict = await call({
      action: "set_current",
      name: "brief",
      revision: 1,
      expected_revision: 4,
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0].text).toMatch(/^CONFLICT: /);
    const missing = await call({ action: "get", name: "nope" });
    expect(missing.content[0].text).toMatch(/^NOT_FOUND: /);
    const noName = await call({ action: "get" });
    expect(noName.content[0].text).toMatch(/name is required/);
  });

  it("is listed only when the account has a registry", async () => {
    await expect(callTool(env, "multix_skills_manage", { action: "list" })).rejects.toThrow(
      /not found/,
    );
  });
});
