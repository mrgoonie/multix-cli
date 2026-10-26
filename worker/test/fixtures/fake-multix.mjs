#!/usr/bin/env node
// Stand-in for the multix binary in job-runner tests: reports what it received,
// echoes a key to stderr (to prove redaction) and writes files to MULTIX_OUTPUT_DIR.
// With --history it appends a history entry to MULTIX_HISTORY_FILE like the CLI does.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    history: process.env.MULTIX_HISTORY,
    historyFile: process.env.MULTIX_HISTORY_FILE,
    envNames: Object.keys(process.env).sort(),
    input: input && existsSync(input) ? readFileSync(input, "utf8") : null,
  }),
);
console.error(`using key ${process.env.GEMINI_API_KEY}`);
writeFileSync(join(out, "result.txt"), "hello");
mkdirSync(join(out, "nested"));
writeFileSync(join(out, "nested", "result.txt"), "again");
if (argv.includes("--history")) {
  const key = process.env.GEMINI_API_KEY;
  const entry = {
    v: 1,
    id: "h_test0001",
    ts: new Date().toISOString(),
    duration_ms: 1234.4,
    cwd: process.cwd(),
    version: "9.9.9",
    command: "gemini generate",
    provider: "gemini",
    model: `gemini-2.5-flash-${key}`,
    argv: ["gemini", "generate", `--api-key=${key}`, "secret prompt text"],
    ok: false,
    exit_code: 3,
    error: { code: "provider_error", message: `request failed for key ${key} at ${process.cwd()}` },
    outputs: [
      {
        path: join(out, "nested", "result.txt"),
        bytes: 5,
        mime: "text/plain",
        sha256: "a".repeat(64),
        duration_s: 1.5,
      },
      { path: "/abs/elsewhere/bad.bin", bytes: -1 },
    ],
    usage: {
      tokens: { input: 10, output: 20, total: 30, thinking: "lots" },
      cost_usd: 0.0012,
      credits: Number.NaN,
      metrics: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`m${i}`, i])),
    },
    http: { requests: 2, errors: 1, ms: 87.6 },
    provider_ids: [
      `op-${key}`,
      "x".repeat(200),
      42,
      ...Array.from({ length: 12 }, (_, i) => `id-${i}`),
    ],
  };
  // An older entry first, then the run, then a torn line the reader must skip.
  appendFileSync(
    process.env.MULTIX_HISTORY_FILE,
    `${JSON.stringify({ ...entry, command: "old" })}\n`,
  );
  appendFileSync(process.env.MULTIX_HISTORY_FILE, `${JSON.stringify(entry)}\n{"command":`);
}
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
