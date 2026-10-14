/**
 * /api/docs: a readable reference of the REST API, rendered from the same
 * OpenAPI document served at /api/v1/openapi.json, so the two cannot drift.
 * Server-rendered like every other page; its examples have copy buttons.
 */

import { openApiDocument } from "../api/openapi-document.js";
import { escapeHtml } from "../http-responses.js";
import { copyBlock } from "./copy-button.js";
import { page } from "./page-layout.js";

type Json = Record<string, unknown>;

const METHODS = ["get", "put", "patch", "post", "delete"] as const;

function exampleOf(operation: Json): unknown {
  const body = operation.requestBody as Json | undefined;
  const content = body?.content as Record<string, Json> | undefined;
  return content?.["application/json"]?.example;
}

function curlFor(base: string, method: string, path: string, example: unknown): string {
  const lines = [
    `curl -X ${method.toUpperCase()} ${base}${path.replace(/\{(\w+)\}/g, (_, name: string) => `$${name.toUpperCase()}`)} \\`,
  ];
  lines.push(`  -H "Authorization: Bearer $MULTIX_API_KEY"${example === undefined ? "" : " \\"}`);
  if (example !== undefined) {
    // Body on stdin, so values substituted from the environment stay out of the process list.
    lines.push(`  -H "Content-Type: application/json" \\`);
    lines.push("  --data @- <<JSON", JSON.stringify(example), "JSON");
  }
  return lines.join("\n");
}

function statusList(operation: Json): string {
  const responses = Object.entries((operation.responses as Json) ?? {});
  return responses
    .map(([status, value]) => {
      const response = value as Json;
      const refName =
        typeof response.$ref === "string" ? response.$ref.split("/").pop() : undefined;
      const description = refName ?? String(response.description ?? "");
      return `<span class="mono">${escapeHtml(status)}</span> ${escapeHtml(description)}`;
    })
    .join(" · ");
}

function operationCard(base: string, path: string, method: string, operation: Json): string {
  const description = operation.description
    ? `<p class="muted"><small>${escapeHtml(String(operation.description))}</small></p>`
    : "";
  return `<div class="secret">
<div class="secret-head"><div><span class="badge ok mono">${method.toUpperCase()}</span> <span class="mono">/api/v1${escapeHtml(path)}</span></div></div>
<p><strong>${escapeHtml(String(operation.summary ?? ""))}</strong></p>
${description}
${copyBlock(curlFor(base, method, path, exampleOf(operation)), `${method.toUpperCase()} ${path} example`)}
<p class="muted"><small>${statusList(operation)}</small></p>
</div>`;
}

export function apiDocsPage(origin: string): string {
  const doc = openApiDocument(origin);
  const base = `${origin}/api/v1`;
  const paths = doc.paths as Record<string, Json>;
  const operations = Object.entries(paths)
    .flatMap(([path, item]) =>
      METHODS.filter((m) => item[m]).map((m) => operationCard(base, path, m, item[m] as Json)),
    )
    .join("");
  const info = doc.info as Json;
  return page(
    "multix REST API",
    `<section class="card">
<h1>multix REST API</h1>
<p>${escapeHtml(String(info.description))}</p>
<p class="muted"><small>Base URL <span class="mono">${escapeHtml(base)}</span> · machine-readable spec: <a href="/api/v1/openapi.json">/api/v1/openapi.json</a> · create keys in <a href="/dashboard">/dashboard</a></small></p>
${copyBlock("export MULTIX_API_KEY='paste the key from /dashboard here'", "export command")}
<p class="muted"><small>Errors are JSON: <span class="mono">{"error":{"code":"bad_request","message":"…"}}</span>. Requests share the per-account rate limit of the MCP endpoint.</small></p>
</section>
<section class="card">
<h2>Endpoints</h2>
${operations}
</section>`,
  );
}
