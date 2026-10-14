import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HTML_SECURITY_HEADERS } from "../src/http-responses.js";
import { apiDocsPage } from "../src/pages/api-docs-page.js";
import { copyBlock, copyField } from "../src/pages/copy-button.js";
import { COPY_SCRIPT, COPY_SCRIPT_HASH } from "../src/pages/copy-script.js";
import { page } from "../src/pages/page-layout.js";

describe("copy buttons", () => {
  it("allows the copy script by its hash and no other script", () => {
    const hash = `sha256-${createHash("sha256").update(COPY_SCRIPT).digest("base64")}`;
    expect(COPY_SCRIPT_HASH).toBe(hash);
    const csp = HTML_SECURITY_HEADERS["content-security-policy"] ?? "";
    expect(csp).toContain(`script-src '${hash}';`);
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc?.trim()).toBe(`script-src '${hash}'`);
    expect(csp).toContain("default-src 'none'");
  });

  it("adds the script, exactly as hashed, only to pages with a copy button", () => {
    const html = page("t", copyBlock("x", "x"));
    expect(html.split("<script>").length - 1).toBe(1);
    expect(html).toContain(`<script>${COPY_SCRIPT}</script>`);
    expect(html).toContain('id="copy-status"');
    expect(page("t", "<p>x</p>")).not.toContain("<script");
  });

  it("puts copy buttons on the API docs examples, with shell variables for path ids", () => {
    const docs = apiDocsPage("https://multix.example");
    expect(docs.split("data-copy ").length - 1).toBeGreaterThan(10);
    expect(docs).toContain("/api/v1/jobs/$ID ");
    expect(docs).not.toMatch(/&#60;(id|name)&#62;/);
  });

  it("escapes values and labels in fields and blocks", () => {
    const field = copyField('a"<b>', 'K"ey', "new-api-key-value");
    expect(field).toContain('value="a&#34;&#60;b&#62;"');
    expect(field).toContain('aria-label="Copy K&#34;ey"');
    expect(field).toContain('data-label="Copy K&#34;ey"');
    expect(field).toContain('id="new-api-key-value" readonly');
    expect(copyBlock("<x>", "cmd")).toContain("<pre>&#60;x&#62;</pre>");
  });
});
