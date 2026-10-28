/**
 * Builds the built-in Skills catalog (src/skills/builtin-skills.json) from the
 * repository's `skill/` directory: every file with its media type, size and
 * sha256 digest, and the parsed frontmatter of every SKILL.md in it. The
 * directory is the `multix` skill; a subdirectory holding a SKILL.md is a
 * nested task skill (`multix/<name>`).
 *
 * Refuses anything the Worker would refuse to serve: symlinks, unsafe paths,
 * unserved file types, files over the per-file cap, frontmatter that is not
 * the supported YAML subset, or a skill name that differs from its directory.
 */

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isTask } from "../../src/capabilities/capability-types.js";
import type { BuiltinCatalog, BuiltinSkillMeta } from "../src/skills/builtin-skills.js";
import {
  decodeText,
  fileSetProblem,
  isTextMediaType,
  mediaTypeFor,
  sha256Digest,
} from "../src/skills/skill-files.js";
import { parseFrontmatter } from "../src/skills/skill-frontmatter.js";
import {
  MAX_BYTES_PER_FILE,
  MAX_BYTES_PER_SKILL,
  MAX_FILES_PER_SKILL,
} from "../src/skills/skill-types.js";

export const BUILTIN_ROOT_NAME = "multix";

function walk(dir: string, prefix: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`skill/${rel}: symlinks are not allowed`);
    if (stat.isDirectory()) walk(full, rel, out);
    else if (stat.isFile()) out.push(rel);
    else throw new Error(`skill/${rel}: not a regular file`);
  }
}

/** Comma-separated `metadata.tasks`, each a multix task id. */
function capabilitiesOf(path: string, metadata: unknown): string[] {
  const raw =
    metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>).tasks : "";
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(`skill/${path}: frontmatter needs metadata.tasks (multix task ids)`);
  }
  const tasks = raw.split(",").map((t) => t.trim());
  for (const task of tasks)
    if (!isTask(task)) throw new Error(`skill/${path}: unknown task "${task}"`);
  return tasks;
}

export async function buildSkillCatalog(skillDir: string): Promise<BuiltinCatalog> {
  const paths: string[] = [];
  walk(skillDir, "", paths);
  const files: BuiltinCatalog["files"] = [];
  for (const path of paths) {
    const bytes = readFileSync(join(skillDir, path));
    const mediaType = mediaTypeFor(path);
    if (!mediaType || !isTextMediaType(mediaType)) {
      throw new Error(`skill/${path}: built-in skills hold text files only`);
    }
    const text = decodeText(bytes);
    if (text === undefined) throw new Error(`skill/${path}: not UTF-8 text without a BOM`);
    files.push({ path, mediaType, size: bytes.length, digest: await sha256Digest(bytes), text });
  }
  const problem = fileSetProblem(files, {
    maxFiles: MAX_FILES_PER_SKILL,
    maxBytes: MAX_BYTES_PER_SKILL,
    maxFileBytes: MAX_BYTES_PER_FILE,
  });
  if (problem) throw new Error(`skill/: ${problem}`);

  const skills: BuiltinSkillMeta[] = [];
  for (const file of files) {
    if (file.path !== "SKILL.md" && !file.path.endsWith("/SKILL.md")) continue;
    const dir = file.path.slice(0, -"SKILL.md".length).replace(/\/$/, "");
    const frontmatter = parseFrontmatter(file.text);
    const expected = dir === "" ? BUILTIN_ROOT_NAME : dir.slice(dir.lastIndexOf("/") + 1);
    if (frontmatter.name !== expected) {
      throw new Error(`skill/${file.path}: name "${frontmatter.name}" must be "${expected}"`);
    }
    skills.push({
      dir,
      frontmatter,
      capabilities: capabilitiesOf(file.path, frontmatter.metadata),
    });
  }
  return { root: BUILTIN_ROOT_NAME, files, skills };
}
