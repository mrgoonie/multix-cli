import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const readDist = (path) => readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");

const documentationRoutes = [
  "index",
  "getting-started",
  "commands",
  "commands/gemini",
  "commands/openai",
  "commands/minimax",
  "commands/openrouter",
  "commands/leonardo",
  "commands/byteplus",
  "commands/cloudflare",
  "commands/elevenlabs",
  "commands/providers",
  "commands/media-and-documents",
  "reference/environment",
  "reference/output-and-troubleshooting",
  "reference/for-ai-agents",
];

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
  assert.match(overview, /images\/multix-isometric-banner\.png/);
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
  ]) {
    assert.match(agentGuide, new RegExp(`/commands/${provider}/`));
    assert.match(vietnameseAgentGuide, new RegExp(`/vi/commands/${provider}/`));
    assert.match(llms, new RegExp(`commands/${provider}\\.md`));
  }
});
