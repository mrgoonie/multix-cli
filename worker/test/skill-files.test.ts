import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSkillCatalog } from "../scripts/skill-catalog-builder.js";
import { BUILTIN_CATALOG } from "../src/skills/builtin-skills.js";
import {
  fileSetProblem,
  isSafeRelativePath,
  manifestDigest,
  sha256Digest,
} from "../src/skills/skill-files.js";
import { FrontmatterError, parseFrontmatter } from "../src/skills/skill-frontmatter.js";

const skillMd = (front: string, body = "# Body\n") => `---\n${front}\n---\n${body}`;
const LIMITS = { maxFiles: 3, maxBytes: 100, maxFileBytes: 60 };

describe("SKILL.md frontmatter", () => {
  it("parses scalars, one-level maps and lists as typed JSON", () => {
    const front = parseFrontmatter(
      skillMd(
        [
          "name: image-generation",
          'description: "Generate images: text-to-image and edits"',
          "version: 1.22.0-beta.2 # x-release-please-version",
          "license: MIT",
          "count: 3",
          "ratio: 0.5",
          "enabled: true",
          "empty:",
          "metadata:",
          "  tasks: image, image-edit",
          "  level: 2",
          "keywords:",
          "  - image",
          "  - 'edit: inpaint'",
        ].join("\n"),
      ),
    );
    expect(front).toEqual({
      name: "image-generation",
      description: "Generate images: text-to-image and edits",
      version: "1.22.0-beta.2",
      license: "MIT",
      count: 3,
      ratio: 0.5,
      enabled: true,
      empty: null,
      metadata: { tasks: "image, image-edit", level: 2 },
      keywords: ["image", "edit: inpaint"],
    });
  });

  it.each([
    ["missing frontmatter", "# Title\n"],
    ["an unquoted ': ' inside a value", skillMd("name: a\ndescription: Use when: always")],
    ["a duplicate key", skillMd("name: a\nname: b\ndescription: d")],
    ["a tab", skillMd("name: a\ndescription:\td")],
    ["nesting deeper than one level", skillMd("name: a\ndescription: d\nm:\n  x:\n    y: 1")],
    ["an invalid name", skillMd("name: Bad_Name\ndescription: d")],
    ["a missing description", skillMd("name: a")],
    ["an overlong description", skillMd(`name: a\ndescription: ${"x".repeat(1025)}`)],
    ["a flow collection", skillMd("name: a\ndescription: d\ntags: [a, b]")],
    ["a reserved key", skillMd("name: a\ndescription: d\n__proto__: x")],
    ["a hex-looking value", skillMd("name: a\ndescription: d\nversion: 0x10")],
    ["a date-looking value", skillMd("name: a\ndescription: d\nreleased: 2026-10-28")],
    ["an infinity value", skillMd("name: a\ndescription: d\nweight: .inf")],
  ])("refuses %s", (_label, markdown) => {
    expect(() => parseFrontmatter(markdown)).toThrow(FrontmatterError);
  });
});

describe("skill file paths", () => {
  it.each(["SKILL.md", "references/api.md", "scripts/run_check.py", "assets/logo.v2.png"])(
    "accepts %s",
    (path) => {
      expect(isSafeRelativePath(path)).toBe(true);
    },
  );

  it.each([
    "",
    "/etc/passwd",
    "../secret.md",
    "refs/../../x.md",
    "refs/./x.md",
    "refs//x.md",
    "refs\\x.md",
    "refs/x.md/",
    ".hidden.md",
    "trailing.",
    "a/b/c/d/e/f/g/h/i.md",
    "name with space.md",
    "%2e%2e/x.md",
  ])("refuses %j", (path) => {
    expect(isSafeRelativePath(path)).toBe(false);
  });

  it("checks the whole file set: SKILL.md, uniqueness, types and limits", () => {
    expect(fileSetProblem([{ path: "SKILL.md", size: 10 }], LIMITS)).toBeUndefined();
    expect(fileSetProblem([{ path: "README.md", size: 1 }], LIMITS)).toMatch(/SKILL\.md/);
    expect(
      fileSetProblem(
        [
          { path: "SKILL.md", size: 1 },
          { path: "SKILL.md", size: 1 },
        ],
        LIMITS,
      ),
    ).toMatch(/duplicate/i);
    expect(
      fileSetProblem(
        [
          { path: "SKILL.md", size: 1 },
          { path: "bin/tool.exe", size: 1 },
        ],
        LIMITS,
      ),
    ).toMatch(/type/i);
    expect(fileSetProblem([{ path: "SKILL.md", size: 61 }], LIMITS)).toMatch(/60/);
    expect(
      fileSetProblem(
        [
          { path: "SKILL.md", size: 50 },
          { path: "a.md", size: 51 },
        ],
        LIMITS,
      ),
    ).toMatch(/100/);
    expect(
      fileSetProblem(
        ["SKILL.md", "a.md", "b.md", "c.md"].map((path) => ({ path, size: 1 })),
        LIMITS,
      ),
    ).toMatch(/3/);
  });

  it("digests content and manifests independently of file order", async () => {
    const digest = await sha256Digest(new TextEncoder().encode("abc"));
    expect(digest).toBe("sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const a = { path: "a.md", mediaType: "text/markdown", size: 3, digest };
    const b = { path: "SKILL.md", mediaType: "text/markdown", size: 3, digest };
    expect(await manifestDigest([a, b])).toBe(await manifestDigest([b, a]));
    expect(await manifestDigest([a, b])).not.toBe(await manifestDigest([a]));
  });
});

describe("built-in skill catalog", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function skillTree(files: Record<string, string>): string {
    dir = mkdtempSync(join(tmpdir(), "multix-skill-"));
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  }

  it("matches the repository's skill/ directory", async () => {
    const fresh = await buildSkillCatalog(join(__dirname, "../../skill"));
    expect(BUILTIN_CATALOG).toEqual(fresh);
    const names = fresh.skills.map((s) => s.frontmatter.name).sort();
    expect(names).toEqual([
      "3d-generation",
      "document-conversion",
      "image-generation",
      "media-qa",
      "multix",
      "speech-production",
      "video-production",
    ]);
    for (const skill of fresh.skills) expect(skill.capabilities.length).toBeGreaterThan(0);
  });

  it("releases every SKILL.md with the package version in both release configs", async () => {
    const repo = join(__dirname, "../..");
    const fresh = await buildSkillCatalog(join(repo, "skill"));
    const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
    for (const config of ["release-please-config.json", "release-please-beta-config.json"]) {
      const parsed = JSON.parse(readFileSync(join(repo, config), "utf8"));
      const extra = parsed.packages["."]["extra-files"].map((f: { path: string }) => f.path);
      for (const skill of fresh.skills) {
        const path = skill.dir ? `skill/${skill.dir}/SKILL.md` : "skill/SKILL.md";
        expect(extra, `${config} releases ${path}`).toContain(path);
        expect(readFileSync(join(repo, path), "utf8")).toContain(
          `\nversion: ${version} # x-release-please-version\n`,
        );
      }
    }
  });

  it("names nested skills after their directory and reads their tasks", async () => {
    const root = skillTree({
      "SKILL.md": skillMd("name: multix\ndescription: root\nmetadata:\n  tasks: any"),
      "image-generation/SKILL.md": skillMd(
        "name: image-generation\ndescription: images\nmetadata:\n  tasks: image, image-edit",
      ),
    });
    const catalog = await buildSkillCatalog(root);
    expect(catalog.skills.map((s) => [s.dir, s.capabilities])).toEqual(
      expect.arrayContaining([
        ["", ["any"]],
        ["image-generation", ["image", "image-edit"]],
      ]),
    );
  });

  it("refuses a name that differs from its directory", async () => {
    const root = skillTree({
      "SKILL.md": skillMd("name: multix\ndescription: root\nmetadata:\n  tasks: any"),
      "video/SKILL.md": skillMd(
        "name: video-production\ndescription: video\nmetadata:\n  tasks: video",
      ),
    });
    await expect(buildSkillCatalog(root)).rejects.toThrow(/video/);
  });

  it("refuses an unknown task", async () => {
    const root = skillTree({
      "SKILL.md": skillMd("name: multix\ndescription: root\nmetadata:\n  tasks: teleport"),
    });
    await expect(buildSkillCatalog(root)).rejects.toThrow(/teleport/);
  });

  it("refuses text with a byte-order mark", async () => {
    const root = skillTree({
      "SKILL.md": skillMd("name: multix\ndescription: root\nmetadata:\n  tasks: any"),
      "notes.md": "\uFEFFhello",
    });
    await expect(buildSkillCatalog(root)).rejects.toThrow(/BOM/);
  });

  it("refuses symlinks instead of following them", async () => {
    const root = skillTree({
      "SKILL.md": skillMd("name: multix\ndescription: root\nmetadata:\n  tasks: any"),
    });
    symlinkSync("/etc/hostname", join(root, "linked.md"));
    await expect(buildSkillCatalog(root)).rejects.toThrow(/symlink|regular/i);
  });
});
