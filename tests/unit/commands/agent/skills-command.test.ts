import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_INTRO } from "../../../../src/commands/agent/agent-intro.js";
import {
  listSkills,
  parseSkillFrontMatter,
  skillsDir,
} from "../../../../src/commands/agent/skills-command.js";

describe("parseSkillFrontMatter", () => {
  it("reads name, description and tasks from flat keys", () => {
    const text = "---\nname: demo\ndescription: Does a thing.\nmetadata:\n  tasks: a,b\n---\nbody";
    expect(parseSkillFrontMatter(text)).toEqual({
      name: "demo",
      description: "Does a thing.",
      tasks: "a,b",
    });
  });

  it("returns nothing for text without front matter", () => {
    expect(parseSkillFrontMatter("# no front matter")).toEqual({
      name: undefined,
      description: undefined,
      tasks: undefined,
    });
  });
});

describe("listSkills", () => {
  it("lists the entry skill first, then nested skills sorted, skipping unnamed ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multix-skills-"));
    const write = (rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    write("SKILL.md", "---\nname: multix\ndescription: entry\n---\n");
    write("b-task/SKILL.md", "---\nname: b-task\ndescription: b\n---\n");
    write("a-task/SKILL.md", "---\nname: a-task\ndescription: a\n---\n");
    write("broken/SKILL.md", "no front matter");
    expect(listSkills(dir).map((s) => s.name)).toEqual(["multix", "a-task", "b-task"]);
  });

  it("finds the repository skill/ directory from source", () => {
    const dir = skillsDir();
    expect(dir).toBeDefined();
    expect(listSkills(dir).some((s) => s.name === "multix")).toBe(true);
  });
});

describe("AGENT_INTRO", () => {
  it("points agents at the guide, the skills command and the entry skill", () => {
    expect(AGENT_INTRO).toContain("multix guide");
    expect(AGENT_INTRO).toContain("multix skills");
    expect(AGENT_INTRO).toContain("multix skills multix");
  });
});
