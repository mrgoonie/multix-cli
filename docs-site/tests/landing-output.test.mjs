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
  assert.match(pages.en, /14 providers behind one CLI, one MCP server and one REST API/);
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

test("the hero head is inline SVG, so it shows without JS", () => {
  for (const html of Object.values(pages)) {
    assert.match(
      html,
      /<div class="mx-head-art" role="img" aria-label="[^"]+"><svg class="mx-head"/,
    );
    for (const sense of ["eyes", "ears", "mouth", "crown"]) {
      assert.match(html, new RegExp(`class="mx-r mx-r-${sense}"><path style="--w:`));
    }
    assert.match(html, /<button[^>]*id="mx-unlock"[^>]*hidden/);
    assert.doesNotMatch(html, /head-poster|head-points/);
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

test("providers section lists every provider from the CLI source in both languages", async () => {
  const readRoot = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
  // Command groups as classified in the CLI; doc, speech and scene are not providers.
  const capabilities = await readRoot("src/capabilities/command-capabilities.ts");
  const commandBlock = capabilities.slice(0, capabilities.indexOf("export const UTILITY_COMMANDS"));
  const groups = new Set(
    [...commandBlock.matchAll(/^\s*"([a-z0-9]+) [a-z0-9 -]+":/gm)].map(([, group]) => group),
  );
  for (const group of ["doc", "speech", "scene"]) groups.delete(group);
  // Provider names as `multix check` prints them; Cloudflare is checked on its own there.
  const keys = await readRoot("src/providers/provider-keys.ts");
  const names = [...keys.matchAll(/^\s*name: "([^"]+)",/gm)].map(([, name]) => name);
  assert.ok(groups.size >= 14 && names.length >= 13, "source lists were not found");

  const titles = {
    en: "Pick the provider, keep the command",
    vi: "Chọn provider, giữ nguyên lệnh",
  };
  for (const [lang, html] of Object.entries(pages)) {
    const start = html.indexOf('<section class="mx-section" id="providers"');
    assert.ok(start > 0, `${lang}: providers section missing`);
    const section = html.slice(start, html.indexOf("</section>", start));
    assert.match(section, new RegExp(`<h2 id="providers-title">${titles[lang]}</h2>`));

    const cards = section.split(/<li class="mx-card[^"]*" data-provider=/).slice(1);
    assert.deepEqual(
      cards.map((card) => /^"([^"]+)"/.exec(card)[1]).sort(),
      [...groups].sort(),
      `${lang}: one card per provider command group`,
    );
    for (const card of cards) {
      const group = /^"([^"]+)"/.exec(card)[1];
      assert.ok(card.includes(`<code>multix ${group}</code>`), `${lang}: ${group} command`);
      const models = card.slice(card.indexOf("mx-provider-models")).match(/<li>/g) ?? [];
      assert.ok(models.length >= 2 && models.length <= 4, `${lang}: ${group} has 2-4 models`);
      // Headings stay in order inside the card: provider (h3), then its two lists (h4).
      assert.match(card, /^[\s\S]*?<h3[^>]*>[^<]+<\/h3>[\s\S]*?<h4[\s\S]*?<h4/);
    }
    const headings = [...section.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map(([, name]) => name);
    for (const name of names) assert.ok(headings.includes(name), `${lang}: ${name} heading`);

    const prefix = lang === "vi" ? "/vi" : "";
    for (const path of ["/commands/providers/", "/commands/gemini/", "/commands/atlascloud/"]) {
      assert.ok(section.includes(`href="${prefix}${path}"`), `${lang}: ${path}`);
      await stat(new URL(`../dist${prefix}${path}index.html`, import.meta.url));
    }
  }
  assert.match(pages.vi, /Chuyển giọng nói thành chữ \(STT\)/);
  // Placed after the senses, before the install block.
  for (const html of Object.values(pages)) {
    assert.ok(html.indexOf('id="senses"') < html.indexOf('id="providers"'));
    assert.ok(html.indexOf('id="providers"') < html.indexOf('id="install"'));
  }
});
