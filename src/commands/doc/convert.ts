/**
 * Document converter — upload files to Gemini Files API and request Markdown output.
 * Mirrors document_converter.py batch_convert() + convert_to_markdown().
 * Reuses GeminiClient from providers/gemini/client.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { ValidationError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import { getOutputDir } from "../../core/output-dir.js";
import {
  type ContentPart,
  extractText,
  generateContent,
  inlinePart,
  shouldUseFileApi,
  uploadFile,
} from "../../providers/gemini/client.js";
import { DOC_MODEL_DEFAULT } from "../../providers/gemini/models.js";
import { DEFAULT_CONVERT_PROMPT } from "./default-prompt.js";

export interface ConvertOptions {
  inputs: string[];
  output?: string;
  autoName?: boolean;
  model?: string;
  prompt?: string;
  verbose?: boolean;
  logger?: Logger;
}

export interface ConvertResult {
  file: string;
  status: "success" | "error";
  markdown?: string;
  error?: string;
}

export async function convertDocuments(opts: ConvertOptions): Promise<void> {
  const { inputs, output, autoName = false, verbose, logger } = opts;
  const model = opts.model ?? DOC_MODEL_DEFAULT;
  const prompt = opts.prompt ?? DEFAULT_CONVERT_PROMPT;

  // Validate all inputs exist
  for (const f of inputs) {
    if (!fs.existsSync(f)) throw new ValidationError(`Input file not found: ${f}`);
  }

  // Resolve output path
  let outputPath: string;
  if (output) {
    outputPath = path.resolve(output);
  } else if (autoName && inputs.length === 1 && inputs[0]) {
    const base = path.basename(inputs[0], path.extname(inputs[0]));
    outputPath = path.join(getOutputDir(), `${base}-extraction.md`);
  } else {
    outputPath = path.join(getOutputDir(), "document-extraction.md");
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  // Process each file
  const results: ConvertResult[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const filePath = inputs[i] as string;
    logger?.debug(`[${i + 1}/${inputs.length}] Converting: ${filePath}`);

    let markdown: string | undefined;
    let errorMsg: string | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const useApi = shouldUseFileApi(filePath);
        let contentParts: ContentPart[];

        if (useApi) {
          logger?.debug("File >20MB — using Files API");
          const ref = await uploadFile(filePath, { logger });
          contentParts = [
            { text: prompt },
            { fileData: { mimeType: ref.mimeType, fileUri: ref.uri } },
          ];
        } else {
          contentParts = [{ text: prompt }, inlinePart(filePath)];
        }

        const resp = await generateContent({
          model,
          contents: [{ parts: contentParts }],
        });

        markdown = extractText(resp);
        break;
      } catch (e) {
        errorMsg = e instanceof Error ? e.message : String(e);
        if (attempt < 2) {
          const wait = 2 ** attempt * 1000;
          logger?.debug(`Retry ${attempt + 1} after ${wait / 1000}s: ${errorMsg}`);
          await sleep(wait);
        }
      }
    }

    results.push({
      file: filePath,
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
    lines.push(`\n## ${path.basename(r.file)}\n`);
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

  const failed = results.filter((r) => r.status === "error").length;
  if (failed > 0) process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
