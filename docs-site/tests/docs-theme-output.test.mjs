import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const dist = new URL("../dist/", import.meta.url);
const readDist = (path) => readFile(new URL(path, dist), "utf8");

// Accent colours of the previous docs theme; none may survive the Obsidian
// reskin. Starlight's own defaults (for example #f6f7f9) still ship in its
// layered base styles and are overridden by custom.css, so they are not listed.
const retiredColours = /6451d4|e9e6ff|352588|2f285f|aa9dff|ded9ff/i;

const linkedStylesheets = async (html) => {
  const hrefs = [...html.matchAll(/<link rel="stylesheet" href="(\/_astro\/[^"]+\.css)"/g)].map(
    ([, href]) => href,
  );
  return (await Promise.all(hrefs.map((href) => readDist(href.slice(1))))).join("\n");
};

test("docs pages link the Obsidian theme: tokens, fonts and the Starlight mapping", async () => {
  for (const page of ["getting-started/index.html", "vi/getting-started/index.html"]) {
    const css = await linkedStylesheets(await readDist(page));
    assert.match(css, /--mx-obsidian-1:\s*#060709/, `${page} misses tokens.css`);
    assert.match(css, /font-family:\s*"?Geist Variable/, `${page} misses fonts.css`);
    assert.match(css, /--sl-font:\s*var\(--mx-font-sans\)/, `${page} misses the Starlight mapping`);
    assert.match(css, /--sl-color-black:\s*var\(--mx-bg\)/);
    assert.match(css, /backdrop-filter:\s*blur/, `${page} misses the glass header`);
    assert.match(
      css,
      /prefers-color-scheme:\s*light\)\s*and\s*\(scripting:\s*none/,
      `${page} misses the no-JS fallback`,
    );
  }
});

test("built CSS carries no colour of the previous docs theme", async () => {
  const files = (await readdir(new URL("_astro/", dist))).filter((name) => name.endsWith(".css"));
  assert.ok(files.length > 0);
  for (const name of files) {
    assert.doesNotMatch(await readDist(`_astro/${name}`), retiredColours, name);
  }
});

test("header brand links back to the landing page of each locale", async () => {
  const [english, vietnamese] = await Promise.all([
    readDist("getting-started/index.html"),
    readDist("vi/getting-started/index.html"),
  ]);

  assert.match(english, /<a href="\/" class="site-title mx-brand/);
  assert.match(english, /the multimodal layer for AI agents/);
  assert.match(vietnamese, /<a href="\/vi\/" class="site-title mx-brand/);
  assert.match(vietnamese, /lớp đa phương thức cho AI agent/);
  assert.match(english, /href="https:\/\/github\.com\/mrgoonie\/multix-cli"/);
  // Starlight's own theme picker stays, so the stored "starlight-theme" key keeps working.
  assert.match(english, /<starlight-theme-select/);
  assert.match(english, /localStorage\.getItem\('starlight-theme'\)/);
});

test("the docs sidebar opens on the install guide, not the landing route", async () => {
  const page = await readDist("commands/gemini/index.html");
  const sidebar = page.slice(page.indexOf('id="starlight__sidebar"'));
  const firstLink = sidebar.match(/<a href="([^"]+)"/);
  assert.equal(firstLink?.[1], "/getting-started/");
});

test("404 page uses the Obsidian layout with routes home and to the docs", async () => {
  const page = await readDist("404.html");

  assert.match(page, /class="mx-404 /);
  assert.match(page, /<h1 id="_top"[^>]*>Page not found<\/h1>/);
  assert.match(page, /href="\/getting-started\/"/);
  assert.match(page, /href="\/"/);
  assert.match(page, /href="\/vi\/getting-started\/"/);
  assert.match(page, /Made with.*AgentKit\.best/);
});
