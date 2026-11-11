/**
 * `multix skills` — the agent skills shipped in the package (`skill/`): the
 * entry skill `multix` and one skill per task. Lists them with their
 * description and path, or prints one SKILL.md so an agent can read how to use
 * the commands, best practices and troubleshooting without knowing where the
 * package lives. Read-only; nothing is run or fetched.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { run } from "../../agent/run-state.js";
import { ValidationError } from "../../core/errors.js";

export interface SkillInfo {
  name: string;
  description: string;
  tasks: string;
  /** Absolute path of the skill's SKILL.md. */
  path: string;
}

/** The package's `skill/` directory, from the bundled dist/cli.js or from source. */
export function skillsDir(
  from: string = path.dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  for (const rel of ["../skill", "../../skill", "../../../skill"]) {
    const dir = path.resolve(from, rel);
    if (fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
  }
  return undefined;
}

/** Name, description and tasks from a SKILL.md front matter (flat keys only). */
export function parseSkillFrontMatter(text: string): {
  name?: string;
  description?: string;
  tasks?: string;
} {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const pick = (key: string) => new RegExp(`^\\s*${key}:\\s*(.+)$`, "m").exec(block)?.[1]?.trim();
  return { name: pick("name"), description: pick("description"), tasks: pick("tasks") };
}

export function listSkills(dir: string | undefined = skillsDir()): SkillInfo[] {
  if (!dir) return [];
  const files = [
    path.join(dir, "SKILL.md"),
    ...fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name, "SKILL.md"))
      .filter((f) => fs.existsSync(f))
      .sort(),
  ];
  return files.flatMap((file) => {
    const meta = parseSkillFrontMatter(fs.readFileSync(file, "utf8"));
    if (!meta.name) return [];
    return [
      { name: meta.name, description: meta.description ?? "", tasks: meta.tasks ?? "", path: file },
    ];
  });
}

export function registerSkillsCommand(program: Command): void {
  program
    .command("skills [name]")
    .description(
      "Agent skills shipped with multix: list them, or print one (usage, best practices, troubleshooting). Start with `multix skills multix`",
    )
    .option("--path", "Print only the path of the skill's SKILL.md")
    .action((name: string | undefined, opts: { path?: boolean }) => {
      const skills = listSkills();
      if (skills.length === 0) {
        throw new ValidationError(
          "No skills found next to this multix install. Read skill/SKILL.md in the repository: https://github.com/mrgoonie/multix-cli/tree/main/skill",
        );
      }
      if (!name) {
        if (run.json) return console.log(JSON.stringify({ skills }));
        console.log(
          "multix agent skills (read one with `multix skills <name>`; start with `multix`):",
        );
        for (const s of skills) {
          console.log(`\n  ${s.name}${s.tasks ? `  [tasks: ${s.tasks}]` : ""}`);
          console.log(
            `    ${s.description.length > 200 ? `${s.description.slice(0, 197)}...` : s.description}`,
          );
          console.log(`    ${s.path}`);
        }
        return;
      }
      const found = skills.find((s) => s.name === name);
      if (!found) {
        throw new ValidationError(
          `No skill ${name}. Available: ${skills.map((s) => s.name).join(", ")}`,
        );
      }
      if (opts.path)
        return console.log(run.json ? JSON.stringify({ path: found.path }) : found.path);
      const text = fs.readFileSync(found.path, "utf8");
      if (run.json) return console.log(JSON.stringify({ ...found, content: text }));
      console.log(text);
    });
}
