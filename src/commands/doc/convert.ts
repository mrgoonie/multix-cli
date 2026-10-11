/**
 * Document converter — upload files to Gemini Files API and request Markdown output.
 * Mirrors document_converter.py batch_convert() + convert_to_markdown().
 * Reuses GeminiClient from providers/gemini/client.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { isTransientHttpError } from "../../core/async-poll.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import {
  type FileInput,
  STDIN_ARG,
  type StdinLike,
  labelError,
  resolveFileInputs,
} from "../../core/stdin-file.js";
import {
  type ContentPart,
  extractText,
  generateContent,
  inlinePart,
  shouldUseFileApi,
  uploadFile,
} from "../../providers/gemini/client.js";
import { isGeminiRateLimitError, withGeminiKey } from "../../providers/gemini/key-pool.js";
import { DOC_MODEL_DEFAULT } from "../../providers/gemini/models.js";
import { DEFAULT_CONVERT_PROMPT } from "./default-prompt.js";

export interface ConvertOptions {
  /** Input file paths; a single `-` reads the document from piped stdin. */
  inputs: string[];
  output?: string;
  autoName?: boolean;
  model?: string;
  prompt?: string;
  /** Extension for piped stdin when auto-detection fails (e.g. pdf). */
  stdinExt?: string;
  /** Stdin source override (tests); defaults to process.stdin. */
  stdin?: StdinLike;
  verbose?: boolean;
  logger?: Logger;
}

export interface ConvertResult {
  /** Input label: the path given, or `<stdin>` for piped input. */
  file: string;
  status: "success" | "error";
  markdown?: string;
  error?: string;
}

/** Base name used for `--auto-name` output; piped stdin has no file name, so it becomes "stdin". */
function autoNameBase(input: string): string {
  if (input === STDIN_ARG) return "stdin";
  return path.basename(input, path.extname(input));
}

export async function convertDocuments(opts: ConvertOptions): Promise<void> {
  const { output, autoName = false, verbose, logger } = opts;
  const model = opts.model ?? DOC_MODEL_DEFAULT;
  const prompt = opts.prompt ?? DEFAULT_CONVERT_PROMPT;

  // Checks that real files exist before reading stdin, then materializes `-`.
  const { inputs, cleanup } = await resolveFileInputs(opts.inputs, {
    stdinExt: opts.stdinExt,
    input: opts.stdin,
    flag: "--input",
    example: "cat report.pdf | multix doc convert --input -",
    extExample: "pdf",
  });

  let failed: number;
  try {
    // Resolved only after input validation so a rejected run leaves no empty output dir.
    let outputPath: string;
    if (output) {
      outputPath = path.resolve(output);
    } else if (autoName && opts.inputs.length === 1 && opts.inputs[0]) {
      outputPath = path.join(getOutputDir(), `${autoNameBase(opts.inputs[0])}-extraction.md`);
    } else {
      outputPath = path.join(getOutputDir(), "document-extraction.md");
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    failed = await convertResolved(inputs, { outputPath, model, prompt, verbose, logger });
  } finally {
    cleanup();
  }
  if (failed > 0) process.exit(1);
}

/** Convert resolved inputs, write the combined Markdown, and return the failure count. */
async function convertResolved(
  inputs: FileInput[],
  ctx: { outputPath: string; model: string; prompt: string; verbose?: boolean; logger?: Logger },
): Promise<number> {
  const { outputPath, model, prompt, verbose, logger } = ctx;
  const results: ConvertResult[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i] as FileInput;
    const filePath = input.path;
    logger?.debug(`[${i + 1}/${inputs.length}] Converting: ${input.label}`);

    let markdown: string | undefined;
    let errorMsg: string | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // One key per file: an uploaded file only exists for the key that uploaded it.
        const resp = await withGeminiKey(
          async (apiKey) => {
            const useApi = shouldUseFileApi(filePath);
            let contentParts: ContentPart[];

            if (useApi) {
              logger?.debug("File >20MB — using Files API");
              const ref = await uploadFile(filePath, { logger, apiKey });
              contentParts = [
                { text: prompt },
                { fileData: { mimeType: ref.mimeType, fileUri: ref.uri } },
              ];
            } else {
              contentParts = [{ text: prompt }, inlinePart(filePath)];
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

        markdown = extractText(resp);
        break;
      } catch (e) {
        errorMsg = labelError(e instanceof Error ? e.message : String(e), input);
        // Key rotation already tried every ready key; retrying would only repeat uploads.
        if (isGeminiRateLimitError(e)) break;
        // Only network failures/timeouts (status 0), 408, 429 and 5xx are retried. Config,
        // validation, provider (e.g. refused redirect, timed-out byte upload) and other 4xx
        // errors fail the same way on every attempt.
        if (!isTransientHttpError(e)) break;
        if (attempt < 2) {
          const wait = 2 ** attempt * 1000;
          logger?.debug(`Retry ${attempt + 1} after ${wait / 1000}s: ${errorMsg}`);
          await sleep(wait);
        }
      }
    }

    if (markdown === undefined) {
      logger?.error(`Failed: ${input.label} — ${errorMsg}`);
    }

    results.push({
      file: input.label,
      status: markdown !== undefined ? "success" : "error",
      markdown,
      error: errorMsg,
    });

    logger?.debug(`Status: ${results[results.length - 1]?.status}`);
  }

  // Write combined output
  const lines: string[] = ["# Document Extraction Results\n"];
  lines.push(`Converted ${inputs.length} document(s) to markdown.\n\n---\n`);

  for (const r of results) {
    // Escape angle brackets so "<stdin>" does not render as an HTML tag.
    lines.push(`\n## ${path.basename(r.file).replace(/[<>]/g, "\\$&")}\n`);
    if (r.status === "success" && r.markdown) {
      lines.push(`${r.markdown}\n`);
    } else if (r.status === "success") {
      lines.push("**Note**: Conversion succeeded but no content was returned.\n");
    } else {
      lines.push(`**Error**: ${r.error ?? "Unknown error"}\n`);
    }
    lines.push("\n---\n");
  }

  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");

  const succeeded = results.filter((r) => r.status === "success").length;
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Converted: ${results.length} file(s)`);
  console.log(`Success: ${succeeded}`);
  console.log(`Failed: ${results.length - succeeded}`);
  console.log(`Output saved to: ${outputPath}`);

  if (verbose) {
    for (const r of results) {
      console.log(`  [${r.status}] ${r.file}`);
    }
  }

  return results.length - succeeded;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
