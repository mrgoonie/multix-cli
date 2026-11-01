#!/usr/bin/env node
// Stand-in for the multix binary in the standalone job tests. A prompt that
// contains "hold" keeps the process running until it is stopped (cancel,
// shutdown); it then takes a moment to exit, like a CLI waiting on its own
// children. A "pid=<path>" word in the prompt writes the process id there.
// Any other prompt writes one output file and exits. It echoes the provider
// key to stderr to prove that the server redacts it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const EXIT_DELAY_MS = 600;

const argv = process.argv.slice(2);
console.error(`using key ${process.env.GEMINI_API_KEY}`);
const pidFile = argv.join(" ").match(/\bpid=(\S+)/)?.[1];
if (pidFile) writeFileSync(pidFile, String(process.pid));
if (argv.some((a) => a.includes("hold"))) {
  process.on("SIGTERM", () => setTimeout(() => process.exit(143), EXIT_DELAY_MS));
  await new Promise((resolve) => setTimeout(resolve, 120_000));
}
writeFileSync(join(process.env.MULTIX_OUTPUT_DIR, "image.png"), "png");
console.log("done");
