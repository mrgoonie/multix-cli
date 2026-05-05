/**
 * multix elevenlabs align — forced alignment between audio and a transcript.
 * Endpoint: POST /v1/forced-alignment (multipart, sync JSON).
 */

import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { getOutputDir } from "../../../core/output-dir.js";
import { apiPostMultipart, readFileAsBlob, requireElevenLabsKey } from "../client.js";

interface AlignmentResp {
  characters?: Array<{ text: string; start: number; end: number }>;
  words?: Array<{ text: string; start: number; end: number; loss?: number }>;
  loss?: number;
}

export function registerAlignCommand(parent: Command): void {
  parent
    .command("align")
    .description("Forced alignment of audio to a transcript (returns word/char timestamps)")
    .requiredOption("--input <path>", "Source audio file")
    .requiredOption("--text <str>", "Transcript text (or pass --text-file)")
    .option("--text-file <path>", "Read transcript from file")
    .option("--output <path>", "Save JSON to this path (default: multix-output)")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const apiKey = requireElevenLabsKey();

      let text: string = opts.text;
      if (opts.textFile) text = fs.readFileSync(path.resolve(opts.textFile), "utf8");

      const form = new FormData();
      form.append("file", readFileAsBlob(opts.input));
      form.append("text", text);

      logger.debug(`Aligning ${opts.input} (${text.length} chars)`);
      const data = await apiPostMultipart<AlignmentResp>("forced-alignment", form, apiKey, {
        timeoutMs: 600_000,
      });

      const dest = opts.output
        ? path.resolve(opts.output)
        : path.join(getOutputDir(), `elevenlabs_align_${Date.now()}.json`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(data, null, 2));
      logger.success(`Saved alignment: ${dest}`);
      if (data.words) console.log(`Aligned ${data.words.length} words (loss=${data.loss ?? "?"})`);
    });
}
