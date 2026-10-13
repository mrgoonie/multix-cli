#!/usr/bin/env node
// Stand-in for the multix binary in job-runner tests: reports what it received,
// echoes a key to stderr (to prove redaction) and writes files to MULTIX_OUTPUT_DIR.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const out = process.env.MULTIX_OUTPUT_DIR;
const input = argv.map((a) => a.replace(/^--[a-z-]+=/, "")).find((a) => a.startsWith("in/"));
console.log(
  JSON.stringify({
    argv,
    cwd: process.cwd(),
    home: process.env.HOME,
    out,
    disableHomeEnv: process.env.MULTIX_DISABLE_HOME_ENV,
    envNames: Object.keys(process.env).sort(),
    input: input && existsSync(input) ? readFileSync(input, "utf8") : null,
  }),
);
console.error(`using key ${process.env.GEMINI_API_KEY}`);
writeFileSync(join(out, "result.txt"), "hello");
mkdirSync(join(out, "nested"));
writeFileSync(join(out, "nested", "result.txt"), "again");
if (argv.includes("--sleep")) await new Promise((r) => setTimeout(r, 30_000));
// A key that straddles the 16 KB cut of stderr's tail.
if (argv.includes("--key-at-cut")) {
  process.stderr.write(`${process.env.GEMINI_API_KEY}${"x".repeat(16 * 1024 - 8)}`);
}
// More than the 16 MB output buffer.
if (argv.includes("--flood")) {
  const chunk = "y".repeat(1024 * 1024);
  for (let i = 0; i < 20; i++) process.stdout.write(chunk);
  await new Promise((r) => setTimeout(r, 5_000));
}
process.exit(argv.includes("--fail") ? 3 : 0);
