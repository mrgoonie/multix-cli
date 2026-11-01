#!/usr/bin/env node
// Stand-in for the multix binary in the standalone job tests. A prompt that
// contains "hold" keeps the process running until it is stopped (cancel,
// shutdown); any other prompt writes one output file and exits. It echoes the
// provider key to stderr to prove that the server redacts it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
console.error(`using key ${process.env.GEMINI_API_KEY}`);
if (argv.some((a) => a.includes("hold"))) {
  await new Promise((resolve) => setTimeout(resolve, 120_000));
}
writeFileSync(join(process.env.MULTIX_OUTPUT_DIR, "image.png"), "png");
console.log("done");
