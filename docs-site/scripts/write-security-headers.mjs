/**
 * Post-build step: writes dist/_headers with a Content Security Policy for
 * every docs page. The docs share the multix.zuey.me origin with the MCP
 * dashboard (/dashboard, /oauth/*), so a script running here could act on the
 * dashboard; the policy allows only first-party scripts.
 *
 * Starlight and the site config emit fixed inline scripts, so each one is
 * allowed by its SHA-256 hash, computed from the built pages. Styles stay
 * 'unsafe-inline' because Expressive Code highlights code with style
 * attributes. Pagefind search needs 'wasm-unsafe-eval'.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

async function htmlFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return htmlFiles(path);
      return entry.name.endsWith(".html") ? [path] : [];
    }),
  );
  return nested.flat();
}

/** SHA-256 hashes of inline executable scripts (JSON-LD data blocks are not scripts). */
export function inlineScriptHashes(html) {
  const hashes = new Set();
  for (const match of html.matchAll(/<script(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/type="application\/ld\+json"/.test(match[1])) continue;
    hashes.add(`'sha256-${createHash("sha256").update(match[2]).digest("base64")}'`);
  }
  return hashes;
}

export function contentSecurityPolicy(scriptHashes) {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${[...scriptHashes].sort().join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

async function main() {
  const hashes = new Set();
  for (const file of await htmlFiles(dist)) {
    for (const hash of inlineScriptHashes(await readFile(file, "utf8"))) hashes.add(hash);
  }
  const headers = `/*
  Content-Security-Policy: ${contentSecurityPolicy(hashes)}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
`;
  await writeFile(join(dist, "_headers"), headers);
  console.log(`_headers: CSP with ${hashes.size} inline script hash(es)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
