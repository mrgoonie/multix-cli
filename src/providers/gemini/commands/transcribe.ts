/**
 * multix gemini transcribe — transcribe audio/video files with Gemini.
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
import { getDefaultModel } from "../models.js";
import { formatResults } from "../result-formatter.js";
import type { OutputFormat, AnalysisResult } from "../result-formatter.js";

export function registerTranscribeCommand(parent: Command): void {
  parent
    .command("transcribe")
    .description("Transcribe audio or video files with Gemini")
    .requiredOption("--files <paths...>", "Audio/video file paths to transcribe")
    .option("--prompt <text>", "Transcription prompt", "Generate a transcript with timestamps")
    .option("--model <id>", "Gemini model to use")
    .option("--format <fmt>", "Output format: text|json|csv|markdown", "text")
    .option("--output <path>", "Write results to file")
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
      const model = opts.model ?? getDefaultModel("transcribe");

      for (const f of opts.files) {
        if (!fs.existsSync(f)) throw new ValidationError(`File not found: ${f}`);
      }

      const results: AnalysisResult[] = [];

      for (let i = 0; i < opts.files.length; i++) {
        const filePath = opts.files[i] as string;
        logger.debug(`[${i + 1}/${opts.files.length}] Transcribing: ${filePath}`);

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

      const failed = results.filter((r) => r.status === "error").length;
      if (failed > 0) process.exit(1);
    });
}
