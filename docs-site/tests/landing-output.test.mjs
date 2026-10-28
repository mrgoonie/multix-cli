import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";

const readDist = (path) => readFile(new URL(`../dist/${path}`, import.meta.url), "utf8");
const pages = { en: await readDist("index.html"), vi: await readDist("vi/index.html") };

const jsonLd = (html) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap(
    ([, body]) => JSON.parse(body),
  );

test("the landing page replaces the docs splash in both languages", () => {
  for (const html of Object.values(pages)) {
    assert.doesNotMatch(html, /data-pagefind-body/, "Starlight rendered / instead of the landing");
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1);
    assert.match(html, /<main id="main">/);
    assert.match(html, /<nav class="mx-nav"/);
    assert.match(html, /<footer class="mx-footer">/);
  }
  assert.match(pages.en, /<html lang="en"/);
  assert.match(pages.vi, /<html lang="vi"/);
});

test("headline and subline", () => {
  const text = (html) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)[1].replace(/<[^>]+>|\s+/g, " ");
  assert.match(text(pages.en), /Give every AI agent\s+eyes, ears, a voice —\s+and imagination\./);
  assert.match(pages.en, /<em>and imagination\.<\/em>/);
  assert.match(
    text(pages.vi),
    /Cho mọi AI agent\s+đôi mắt, đôi tai, giọng nói —\s+và trí tưởng tượng\./,
  );
  assert.match(pages.vi, /<em>và trí tưởng tượng\.<\/em>/);
  assert.match(pages.en, /Unlock multimodal for every AI agent/);
  assert.match(pages.en, /17 providers behind one CLI, one MCP server and one REST API/);
});

test("canonical, hreflang alternates and social meta", () => {
  for (const [lang, html] of Object.entries(pages)) {
    const canonical = lang === "vi" ? "https://multix.zuey.me/vi/" : "https://multix.zuey.me/";
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonical}"`));
    assert.match(html, /<link rel="alternate" hreflang="en" href="https:\/\/multix\.zuey\.me\/"/);
    assert.match(
      html,
      /<link rel="alternate" hreflang="vi" href="https:\/\/multix\.zuey\.me\/vi\/"/,
    );
    assert.match(
      html,
      /<link rel="alternate" hreflang="x-default" href="https:\/\/multix\.zuey\.me\/"/,
    );
    assert.match(html, /<meta property="og:title"/);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
  }
});

test("blocking theme script reads Starlight's key; only / redirects Vietnamese browsers", () => {
  for (const html of Object.values(pages)) {
    const head = html.slice(0, html.indexOf("</head>"));
    assert.match(
      head,
      /<script>[^<]*localStorage\.getItem\("starlight-theme"\)[^<]*dataset\.theme/,
    );
    // The theme script runs before the inlined styles paint anything.
    assert.ok(head.indexOf("<style>") > head.indexOf("starlight-theme"));
    assert.doesNotMatch(head, /rel="stylesheet"/);
  }
  assert.match(pages.en, /multix-lang[\s\S]*?location\.replace\(`\/vi\//);
  assert.doesNotMatch(pages.vi, /location\.replace/);
});

test("JSON-LD describes the website and the application", () => {
  for (const html of Object.values(pages)) {
    const types = jsonLd(html).map((item) => item["@type"]);
    assert.ok(types.includes("WebSite"));
    assert.ok(types.includes("SoftwareApplication"));
  }
});

test("the hero poster is in the HTML, so it shows without JS or WebGL", async () => {
  for (const html of Object.values(pages)) {
    for (const theme of ["dark", "light"]) {
      assert.match(
        html,
        new RegExp(
          `<img class="mx-poster mx-poster-${theme}" src="/hero/head-poster-${theme}\\.png" alt="[^"]+"`,
        ),
      );
    }
    assert.match(html, /data-points="\/hero\/head-points\.bin"/);
    assert.match(html, /<button[^>]*id="mx-unlock"[^>]*hidden/);
  }
  const [points, manifest] = await Promise.all([
    stat(new URL("../dist/hero/head-points.bin", import.meta.url)),
    readDist("hero/head-points.json").then(JSON.parse),
    stat(new URL("../dist/hero/head-poster-dark.png", import.meta.url)),
    stat(new URL("../dist/hero/head-poster-light.png", import.meta.url)),
  ]);
  // Float32 [x, y, z, region] per point, with the anchors the renderer pins labels to.
  assert.equal(manifest.version, 1);
  assert.equal(manifest.stride, 4);
  assert.equal(points.size, manifest.count * 16);
  for (const anchor of ["eyes", "ears", "mouth", "crown"]) {
    assert.equal(manifest.anchors[anchor].length, 3);
  }
});

test("senses map to real commands and surfaces link to existing docs", async () => {
  for (const flag of ["--see", "--hear", "--speak", "--create"]) assert.ok(pages.en.includes(flag));
  assert.match(pages.en, /multix gemini analyze --files photo\.jpg/);
  assert.match(pages.en, /multix openai transcribe --input meeting\.mp3/);
  assert.match(pages.en, /multix elevenlabs tts --text/);
  for (const [lang, html] of Object.entries(pages)) {
    const prefix = lang === "vi" ? "/vi" : "";
    for (const path of ["/getting-started/", "/guides/mcp-server/", "/guides/rest-api/"]) {
      assert.ok(html.includes(`href="${prefix}${path}"`), `${lang}: ${path}`);
      await stat(new URL(`../dist${prefix}${path}index.html`, import.meta.url));
    }
  }
});

test("install code is plain text and the footer matches the docs", () => {
  for (const html of Object.values(pages)) {
    assert.match(html, /<pre id="mx-install-code"><code>npm install -g @mrgoonie\/multix/);
    assert.match(html, /AgentKit\.best/);
    assert.match(html, /@goon_nguyen \(X\)/);
  }
  assert.match(pages.en, /Made with.*AgentKit\.best/);
});

test("an empty case-study list renders no section", () => {
  for (const html of Object.values(pages)) {
    assert.doesNotMatch(html, /id="case-studies"/);
    assert.ok(!jsonLd(html).some((item) => item["@type"] === "VideoObject"));
  }
});
