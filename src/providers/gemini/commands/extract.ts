/**
 * multix gemini extract — extract structured information from files with Gemini.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { type FileInput, labelError, resolveFileInputs } from "../../../core/stdin-file.js";
import {
  type ContentPart,
  extractText,
  generateContent,
  inlinePart,
  shouldUseFileApi,
  uploadFile,
} from "../client.js";
import { withGeminiKey } from "../key-pool.js";
import { getDefaultModel } from "../models.js";
import { formatResults } from "../result-formatter.js";
import type { AnalysisResult, OutputFormat } from "../result-formatter.js";

export function registerExtractCommand(parent: Command): void {
  parent
    .command("extract")
    .description("Extract structured information from files with Gemini")
    .requiredOption("--files <paths...>", "Input file paths (use - to read piped stdin)")
    .option("--stdin-ext <ext>", "Extension for piped stdin when auto-detection fails (e.g. mp3)")
    .requiredOption("--prompt <text>", "Extraction prompt (required)")
    .option("--model <id>", "Gemini model to use")
    .option("--format <fmt>", "Output format: text|json|csv|markdown", "text")
    .option("--output <path>", "Write results to file")
    .option("-v, --verbose", "Verbose logging")
    .action(
      async (opts: {
        files: string[];
        stdinExt?: string;
        prompt: string;
        model?: string;
        format: OutputFormat;
        output?: string;
        verbose?: boolean;
      }) => {
        const logger = createLogger({ verbose: opts.verbose ?? false });
        const model = opts.model ?? getDefaultModel("extract");

        const { inputs, cleanup } = await resolveFileInputs(opts.files, {
          stdinExt: opts.stdinExt,
        });

        const generationConfig =
          opts.format === "json" ? { responseMimeType: "application/json" } : undefined;

        const results: AnalysisResult[] = [];

        for (let i = 0; i < inputs.length; i++) {
          const { path: filePath, label } = inputs[i] as FileInput;
          logger.debug(`[${i + 1}/${inputs.length}] Extracting: ${label}`);

          try {
            // One key per file: an uploaded file only exists for the key that uploaded it.
            const resp = await withGeminiKey(
              async (apiKey) => {
                const useApi = shouldUseFileApi(filePath);
                let contentParts: ContentPart[];

                if (useApi) {
                  const ref = await uploadFile(filePath, { logger, apiKey });
                  contentParts = [
                    { text: opts.prompt },
                    { fileData: { mimeType: ref.mimeType, fileUri: ref.uri } },
                  ];
                } else {
                  contentParts = [{ text: opts.prompt }, inlinePart(filePath)];
                }

                return generateContent(
                  {
                    model,
                    contents: [{ parts: contentParts }],
                    generationConfig,
                  },
                  { apiKey },
                );
              },
              { logger },
            );

            results.push({ file: label, status: "success", response: extractText(resp) });
          } catch (e) {
            const msg = labelError(
              e instanceof Error ? e.message : String(e),
              inputs[i] as FileInput,
            );
            logger.error(`Failed: ${label} — ${msg}`);
            results.push({ file: label, status: "error", error: msg });
          }
        }

        formatResults(results, opts.format, opts.output);
        cleanup();

        const failed = results.filter((r) => r.status === "error").length;
        if (failed > 0) process.exit(1);
      },
    );
}
