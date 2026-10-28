import { describe, expect, it } from "vitest";
import { PRIVATE_TTL_MS, PUBLIC_TTL_MS, SKILLS_EXTENSION } from "../src/skills/skills-methods.js";
import { MAX_TOOL_TEXT_BYTES } from "../src/skills/skills-tool.js";
import { modernRpc } from "./events-helpers.js";
import { callTool, fullEnv, rpc } from "./helpers.js";
import { OTHER, OWNER, fakeRegistries, skillFiles } from "./skills-helpers.js";

const env = fullEnv();
const ROOT = "skill://multix/SKILL.md";
const IMAGE = "skill://multix/image-generation/SKILL.md";

async function withPrivateSkills() {
  const registries = fakeRegistries();
  await registries.getByName(OWNER).publish({
    ownerId: OWNER,
    visibility: "private",
    files: skillFiles("secret-recipe", "Private notes", {
      "notes.txt": "only mine",
      "logo.png": new Uint8Array([137, 80, 78, 71]),
    }),
  });
  return registries;
}

describe("MCP Skills Extension (2026-07-28)", () => {
  it("declares the extension and resources in server/discover", async () => {
    const body = await modernRpc(env, "server/discover");
    expect(body.result.capabilities.extensions).toEqual({
      [SKILLS_EXTENSION]: { directoryRead: true },
    });
    expect(body.result.capabilities.resources).toBeDefined();
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists built-in skills with digests and public cache hints", async () => {
    const body = await modernRpc(env, "skills/list");
    const { skills, ttlMs, cacheScope, resultType } = body.result;
    expect({ ttlMs, cacheScope, resultType }).toEqual({
      ttlMs: PUBLIC_TTL_MS,
      cacheScope: "public",
      resultType: "complete",
    });
    expect(skills[0].uri).toBe(ROOT);
    const image = skills.find((s: { uri: string }) => s.uri === IMAGE);
    expect(image.frontmatter).toMatchObject({ name: "image-generation" });
    expect(image.resources).toEqual([
      {
        uri: IMAGE,
        digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        size: expect.any(Number),
      },
    ]);
    expect(image._meta["me.zuey.multix/skill"]).toMatchObject({
      visibility: "builtin",
      revision: 1,
      status: "published",
      capabilities: ["image", "image-edit"],
    });
    // The root skill's resources include its nested skills' files.
    const root = skills[0];
    expect(root.resources.map((r: { uri: string }) => r.uri)).toContain(IMAGE);
  });

  it("gets one skill exactly as skills/list shows it", async () => {
    const list = await modernRpc(env, "skills/list");
    const body = await modernRpc(env, "skills/get", { uri: IMAGE });
    expect(body.result.skill).toEqual(
      list.result.skills.find((s: { uri: string }) => s.uri === IMAGE),
    );
  });

  it("serves file contents matching the advertised digest", async () => {
    const list = await modernRpc(env, "skills/list");
    const image = list.result.skills.find((s: { uri: string }) => s.uri === IMAGE);
    const body = await modernRpc(env, "resources/read", { uri: IMAGE });
    const [content] = body.result.contents;
    expect(content).toMatchObject({ uri: IMAGE, mimeType: "text/markdown" });
    const bytes = new TextEncoder().encode(content.text);
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
    expect(`sha256:${hash}`).toBe(image.resources[0].digest);
    expect(bytes.length).toBe(image.resources[0].size);
  });

  it("reads directories one level at a time", async () => {
    const body = await modernRpc(env, "resources/directory/read", { uri: "skill://multix" });
    const names = body.result.resources.map((r: { name: string }) => r.name);
    expect(names).toEqual([...names].sort());
    expect(body.result.resources).toContainEqual({
      uri: "skill://multix/image-generation",
      name: "image-generation",
      mimeType: "inode/directory",
    });
    const nested = await modernRpc(env, "resources/directory/read", {
      uri: "skill://multix/image-generation",
    });
    expect(nested.result.resources.map((r: { uri: string }) => r.uri)).toEqual([IMAGE]);
  });

  it.each([
    ["skills/get", { uri: "skill://multix/nope/SKILL.md" }, /No skill is served/],
    ["skills/get", { uri: "skill://multix/../SKILL.md" }, /Invalid skill URI/],
    ["skills/get", { uri: "https://example.com/SKILL.md" }, /Invalid skill URI/],
    ["resources/read", { uri: "skill://multix/nope.md" }, /No resource is served/],
    ["resources/read", { uri: "skill://private/x/SKILL.md" }, /No resource is served/],
    ["resources/directory/read", { uri: ROOT }, /is not a directory resource/],
    ["skills/list", { cursor: "forged" }, /Invalid cursor/],
  ])("%s %j fails with a deterministic -32602", async (method, params, message) => {
    const body = await modernRpc(env, method, params);
    expect(body.error.code).toBe(-32602);
    expect(body.error.message).toMatch(message);
  });

  it("refuses an oversized URI before touching the catalog", async () => {
    const body = await modernRpc(env, "skills/get", { uri: `skill://multix/${"a".repeat(600)}` });
    expect(body.error.code).toBe(-32602);
  });

  it("shows an account its private skills, privately cached, and nobody else", async () => {
    const registries = await withPrivateSkills();
    const mine = await modernRpc(env, "skills/list", {}, { skills: { userId: OWNER, registries } });
    expect(mine.result.cacheScope).toBe("private");
    expect(mine.result.ttlMs).toBe(PRIVATE_TTL_MS);
    const uri = "skill://private/secret-recipe/SKILL.md";
    expect(mine.result.skills.map((s: { uri: string }) => s.uri)).toContain(uri);
    const blob = await modernRpc(
      env,
      "resources/read",
      { uri: "skill://private/secret-recipe/logo.png" },
      { skills: { userId: OWNER, registries } },
    );
    expect(blob.result.contents[0]).toEqual({
      uri: "skill://private/secret-recipe/logo.png",
      mimeType: "image/png",
      blob: Buffer.from([137, 80, 78, 71]).toString("base64"),
    });

    const theirs = await modernRpc(
      env,
      "skills/list",
      {},
      { skills: { userId: OTHER, registries } },
    );
    expect(theirs.result.skills.map((s: { uri: string }) => s.uri)).not.toContain(uri);
    const denied = await modernRpc(
      env,
      "skills/get",
      { uri },
      { skills: { userId: OTHER, registries } },
    );
    expect(denied.error).toMatchObject({ code: -32602, message: `No skill is served at ${uri}` });
  });

  it("paginates skills/list", async () => {
    const registries = fakeRegistries();
    for (let i = 0; i < 60; i++) {
      await registries.getByName(OWNER).publish({
        ownerId: OWNER,
        visibility: "private",
        files: skillFiles(`s-${String(i).padStart(2, "0")}`),
      });
    }
    const deps = { skills: { userId: OWNER, registries } };
    const first = await modernRpc(env, "skills/list", {}, deps);
    expect(first.result.skills).toHaveLength(50);
    expect(first.result.nextCursor).toEqual(expect.any(String));
    const second = await modernRpc(env, "skills/list", { cursor: first.result.nextCursor }, deps);
    expect(second.result.nextCursor).toBeUndefined();
    const all = [...first.result.skills, ...second.result.skills].map((s) => s.uri);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(67);
  });
});

describe("skills for 2025 clients", () => {
  it("keeps the extension methods off the legacy surface", async () => {
    const body = await rpc(env, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(body.result.capabilities.resources).toBeDefined();
    expect(body.result.capabilities.extensions).toBeUndefined();
    const list = await rpc(env, "skills/list");
    expect(list.error.code).toBe(-32601);
  });

  it("lists every SKILL.md as a resource and reads it", async () => {
    const list = await rpc(env, "resources/list");
    const uris = list.result.resources.map((r: { uri: string }) => r.uri);
    expect(uris).toContain(ROOT);
    expect(uris).toContain(IMAGE);
    const read = await rpc(env, "resources/read", { uri: IMAGE });
    expect(read.result.contents[0].text).toMatch(/^---\nname: image-generation\n/);
  });

  it("multix_skills searches, gets and reads", async () => {
    const search = await callTool(env, "multix_skills", { action: "search", task: "speech" });
    const names = search.structuredContent.skills.map((s: { name: string }) => s.name);
    expect(names).toContain("speech-production");
    expect(names).not.toContain("image-generation");

    const got = await callTool(env, "multix_skills", { action: "get", uri: IMAGE });
    expect(got.structuredContent.skill.uri).toBe(IMAGE);

    const read = await callTool(env, "multix_skills", { action: "read", uri: IMAGE, revision: 1 });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({ uri: IMAGE, revision: 1 });
    expect(read.structuredContent.digest).toBe(got.structuredContent.skill.resources[0].digest);
  });

  it("multix_skills refuses stale revisions, binary files and unknown skills", async () => {
    const stale = await callTool(env, "multix_skills", { action: "read", uri: IMAGE, revision: 7 });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toMatch(/^STALE_REVISION: /);
    const wrongDigest = await callTool(env, "multix_skills", {
      action: "read",
      uri: IMAGE,
      digest: `sha256:${"0".repeat(64)}`,
    });
    expect(wrongDigest.content[0].text).toMatch(/^STALE_REVISION: /);

    const registries = await withPrivateSkills();
    const binary = await callTool(
      env,
      "multix_skills",
      { action: "read", uri: "skill://private/secret-recipe/logo.png" },
      { skills: { userId: OWNER, registries } },
    );
    expect(binary.content[0].text).toMatch(/^BINARY_FILE: /);

    await registries.getByName(OWNER).publish({
      ownerId: OWNER,
      visibility: "private",
      files: skillFiles("big-notes", "Large notes", {
        "notes.md": "x".repeat(MAX_TOOL_TEXT_BYTES + 1),
      }),
    });
    const large = await callTool(
      env,
      "multix_skills",
      { action: "read", uri: "skill://private/big-notes/notes.md" },
      { skills: { userId: OWNER, registries } },
    );
    expect(large.content[0].text).toBe(
      `PAYLOAD_TOO_LARGE: skill://private/big-notes/notes.md is ${MAX_TOOL_TEXT_BYTES + 1} bytes, over the ${MAX_TOOL_TEXT_BYTES}-byte tool limit; read it with resources/read`,
    );

    const unknown = await callTool(env, "multix_skills", {
      action: "get",
      uri: "skill://multix/nope/SKILL.md",
    });
    expect(unknown.content[0].text).toBe(
      "UNKNOWN_SKILL: No skill is served at skill://multix/nope/SKILL.md",
    );
    const traversal = await callTool(env, "multix_skills", {
      action: "read",
      uri: "skill://multix/../../etc/passwd",
    });
    expect(traversal.content[0].text).toMatch(/^INVALID_URI: /);
  });
});
