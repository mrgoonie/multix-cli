#!/usr/bin/env node
// Stand-in for the multix binary in job-runner tests: reports what it received,
// echoes a key to stderr (to prove redaction) and writes files to MULTIX_OUTPUT_DIR.
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
    envNames: Object.keys(process.env).sort(),
    input: input && existsSync(input) ? readFileSync(input, "utf8") : null,
  }),
);
console.error(`using key ${process.env.GEMINI_API_KEY}`);
writeFileSync(join(out, "result.txt"), "hello");
mkdirSync(join(out, "nested"));
writeFileSync(join(out, "nested", "result.txt"), "again");
// A run-ledger line like the CLI's, full of things that must not leave the container.
if (process.env.MULTIX_HISTORY_FILE && argv.includes("--ledger")) {
  const entry = {
    v: 1,
    id: "h_test",
    ts: new Date().toISOString(),
    duration_ms: 1234,
    cwd: process.cwd(),
    version: "0.0.0-test",
    command: "gemini generate",
    provider: "gemini",
    model: "gemini-2.5-flash",
    argv,
    ok: false,
    exit_code: 1,
    error: { code: "provider_error", message: "SECRET-ERROR-MESSAGE at /home/user/private" },
    outputs: [
      { path: join(out, "result.txt"), bytes: 5, mime: "text/plain", sha256: "a".repeat(64) },
      { path: "out/nested/result.txt", bytes: 5, sha256: "not-a-hash", duration_s: 2.5 },
      { path: join(out, "..", "history.jsonl"), bytes: 10 },
      { path: "/etc/passwd", bytes: 1 },
    ],
    usage: {
      tokens: { input: 100, output: 50, total: 150, thinking: -1 },
      cost_usd: 0.0125,
      credits: 3,
      metrics: { "images.count": 2, bad: "x", inf: null },
    },
    http: { requests: 2, errors: 0, ms: 840 },
    provider_ids: ["req_abc123", "https://signed.example.com/x?sig=1", "a b", "x".repeat(200)],
  };
  appendFileSync(process.env.MULTIX_HISTORY_FILE, `${JSON.stringify(entry)}\n`);
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
