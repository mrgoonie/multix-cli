/**
 * multix gemini analyze — analyze one or more files with Gemini.
 * Supports text, image, video, audio, and document files.
 */

import type { Command } from "commander";
import { createLogger } from "../../../core/logger.js";
import { type FileInput, labelError, resolveFileInputs } from "../../../core/stdin-file.js";
import { type ContentPart, extractText, generateContent } from "../client.js";
import { withGeminiKey } from "../key-pool.js";
import { inlinePart, shouldUseFileApi, uploadLocalFile } from "../local-files.js";
import { getDefaultModel } from "../models.js";
import { formatResults } from "../result-formatter.js";
import type { AnalysisResult, OutputFormat } from "../result-formatter.js";
import { inferTaskFromFile } from "../task-resolver.js";

export function registerAnalyzeCommand(parent: Command): void {
  parent
    .command("analyze")
    .description("Analyze files with Gemini (images, video, audio, documents)")
    .requiredOption("--files <paths...>", "Input file paths to analyze (use - to read piped stdin)")
    .option("--stdin-ext <ext>", "Extension for piped stdin when auto-detection fails (e.g. mp3)")
    .option("--prompt <text>", "Analysis prompt", "Analyze this content")
    .option("--model <id>", "Gemini model to use")
    .option("--format <fmt>", "Output format: text|json|csv|markdown", "text")
    .option("--output <path>", "Write results to file instead of stdout")
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
        const model = opts.model ?? getDefaultModel("analyze");

        const { inputs, cleanup } = await resolveFileInputs(opts.files, {
          stdinExt: opts.stdinExt,
        });

        const results: AnalysisResult[] = [];

        for (let i = 0; i < inputs.length; i++) {
          const { path: filePath, label } = inputs[i] as FileInput;
          logger.debug(`[${i + 1}/${inputs.length}] Processing: ${label}`);

          try {
            // One key per file: an uploaded file only exists for the key that uploaded it.
            const resp = await withGeminiKey(
              async (apiKey) => {
                const useApi = shouldUseFileApi(filePath);
                let contentParts: ContentPart[];

                if (useApi) {
                  logger.debug("File >20MB — using Files API");
                  const ref = await uploadLocalFile(filePath, { logger, apiKey });
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
                  },
                  { apiKey },
                );
              },
              { logger },
            );

            results.push({
              file: label,
              status: "success",
              response: extractText(resp),
            });
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
        logger.debug(
          `Done: ${results.filter((r) => r.status === "success").length}/${results.length} succeeded`,
        );

        const failed = results.filter((r) => r.status === "error").length;
        if (failed > 0) process.exit(1);
      },
    );
}

// Re-export for task inference compatibility
export { inferTaskFromFile };
