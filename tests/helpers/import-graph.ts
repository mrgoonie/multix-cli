/**
 * Static check that a module can run outside Node (e.g. in a Cloudflare Worker
 * without nodejs_compat): walk the relative value imports reachable from an
 * entry file and report every reached file that imports a Node built-in or
 * dotenv, or touches `process.`.
 */

import fs from "node:fs";
import path from "node:path";

/** Same bare built-in list the Worker bundle check uses. */
const BARE_BUILTINS = (() => {
  const script = fs.readFileSync(path.resolve("worker/scripts/check-bundle.mjs"), "utf8");
  const match = /const BARE_BUILTINS =\s*"([^"]+)"/.exec(script);
  if (!match?.[1]) throw new Error("BARE_BUILTINS not found in worker/scripts/check-bundle.mjs");
  return new Set(match[1].split("|"));
})();

export interface NodeOnlyUse {
  /** Import chain from the entry file to the offending file (repo-relative). */
  chain: string[];
  problem: string;
}

/** Drop comments so prose such as "no node:* imports" is not mistaken for code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`\\])\/\/.*$/, "$1"))
    .join("\n");
}

/** Module specifiers the file loads at runtime (type-only imports and exports are skipped). */
function valueSpecifiers(code: string): string[] {
  const specs: string[] = [];
  const fromRe = /(?:^|[;}\s])(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(fromRe)) if (!m[1] && m[2]) specs.push(m[2]);
  const sideEffectRe = /(?:^|[;}\s])import\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(sideEffectRe)) if (m[1]) specs.push(m[1]);
  const callRe = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of code.matchAll(callRe)) if (m[1]) specs.push(m[1]);
  return specs;
}

function problemFor(spec: string): string | undefined {
  if (spec.startsWith("node:")) return `imports "${spec}"`;
  if (BARE_BUILTINS.has(spec)) return `imports Node built-in "${spec}"`;
  if (spec === "dotenv" || spec.startsWith("dotenv/")) return `imports "${spec}"`;
  return undefined;
}

function resolveRelative(from: string, spec: string): string {
  const base = path.resolve(path.dirname(from), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  const found = candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
  if (!found) throw new Error(`Cannot resolve ${spec} from ${from}`);
  return found;
}

/** Every Node-only use reachable from `entry` (a path relative to the repo root). */
export function findNodeOnlyUses(entry: string): NodeOnlyUse[] {
  const rel = (file: string) => path.relative(process.cwd(), file).split(path.sep).join("/");
  const uses: NodeOnlyUse[] = [];
  const seen = new Set<string>();
  const queue: Array<{ file: string; chain: string[] }> = [];
  const start = path.resolve(entry);
  queue.push({ file: start, chain: [rel(start)] });
  seen.add(start);

  while (queue.length > 0) {
    const { file, chain } = queue.shift() as { file: string; chain: string[] };
    const code = stripComments(fs.readFileSync(file, "utf8"));
    if (/\bprocess\./.test(code)) uses.push({ chain, problem: "uses process." });
    for (const spec of valueSpecifiers(code)) {
      const problem = problemFor(spec);
      if (problem) {
        uses.push({ chain, problem });
        continue;
      }
      if (!spec.startsWith(".")) continue;
      const next = resolveRelative(file, spec);
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push({ file: next, chain: [...chain, rel(next)] });
    }
  }
  return uses;
}

/** Human-readable lines for an assertion message. */
export function formatNodeOnlyUses(uses: NodeOnlyUse[]): string[] {
  return uses.map((u) => `${u.chain.join(" -> ")}: ${u.problem}`);
}
