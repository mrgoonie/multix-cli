/**
 * Registers the `doc` command group: convert.
 */

import type { Command } from "commander";
import { createLogger } from "../../core/logger.js";
import { DOC_MODEL_DEFAULT } from "../../providers/gemini/models.js";
import { convertDocuments } from "./convert.js";

export function registerDocCommands(program: Command): void {
  const doc = program
    .command("doc")
    .description("Document operations: convert PDFs, images, Office docs to Markdown via Gemini");

  doc
    .command("convert")
    .description("Convert documents to Markdown using Gemini Files API")
    .requiredOption(
      "--input <files...>",
      "Input file(s) to convert",
      (val, prev: string[]) => [...prev, val],
      [],
    )
    .alias("-i")
    .option("--output <path>", "Output markdown file path")
    .option("--auto-name", "Derive output filename from input basename (single file only)")
    .option("--model <id>", `Gemini model to use (default: ${DOC_MODEL_DEFAULT})`)
    .option("--prompt <text>", "Custom conversion prompt")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        input: string[];
        output?: string;
        autoName?: boolean;
        model?: string;
        prompt?: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });

        await convertDocuments({
          inputs: opts.input,
          output: opts.output,
          autoName: opts.autoName,
          model: opts.model,
          prompt: opts.prompt,
          verbose: opts.verbose,
          logger,
        });
      },
    );
}
