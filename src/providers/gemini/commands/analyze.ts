/**
 * multix gemini analyze — analyze one or more files with Gemini.
 * Supports text, image, video, audio, and document files.
 */

import fs from "node:fs";
import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { ValidationError } from "../../../core/errors.js";
import {
  generateContent,
  extractText,
  inlinePart,
  uploadFile,
  shouldUseFileApi,
} from "../client.js";
import { inferTaskFromFile } from "../task-resolver.js";
import { getDefaultModel } from "../models.js";
import { formatResults } from "../result-formatter.js";
import type { OutputFormat, AnalysisResult } from "../result-formatter.js";

export function registerAnalyzeCommand(parent: Command): void {
  parent
    .command("analyze")
    .description("Analyze files with Gemini (images, video, audio, documents)")
    .requiredOption("--files <paths...>", "Input file paths to analyze")
    .option("--prompt <text>", "Analysis prompt", "Analyze this content")
    .option("--model <id>", "Gemini model to use")
    .option("--format <fmt>", "Output format: text|json|csv|markdown", "text")
    .option("--output <path>", "Write results to file instead of stdout")
    .option("-v, --verbose", "Verbose logging")
    .action(async (opts: {
      files: string[];
      prompt: string;
      model?: string;
      format: OutputFormat;
      output?: string;
      verbose?: boolean;
    }) => {
      const logger = createLogger({ verbose: opts.verbose ?? false });
      const model = opts.model ?? getDefaultModel("analyze");

      // Validate all files exist
      for (const f of opts.files) {
        if (!fs.existsSync(f)) throw new ValidationError(`File not found: ${f}`);
      }

      const results: AnalysisResult[] = [];

      for (let i = 0; i < opts.files.length; i++) {
        const filePath = opts.files[i] as string;
        logger.debug(`[${i + 1}/${opts.files.length}] Processing: ${filePath}`);

        try {
          const useApi = shouldUseFileApi(filePath);
          let contentParts;

          if (useApi) {
            logger.debug("File >20MB — using Files API");
            const ref = await uploadFile(filePath, { logger });
            contentParts = [
              { text: opts.prompt },
              { fileData: { mimeType: ref.mimeType, fileUri: ref.uri } },
            ];
          } else {
            contentParts = [{ text: opts.prompt }, inlinePart(filePath)];
          }

          const resp = await generateContent({
            model,
            contents: [{ parts: contentParts }],
          });

          results.push({
            file: filePath,
            status: "success",
            response: extractText(resp),
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.error(`Failed: ${filePath} — ${msg}`);
          results.push({ file: filePath, status: "error", error: msg });
        }
      }

      formatResults(results, opts.format, opts.output);
      logger.debug(`Done: ${results.filter((r) => r.status === "success").length}/${results.length} succeeded`);

      const failed = results.filter((r) => r.status === "error").length;
      if (failed > 0) process.exit(1);
    });
}

// Re-export for task inference compatibility
export { inferTaskFromFile };
