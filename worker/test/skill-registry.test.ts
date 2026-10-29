import { describe, expect, it } from "vitest";
import {
  SkillCatalog,
  SkillCatalogError,
  decodeCursor,
  paginate,
  parseSkillUri,
} from "../src/skills/skill-catalog.js";
import { MAX_SKILLS_PER_ACCOUNT } from "../src/skills/skill-registry.js";
import { MAX_BYTES_PER_FILE } from "../src/skills/skill-types.js";
import { OTHER, OWNER, fakeRegistries, skillFiles } from "./skills-helpers.js";

async function catalogError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SkillCatalogError) return error.code;
    throw error;
  }
  throw new Error("expected a SkillCatalogError");
}

describe("skills registry", () => {
  it("publishes immutable revisions with content-addressed files", async () => {
    const registries = fakeRegistries();
    const registry = registries.getByName(OWNER);
    const first = await registry.publish({
      ownerId: OWNER,
      visibility: "private",
      files: skillFiles("brand-voice", "Write in the brand voice", { "refs/tone.md": "warm" }),
      tags: ["writing"],
    });
    expect(first.skill).toMatchObject({ name: "brand-voice", currentRevision: 1, ownerId: OWNER });
    expect(first.revision.files.map((f) => f.path)).toEqual(["SKILL.md", "refs/tone.md"]);
    expect(first.revision.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const second = await registry.publish({
      ownerId: OWNER,
      visibility: "private",
      files: skillFiles("brand-voice", "Write in the brand voice", { "refs/tone.md": "warmer" }),
    });
    expect(second.skill.id).toBe(first.skill.id);
    expect(second.revision.revision).toBe(2);
    expect(second.revision.manifestDigest).not.toBe(first.revision.manifestDigest);
    // The earlier revision is kept as it was.
    const data = registries.data(OWNER);
    expect(data.get("rev:brand-voice:000001")).toEqual(first.revision);
    // SKILL.md did not change, so both revisions share one blob for it.
    const blobs = [...data.keys()].filter((k) => k.startsWith("blob:"));
    expect(blobs).toHaveLength(3);
  });

  it.each([
    ["no SKILL.md", [{ path: "README.md", bytes: new Uint8Array(1) }]],
    ["path traversal", [...skillFiles("x"), { path: "../escape.md", bytes: new Uint8Array(1) }]],
    ["an absolute path", [...skillFiles("x"), { path: "/etc/passwd", bytes: new Uint8Array(1) }]],
    [
      "an oversized file",
      [...skillFiles("x"), { path: "big.md", bytes: new Uint8Array(MAX_BYTES_PER_FILE + 1) }],
    ],
    [
      "invalid frontmatter",
      [{ path: "SKILL.md", bytes: new TextEncoder().encode("---\nname: Bad Name\n---\n") }],
    ],
    ["a non-UTF-8 SKILL.md", [{ path: "SKILL.md", bytes: new Uint8Array([0xff, 0xfe]) }]],
    [
      "a SKILL.md with a byte-order mark",
      [
        {
          path: "SKILL.md",
          bytes: new TextEncoder().encode("\uFEFF---\nname: a\ndescription: d\n---\n"),
        },
      ],
    ],
    [
      "a non-UTF-8 text file",
      [...skillFiles("a"), { path: "notes.md", bytes: new Uint8Array([0xc3, 0x28]) }],
    ],
  ])("refuses %s", async (_label, files) => {
    const registry = fakeRegistries().getByName(OWNER);
    await expect(
      registry.publish({ ownerId: OWNER, visibility: "private", files }),
    ).rejects.toMatchObject({ name: "SkillRegistryError", reason: "invalid" });
  });

  it("caps the number of skills per account", async () => {
    const registries = fakeRegistries();
    const data = registries.data(OWNER);
    for (let i = 0; i < MAX_SKILLS_PER_ACCOUNT; i++) data.set(`skill:s${i}`, { name: `s${i}` });
    await expect(
      registries
        .getByName(OWNER)
        .publish({ ownerId: OWNER, visibility: "private", files: skillFiles("one-more") }),
    ).rejects.toThrow(/at most/);
  });

  it("refuses to share a private skill", async () => {
    const registry = fakeRegistries().getByName(OWNER);
    await registry.publish({ ownerId: OWNER, visibility: "private", files: skillFiles("mine") });
    await expect(registry.grant(OWNER, "mine", OTHER)).rejects.toThrow(/team/);
    await expect(registry.grant(OWNER, "missing", OTHER)).rejects.toThrow(/no skill/);
  });
});

describe("skills catalog", () => {
  async function seeded() {
    const registries = fakeRegistries();
    const owner = registries.getByName(OWNER);
    await owner.publish({
      ownerId: OWNER,
      visibility: "private",
      files: skillFiles("secret-recipe", "Private notes", { "notes.txt": "only mine" }),
    });
    await owner.publish({
      ownerId: OWNER,
      visibility: "team",
      files: skillFiles("team-style", "Shared style guide", {
        "assets/logo.png": new Uint8Array([137, 80, 78, 71]),
      }),
    });
    return registries;
  }

  it("lists built-ins first, then the caller's own skills", async () => {
    const catalog = new SkillCatalog({ userId: OWNER, registries: await seeded() });
    const uris = (await catalog.list()).map((s) => s.uri);
    expect(uris[0]).toBe("skill://multix/SKILL.md");
    expect(uris).toContain("skill://multix/image-generation/SKILL.md");
    expect(uris.slice(-2)).toEqual([
      "skill://private/secret-recipe/SKILL.md",
      `skill://team/${OWNER}/team-style/SKILL.md`,
    ]);
    expect(catalog.personal).toBe(true);
  });

  it("never shows one account's skills to another", async () => {
    const registries = await seeded();
    const other = new SkillCatalog({ userId: OTHER, registries });
    const uris = (await other.list()).map((s) => s.uri);
    expect(uris.every((u) => u.startsWith("skill://multix/"))).toBe(true);
    // `private/` always means the caller's own registry.
    expect(await catalogError(other.get("skill://private/secret-recipe/SKILL.md"))).toBe(
      "UNKNOWN_SKILL",
    );
    expect(await catalogError(other.read("skill://private/secret-recipe/notes.txt"))).toBe(
      "NOT_FOUND",
    );
    // A team skill without a grant answers exactly like a missing one.
    const teamUri = `skill://team/${OWNER}/team-style/SKILL.md`;
    expect(await catalogError(other.get(teamUri))).toBe("UNKNOWN_SKILL");
    expect(await catalogError(other.get(`skill://team/${OWNER}/nope/SKILL.md`))).toBe(
      "UNKNOWN_SKILL",
    );
    // Nor can a private skill be reached through a team URI.
    expect(await catalogError(other.get(`skill://team/${OWNER}/secret-recipe/SKILL.md`))).toBe(
      "UNKNOWN_SKILL",
    );
    expect(
      await catalogError(
        new SkillCatalog({ userId: OWNER, registries }).get(
          `skill://team/${OWNER}/secret-recipe/SKILL.md`,
        ),
      ),
    ).toBe("UNKNOWN_SKILL");
  });

  it("serves a team skill to a granted account", async () => {
    const registries = await seeded();
    const { grantId } = await registries.getByName(OWNER).grant(OWNER, "team-style", OTHER);
    await registries.getByName(OTHER).addShare(OTHER, OWNER, "team-style", grantId);
    const other = new SkillCatalog({ userId: OTHER, registries });
    const teamUri = `skill://team/${OWNER}/team-style/SKILL.md`;
    expect((await other.list()).map((s) => s.uri)).toContain(teamUri);
    expect((await other.get(teamUri)).frontmatter.name).toBe("team-style");
    const logo = await other.read(`skill://team/${OWNER}/team-style/assets/logo.png`);
    expect(logo.mimeType).toBe("image/png");
    // The private skill stays hidden.
    expect(await catalogError(other.read(`skill://team/${OWNER}/secret-recipe/notes.txt`))).toBe(
      "NOT_FOUND",
    );
    // A share record without a grant shows nothing.
    await registries.getByName(OTHER).addShare(OTHER, OWNER, "secret-recipe", grantId);
    expect((await other.list()).map((s) => s.uri)).not.toContain(
      `skill://team/${OWNER}/secret-recipe/SKILL.md`,
    );
  });

  it("re-hashes stored content and reports corruption", async () => {
    const registries = await seeded();
    const data = registries.data(OWNER);
    const key = [...data.keys()].find(
      (k) =>
        k.startsWith("blob:") &&
        new TextDecoder().decode(data.get(k) as Uint8Array) === "only mine",
    ) as string;
    data.set(key, new TextEncoder().encode("tampered"));
    const catalog = new SkillCatalog({ userId: OWNER, registries });
    expect(await catalogError(catalog.read("skill://private/secret-recipe/notes.txt"))).toBe(
      "CORRUPT",
    );
  });

  it("reads built-ins and their directories", async () => {
    const catalog = new SkillCatalog({ userId: OWNER });
    expect(catalog.personal).toBe(false);
    const file = await catalog.read("skill://multix/image-generation/SKILL.md");
    expect(new TextDecoder().decode(file.bytes)).toMatch(/^---\nname: image-generation\n/);
    const root = await catalog.readDirectory("skill://multix");
    expect(root.map((r) => r.name)).toContain("image-generation");
    expect(root.find((r) => r.name === "image-generation")?.mimeType).toBe("inode/directory");
    expect(await catalogError(catalog.readDirectory("skill://multix/SKILL.md"))).toBe(
      "NOT_DIRECTORY",
    );
    // The root skill lists its nested skills' files too.
    const multix = await catalog.get("skill://multix/SKILL.md");
    expect(multix.files.map((f) => f.path)).toContain("image-generation/SKILL.md");
  });

  it.each([
    "https://example.com/SKILL.md",
    "skill://multix/../private/x/SKILL.md",
    "skill://multix/./SKILL.md",
    "skill://multix//SKILL.md",
    "skill://multix/%2e%2e/SKILL.md",
    "skill://multix/SKILL.md?x=1",
    "skill://multix/SKILL.md#top",
    "skill://multix\\SKILL.md",
    `skill://multix/${"a".repeat(600)}`,
  ])("refuses the URI %j", (uri) => {
    expect(() => parseSkillUri(uri)).toThrow(SkillCatalogError);
  });

  it("paginates with opaque cursors and refuses forged ones", () => {
    const items = Array.from({ length: 5 }, (_, i) => i);
    const first = paginate(items, undefined, 2);
    expect(first.page).toEqual([0, 1]);
    const second = paginate(items, first.nextCursor, 2);
    expect(second.page).toEqual([2, 3]);
    const last = paginate(items, second.nextCursor, 2);
    expect(last).toEqual({ page: [4] });
    expect(() => decodeCursor("not-base64!")).toThrow(SkillCatalogError);
    expect(() => decodeCursor(btoa(JSON.stringify({ o: -1 })))).toThrow(SkillCatalogError);
  });
});
