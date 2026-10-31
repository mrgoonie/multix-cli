import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";

const readDist = (path) => readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");

const contentDir = new URL("../src/content/docs/", import.meta.url);

// Every English page in the content tree; the Vietnamese tree under vi/ mirrors it.
const documentationRoutes = (await readdir(contentDir, { recursive: true }))
  .map((path) => path.replaceAll("\\", "/"))
  .filter((path) => path.endsWith(".md") && !path.startsWith("vi/"))
  .map((path) => path.slice(0, -".md".length))
  .sort();

test("build emits canonical Markdown routes and AI discovery files", async () => {
  const [page, markdown, llms, robots] = await Promise.all([
    readDist("commands/gemini/index.html"),
    readDist("commands/gemini.md"),
    readDist("llms.txt"),
    readDist("robots.txt"),
  ]);

  assert.match(page, /<link rel="canonical" href="https:\/\/multix\.zuey\.me\/commands\/gemini\//);
  assert.match(page, /data-open-modal/);
  assert.match(page, /Copy to clipboard/);
  assert.match(markdown, /^---\ntitle: Gemini commands/m);
  assert.match(llms, /https:\/\/multix\.zuey\.me\/commands\/gemini\.md/);
  assert.match(robots, /Sitemap: https:\/\/multix\.zuey\.me\/sitemap-index\.xml/);
});

test("build includes Vietnamese, structured data, the required footer, and the banner", async () => {
  const [english, vietnamese, vietnameseMarkdown, overview, readme, banner] = await Promise.all([
    readDist("getting-started/index.html"),
    readDist("vi/getting-started/index.html"),
    readDist("vi/getting-started.md"),
    readDist("index.html"),
    readFile(new URL("../../README.md", import.meta.url), "utf8"),
    stat(new URL("../public/images/multix-isometric-banner.png", import.meta.url)),
  ]);

  assert.match(english, /"@type":"WebSite"/);
  assert.match(english, /Made with.*AgentKit\.best/);
  assert.match(english, /@goon_nguyen \(X\)/);
  assert.match(vietnamese, /lang="vi"/);
  assert.match(vietnameseMarkdown, /^---\ntitle: Cài đặt và cấu hình/m);
  // The landing page replaced the splash banner; it remains the social preview image.
  assert.doesNotMatch(overview, /<img[^>]*multix-isometric-banner\.png/);
  assert.match(
    overview,
    /<meta property="og:image" content="[^"]*images\/multix-isometric-banner\.png"/,
  );
  assert.match(readme, /docs-site\/public\/images\/multix-isometric-banner\.png/);
  assert.ok(banner.size > 0);
});

test("every published English page has Vietnamese and Markdown counterparts", async () => {
  const output = await Promise.all(
    documentationRoutes.flatMap((route) => [
      readDist(`${route}.md`),
      readDist(`vi/${route}.md`),
      readDist(`${route === "index" ? "index" : `${route}/index`}.html`),
      readDist(`vi/${route === "index" ? "index" : `${route}/index`}.html`),
    ]),
  );

  assert.equal(output.length, documentationRoutes.length * 4);
});

test("provider pages retain command caveats and asynchronous workflows", async () => {
  const [
    directory,
    minimax,
    openrouter,
    leonardo,
    byteplus,
    cloudflare,
    elevenlabs,
    agentGuide,
    vietnameseMinimax,
    vietnameseAgentGuide,
    llms,
  ] = await Promise.all([
    readDist("commands/providers.md"),
    readDist("commands/minimax.md"),
    readDist("commands/openrouter.md"),
    readDist("commands/leonardo.md"),
    readDist("commands/byteplus.md"),
    readDist("commands/cloudflare.md"),
    readDist("commands/elevenlabs.md"),
    readDist("reference/for-ai-agents.md"),
    readDist("vi/commands/minimax.md"),
    readDist("vi/reference/for-ai-agents.md"),
    readDist("llms.txt"),
  ]);

  assert.match(directory, /commands\/minimax/);
  assert.match(minimax, /not free-form editing/);
  assert.match(openrouter, /--image-url/);
  assert.match(openrouter, /video-status <jobId> --download/);
  assert.match(leonardo, /existing Leonardo image ID/);
  assert.match(byteplus, /reference-to-video/);
  assert.match(byteplus, /generate-3d/);
  assert.match(byteplus, /status <taskId> --wait --download/);
  assert.match(cloudflare, /CLOUDFLARE_AI_GATEWAY_ID/);
  assert.match(cloudflare, /cloudflare video-status <predictionId>/);
  assert.match(elevenlabs, /create-from-preview/);
  assert.match(elevenlabs, /dub-status <dubbingId> --download es/);
  assert.match(vietnameseMinimax, /không phải chỉnh ảnh tự do/);
  for (const provider of [
    "gemini",
    "openai",
    "minimax",
    "openrouter",
    "leonardo",
    "byteplus",
    "cloudflare",
    "elevenlabs",
    "fal",
    "atlascloud",
    "replicate",
    "runway",
    "heygen",
    "sume",
    "topview",
  ]) {
    assert.match(agentGuide, new RegExp(`/commands/${provider}/`));
    assert.match(vietnameseAgentGuide, new RegExp(`/vi/commands/${provider}/`));
    assert.match(llms, new RegExp(`commands/${provider}\\.md`));
  }
});

test("llms.txt links every English page", async () => {
  assert.ok(documentationRoutes.includes("commands/gemini"));
  const llms = await readDist("llms.txt");
  for (const route of documentationRoutes) {
    assert.ok(
      llms.includes(`(https://multix.zuey.me/${route}.md)`),
      `llms.txt is missing ${route}.md`,
    );
  }
  for (const [, route] of llms.matchAll(/\(https:\/\/multix\.zuey\.me\/(.+?)\.md\)/g)) {
    assert.ok(documentationRoutes.includes(route), `llms.txt links a missing page: ${route}.md`);
  }
});

test("media and document guides explain the local executable prerequisites", async () => {
  const [english, vietnamese] = await Promise.all([
    readDist("commands/media-and-documents.md"),
    readDist("vi/commands/media-and-documents.md"),
  ]);

  for (const guide of [english, vietnamese]) {
    assert.match(guide, /ffmpeg -version/);
    assert.match(guide, /magick -version/);
    assert.match(guide, /brew install ffmpeg imagemagick/);
    assert.match(guide, /winget install -e --id ImageMagick\.ImageMagick/);
  }
});

test("every docs page is covered by a CSP that allows only first-party scripts", async () => {
  const { inlineScriptHashes } = await import("../scripts/write-security-headers.mjs");
  const headers = await readDist("_headers");
  const csp = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? "";
  assert.match(headers, /^\/\*$/m);
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' /);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(csp, /https?:/);
  // The MCP dashboard shares this origin: every inline script must be allowed by hash.
  const pages = ["404.html"];
  for (const route of documentationRoutes) {
    const path = route === "index" ? "index.html" : `${route}/index.html`;
    pages.push(path, `vi/${path}`);
  }
  for (const path of pages) {
    for (const hash of inlineScriptHashes(await readDist(path))) {
      assert.ok(csp.includes(hash), `${path}: ${hash}`);
    }
  }
});

test("inline script detection skips only external and JSON-LD scripts", async () => {
  const { inlineScriptHashes } = await import("../scripts/write-security-headers.mjs");
  const html = [
    '<script src="/a.js"></script>',
    '<script type="module" src="/b.js"></script>',
    '<script type="application/ld+json">{}</script>',
    "<script>one()</script>",
    '<script data-src="/lazy.js">two()</script>',
  ].join("");
  assert.equal(inlineScriptHashes(html).size, 2);
});
