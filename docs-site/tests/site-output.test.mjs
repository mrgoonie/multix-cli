import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readDist = (path) => readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");

const documentationRoutes = [
  "index",
  "getting-started",
  "commands",
  "commands/gemini",
  "commands/openai",
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

test("build includes Vietnamese, structured data, and the required footer", async () => {
  const [english, vietnamese, vietnameseMarkdown] = await Promise.all([
    readDist("getting-started/index.html"),
    readDist("vi/getting-started/index.html"),
    readDist("vi/getting-started.md"),
  ]);

  assert.match(english, /"@type":"WebSite"/);
  assert.match(english, /Made with.*AgentKit\.best/);
  assert.match(english, /@goon_nguyen \(X\)/);
  assert.match(vietnamese, /lang="vi"/);
  assert.match(vietnameseMarkdown, /^---\ntitle: Cài đặt và cấu hình/m);
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

test("provider reference covers registered asynchronous and account commands", async () => {
  const providers = await readDist("commands/providers.md");

  for (const command of [
    "multix leonardo video-models",
    "multix leonardo image-to-video <imageId>",
    "multix leonardo variation <variationId>",
    "multix byteplus status <taskId> --wait --download",
    "multix elevenlabs voices create-from-preview",
    "multix elevenlabs dub-status <dubbingId> --download es",
    "multix elevenlabs account",
    "multix elevenlabs models",
  ]) {
    assert.match(providers, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
