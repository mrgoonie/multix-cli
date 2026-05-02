/**
 * Format Gemini analysis/transcription results for stdout or file output.
 * Supports text | json | csv | markdown output formats.
 */

import fs from "node:fs";
import path from "node:path";

export type OutputFormat = "text" | "json" | "csv" | "markdown";

export interface AnalysisResult {
  file: string;
  status: "success" | "error";
  response?: string;
  error?: string;
}

/** Write results to stdout or a file in the requested format. */
export function formatResults(
  results: AnalysisResult[],
  format: OutputFormat,
  outputPath?: string,
): void {
  const content = renderFormat(results, format);
  if (outputPath) {
    fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
    fs.writeFileSync(outputPath, content, "utf8");
  } else {
    process.stdout.write(content);
  }
}

function renderFormat(results: AnalysisResult[], format: OutputFormat): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(results, null, 2)}\n`;
    case "csv":
      return renderCsv(results);
    case "markdown":
      return renderMarkdown(results);
    default:
      return renderText(results);
  }
}

function renderText(results: AnalysisResult[]): string {
  return results
    .map((r) => {
      const header = `[${r.file}]\nStatus: ${r.status}`;
      if (r.status === "success" && r.response) return `${header}\nResult:\n${r.response}\n`;
      if (r.status === "error") return `${header}\nError: ${r.error}\n`;
      return `${header}\n`;
    })
    .join("\n");
}

function renderCsv(results: AnalysisResult[]): string {
  const header = "file,status,response,error\n";
  const rows = results.map((r) => {
    const csvCell = (v?: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
    return [csvCell(r.file), csvCell(r.status), csvCell(r.response), csvCell(r.error)].join(",");
  });
  return `${header + rows.join("\n")}\n`;
}

function renderMarkdown(results: AnalysisResult[]): string {
  const lines = ["# Results\n"];
  for (const r of results) {
    lines.push(`## ${r.file}\n`);
    lines.push(`**Status**: ${r.status}\n`);
    if (r.status === "success" && r.response) lines.push(`**Response**:\n\n${r.response}\n`);
    if (r.status === "error") lines.push(`**Error**: ${r.error}\n`);
    lines.push("---\n");
  }
  return lines.join("\n");
}
