#!/usr/bin/env node
/**
 * Regenerate src/skills/builtin-skills.json from the repository's `skill/`
 * directory. Usage (from worker/): npm run skills
 *
 * The output is generated, not committed (.gitignore): release-please rewrites
 * the `version:` lines of the SKILL.md files, so a committed copy would go
 * stale on every release. `dev`, `build`, `typecheck`, `test` and `deploy`
 * regenerate it first.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSkillCatalog } from "./skill-catalog-builder.js";

const skillDir = fileURLToPath(new URL("../../skill/", import.meta.url));
const output = fileURLToPath(new URL("../src/skills/builtin-skills.json", import.meta.url));

const catalog = await buildSkillCatalog(skillDir);
writeFileSync(output, `${JSON.stringify(catalog)}\n`);
const bytes = catalog.files.reduce((n, f) => n + f.size, 0);
console.log(
  `skills: ${catalog.skills.length} skills, ${catalog.files.length} files, ${bytes} bytes -> ${output}`,
);
