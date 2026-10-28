/**
 * Built-in skills: the repository's `skill/` directory, bundled into the
 * Worker as src/skills/builtin-skills.json (generated from the files by
 * `npm run skills`, which build, test, typecheck and dev run first; never
 * edited by hand). They are read-only, identical for every caller, and served
 * under `skill://multix/…`: the `multix` entry-point skill and its nested
 * task skills (`skill://multix/<task>/SKILL.md`).
 */

import catalog from "./builtin-skills.json";
import type { Frontmatter } from "./skill-frontmatter.js";
import type { SkillFile } from "./skill-types.js";

export interface BuiltinFile extends SkillFile {
  text: string;
}

export interface BuiltinSkillMeta {
  /** Directory relative to the root skill; "" for the root itself. */
  dir: string;
  frontmatter: Frontmatter;
  capabilities: string[];
}

export interface BuiltinCatalog {
  /** Name of the root skill and first URI segment: "multix". */
  root: string;
  files: BuiltinFile[];
  skills: BuiltinSkillMeta[];
}

export const BUILTIN_CATALOG = catalog as BuiltinCatalog;
