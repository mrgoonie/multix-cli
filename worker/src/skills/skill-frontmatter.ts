/**
 * SKILL.md frontmatter, read strictly. Skills entries must carry the
 * frontmatter "rendered verbatim as a JSON object", so this parser accepts
 * only a YAML subset it can render faithfully and refuses everything else
 * instead of guessing:
 *
 *   key: scalar            plain, "double" or 'single' quoted; `# comment` after a space
 *   key:                   followed by a block of `  child: scalar` lines (one level)
 *   key:                   followed by a block of `  - scalar` lines
 *
 * Plain scalars are typed as YAML's core schema does (null, booleans,
 * integers, floats); everything else is a string. A plain scalar containing
 * ": " or starting with an indicator character is invalid YAML and refused.
 * Name and description follow the Agent Skills specification.
 */

export type FrontmatterValue = string | number | boolean | null;
export type Frontmatter = {
  name: string;
  description: string;
  [key: string]: FrontmatterValue | FrontmatterValue[] | Record<string, FrontmatterValue>;
};

export class FrontmatterError extends Error {
  override name = "FrontmatterError";
}

export const MAX_SKILL_NAME_CHARS = 64;
export const MAX_DESCRIPTION_CHARS = 1024;
/** Frontmatter longer than this is not a header any more. */
const MAX_FRONTMATTER_CHARS = 16_384;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
/** Keys that name Object.prototype members instead of own data when read back. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INDICATORS = new Set([..."-?:,[]{}#&*!|>'\"%@`"]);
const ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t" };

/** Agent Skills naming: 1-64 chars of a-z, 0-9 and single inner hyphens. */
export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SKILL_NAME_CHARS && NAME_RE.test(name);
}

function fail(line: number, message: string): never {
  throw new FrontmatterError(`SKILL.md frontmatter line ${line}: ${message}`);
}

/** Strip a trailing ` # comment` from a plain scalar. */
function stripComment(raw: string): string {
  const at = raw.search(/\s#/);
  return (at === -1 ? raw : raw.slice(0, at)).trimEnd();
}

function plainScalar(raw: string, line: number): FrontmatterValue {
  const text = stripComment(raw);
  if (text === "" || text === "~" || text === "null" || text === "Null" || text === "NULL") {
    return null;
  }
  // `-`, `?` and `:` start a plain value only when followed by a non-space.
  const first = text[0] as string;
  if (INDICATORS.has(first) && !("-?:".includes(first) && /^.\S/.test(text))) {
    fail(line, `a plain value may not start with "${first}"; quote it`);
  }
  if (/:(\s|$)/.test(text)) fail(line, 'a plain value may not contain ": "; quote it');
  // Forms YAML parsers disagree on (hex, octal, infinities, dates): quote them.
  if (
    /^[-+]?0[xXoO]|^[-+]?\.(inf|Inf|INF|nan|NaN|NAN)$|^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}/.test(text)
  ) {
    fail(line, "ambiguous plain value; quote it");
  }
  if (/^(true|True|TRUE)$/.test(text)) return true;
  if (/^(false|False|FALSE)$/.test(text)) return false;
  if (/^[-+]?[0-9]+$/.test(text)) return Number(text);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  return text;
}

function doubleQuoted(raw: string, line: number): string {
  let out = "";
  let i = 1;
  for (; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === '"') break;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[++i];
    if (next !== undefined && Object.hasOwn(ESCAPES, next)) out += ESCAPES[next];
    else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else fail(line, "unsupported escape in a double-quoted value");
  }
  if (i >= raw.length) fail(line, "unterminated double-quoted value");
  if (stripComment(raw.slice(i + 1)).trim() !== "") fail(line, "text after a quoted value");
  return out;
}

function singleQuoted(raw: string, line: number): string {
  let out = "";
  let i = 1;
  for (; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === "'") {
      if (raw[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      break;
    }
    out += c;
  }
  if (i >= raw.length) fail(line, "unterminated single-quoted value");
  if (stripComment(raw.slice(i + 1)).trim() !== "") fail(line, "text after a quoted value");
  return out;
}

function scalar(raw: string, line: number): FrontmatterValue {
  const text = raw.trim();
  if (text.startsWith('"')) return doubleQuoted(text, line);
  if (text.startsWith("'")) return singleQuoted(text, line);
  return plainScalar(text, line);
}

/** `key: rest` split, with the key checked. */
function keyValue(text: string, line: number): [string, string] {
  const at = text.indexOf(":");
  if (at <= 0) fail(line, "expected `key: value`");
  const key = text.slice(0, at);
  const rest = text.slice(at + 1);
  if (!KEY_RE.test(key) || RESERVED_KEYS.has(key)) {
    fail(line, `unsupported key "${key.slice(0, 32)}"`);
  }
  if (rest !== "" && !/^\s/.test(rest)) fail(line, "expected a space after the colon");
  return [key, rest.trim()];
}

/**
 * The frontmatter block of a SKILL.md: the text between a first line `---`
 * and the next `---` line. Returns the block and the byte-exact body offset.
 */
export function splitFrontmatter(markdown: string): { block: string[]; firstLine: number } {
  const text = markdown.startsWith("﻿") ? markdown.slice(1) : markdown;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") {
    throw new FrontmatterError("SKILL.md must start with a `---` frontmatter line");
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === "---");
  if (end === -1) throw new FrontmatterError("SKILL.md frontmatter has no closing `---` line");
  const block = lines.slice(1, end);
  if (block.join("\n").length > MAX_FRONTMATTER_CHARS) {
    throw new FrontmatterError("SKILL.md frontmatter is too long");
  }
  return { block, firstLine: 2 };
}

/** Parse and validate the frontmatter of a SKILL.md. */
export function parseFrontmatter(markdown: string): Frontmatter {
  const { block, firstLine } = splitFrontmatter(markdown);
  const out: Record<string, Frontmatter[string]> = {};
  let i = 0;
  while (i < block.length) {
    const line = firstLine + i;
    const raw = (block[i] as string).trimEnd();
    i++;
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    if (/^\s/.test(raw)) fail(line, "unexpected indentation");
    if (raw.includes("\t")) fail(line, "tabs are not allowed");
    const [key, rest] = keyValue(raw, line);
    if (Object.hasOwn(out, key)) fail(line, `duplicate key "${key}"`);
    if (stripComment(rest) !== "") {
      out[key] = scalar(rest, line);
      continue;
    }
    // A block: indented `child: value` lines or `- item` lines.
    const children: string[] = [];
    const childLines: number[] = [];
    while (i < block.length) {
      const next = (block[i] as string).trimEnd();
      if (next.trim() === "" || next.trimStart().startsWith("#")) {
        i++;
        continue;
      }
      if (!/^\s/.test(next)) break;
      children.push(next);
      childLines.push(firstLine + i);
      i++;
    }
    if (children.length === 0) {
      out[key] = null;
      continue;
    }
    const indent = (children[0] as string).match(/^ +/)?.[0] ?? "";
    if (indent === "") fail(childLines[0] as number, "indent with spaces");
    const isList = (children[0] as string).trimStart().startsWith("- ");
    const list: FrontmatterValue[] = [];
    const map: Record<string, FrontmatterValue> = {};
    children.forEach((child, n) => {
      const at = childLines[n] as number;
      if (!child.startsWith(indent) || /^\s/.test(child.slice(indent.length))) {
        fail(at, "only one level of nesting is supported");
      }
      const body = child.slice(indent.length);
      if (isList) {
        if (!body.startsWith("- ")) fail(at, "expected `- item`");
        list.push(scalar(body.slice(2), at));
      } else {
        const [childKey, value] = keyValue(body, at);
        if (Object.hasOwn(map, childKey)) fail(at, `duplicate key "${childKey}"`);
        if (stripComment(value) === "") fail(at, "only one level of nesting is supported");
        map[childKey] = scalar(value, at);
      }
    });
    out[key] = isList ? list : map;
  }
  const { name, description } = out;
  if (typeof name !== "string" || !isValidSkillName(name)) {
    throw new FrontmatterError(
      "SKILL.md frontmatter `name` must be 1-64 lowercase letters, digits and single hyphens",
    );
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new FrontmatterError("SKILL.md frontmatter needs a non-empty `description`");
  }
  if (description.length > MAX_DESCRIPTION_CHARS) {
    throw new FrontmatterError(
      `SKILL.md frontmatter \`description\` is longer than ${MAX_DESCRIPTION_CHARS} characters`,
    );
  }
  return out as Frontmatter;
}
