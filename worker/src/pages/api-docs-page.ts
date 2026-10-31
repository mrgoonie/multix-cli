/**
 * /api/docs: a readable reference of the REST API, rendered from the same
 * OpenAPI document served at /api/v1/openapi.json, so the two cannot drift.
 * Server-rendered like every other page; its examples have copy buttons.
 */

import { openApiDocument } from "../api/openapi-document.js";
import { escapeHtml } from "../http-responses.js";
import { copyBlock } from "./copy-button.js";
import { type Lang, messagesFor } from "./i18n.js";
import { appShell } from "./page-layout.js";
import { DEFAULT_PREFERENCES, type Preferences } from "./preferences.js";

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

function operationCard(
  base: string,
  path: string,
  method: string,
  operation: Json,
  lang: Lang,
): string {
  const label = messagesFor(lang).apiDocs.example(`${method.toUpperCase()} ${path}`);
  const description = operation.description
    ? `<p class="muted" lang="en"><small>${escapeHtml(String(operation.description))}</small></p>`
    : "";
  return `<div class="secret">
<h3 class="secret-head"><span><span class="method">${method.toUpperCase()}</span><span class="mono">/api/v1${escapeHtml(path)}</span></span></h3>
<p lang="en"><strong>${escapeHtml(String(operation.summary ?? ""))}</strong></p>
${description}
${copyBlock(curlFor(base, method, path, exampleOf(operation)), label, lang)}
<p class="muted"><small>${statusList(operation)}</small></p>
</div>`;
}

/** API reference language and theme follow the visitor; the spec's own text stays English. */
export function apiDocsPage(origin: string, prefs: Preferences = DEFAULT_PREFERENCES): string {
  const t = messagesFor(prefs.lang);
  const d = t.apiDocs;
  const doc = openApiDocument(origin);
  const base = `${origin}/api/v1`;
  const paths = doc.paths as Record<string, Json>;
  const operations = Object.entries(paths)
    .flatMap(([path, item]) =>
      METHODS.filter((m) => item[m]).map((m) =>
        operationCard(base, path, m, item[m] as Json, prefs.lang),
      ),
    )
    .join("");
  const info = doc.info as Json;
  return appShell(
    {
      title: d.title,
      prefs,
      here: "/api/docs",
      navLabel: t.nav.apiDocs,
      nav: [
        { href: "#intro", label: t.nav.gettingStarted, icon: "overview" },
        { href: "#endpoints", label: t.nav.endpoints, icon: "code" },
        { href: "/api/v1/openapi.json", label: t.nav.openapi, icon: "file" },
        { href: "/dashboard", label: t.nav.dashboard, icon: "back" },
      ],
    },
    `<section id="intro" class="intro" aria-labelledby="intro-h">
<p class="eyebrow">${escapeHtml(t.nav.apiDocs)}</p>
<h1 id="intro-h">${d.heading}</h1>
<p class="lede" lang="en">${escapeHtml(String(info.description))}</p>
</section>
<section class="card" aria-label="${escapeHtml(t.nav.gettingStarted)}">
<p class="muted"><small>${escapeHtml(d.baseUrl)} <span class="mono">${escapeHtml(base)}</span> · ${escapeHtml(d.spec)} <a href="/api/v1/openapi.json">/api/v1/openapi.json</a> · ${escapeHtml(d.createKeys)} <a href="/dashboard">/dashboard</a></small></p>
${copyBlock(d.exportCommand, d.exportLabel, prefs.lang)}
<p class="muted"><small>${d.errors}</small></p>
</section>
<section class="card" id="endpoints" aria-labelledby="endpoints-h">
<h2 id="endpoints-h">${escapeHtml(d.endpoints)}</h2>
${operations}
</section>`,
  );
}
