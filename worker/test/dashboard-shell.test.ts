import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apiDocsPage } from "../src/pages/api-docs-page.js";
import { dashboardPage, signInPage } from "../src/pages/dashboard-page.js";
import { negotiateLanguage } from "../src/pages/i18n.js";
import { messagePage } from "../src/pages/page-layout.js";
import { resolvePreferences, switchHref } from "../src/pages/preferences.js";
import { PROVIDER_KEY_GROUPS } from "../src/provider-secret-names.js";
import { dashboardView, storedSecret } from "./dashboard-view-fixture.js";
import {
  ORIGIN,
  REDIRECT_URI,
  githubFetch,
  newBrowser,
  oauthEnv,
  registerClient,
  signIn,
} from "./oauth-harness.js";

const OCTOCAT = { id: 583231, login: "octocat" };

const request = (path: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers });

describe("language negotiation", () => {
  it.each([
    [null, "en"],
    ["", "en"],
    ["vi", "vi"],
    ["vi-VN,vi;q=0.9,en;q=0.8", "vi"],
    ["en-US,en;q=0.9,vi;q=0.8", "en"],
    ["fr-FR,fr;q=0.9,vi;q=0.5", "vi"],
    ["fr,de", "en"],
    ["en;q=0.3,vi;q=0.7", "vi"],
    ["vi;q=0,en", "en"],
  ])("Accept-Language %j gives %s", (header, lang) => {
    expect(negotiateLanguage(header)).toBe(lang);
  });

  it("prefers the query, then the cookie, then the header", () => {
    const header = { "accept-language": "vi" };
    expect(resolvePreferences(request("/dashboard", header)).prefs.lang).toBe("vi");
    const cookie = { ...header, cookie: "a=b; multix-lang=en" };
    expect(resolvePreferences(request("/dashboard", cookie)).prefs.lang).toBe("en");
    const query = resolvePreferences(request("/dashboard?lang=vi", cookie));
    expect(query.prefs.lang).toBe("vi");
    expect(query.cookies).toEqual([
      "multix-lang=vi; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    ]);
  });

  it("ignores unknown values", () => {
    const resolved = resolvePreferences(
      request("/dashboard?lang=fr&theme=neon", { cookie: "multix-lang=de; multix-theme=x" }),
    );
    expect(resolved.prefs).toEqual({ lang: "en", theme: "auto" });
    expect(resolved.cookies).toEqual([]);
  });

  it("keeps the rest of the URL in switch links", () => {
    expect(switchHref("/oauth/authorize?client_id=a&state=s", "lang", "vi")).toBe(
      "/oauth/authorize?client_id=a&state=s&lang=vi",
    );
    expect(switchHref("/dashboard", "theme", "dark")).toBe("/dashboard?theme=dark");
  });
});

describe("language and theme on the served pages", () => {
  it("serves Vietnamese to a vi browser and stores a switch in a cookie", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    const vi = await browser.request("/dashboard", { headers: { "accept-language": "vi-VN" } });
    const viHtml = await vi.text();
    expect(viHtml).toContain('<html lang="vi">');
    expect(viHtml).toContain("Đăng nhập bằng GitHub");
    expect(vi.headers.getSetCookie().some((c) => c.startsWith("multix-lang="))).toBe(false);

    const switched = await browser.request("/dashboard?lang=en", {
      headers: { "accept-language": "vi-VN" },
    });
    expect(await switched.text()).toContain('<html lang="en">');
    expect(switched.headers.getSetCookie()).toContain(
      "multix-lang=en; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    const later = await browser.request("/dashboard", { headers: { "accept-language": "vi" } });
    expect(await later.text()).toContain('<html lang="en">');
  });

  it("renders the theme from the query or cookie on the server", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    expect(await (await browser.request("/dashboard")).text()).toMatch(/<html lang="en">/);
    const dark = await browser.request("/dashboard?theme=dark");
    expect(await dark.text()).toContain('<html lang="en" data-theme="dark">');
    expect(dark.headers.getSetCookie()).toContain(
      "multix-theme=dark; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(await (await browser.request("/api/docs")).text()).toContain('data-theme="dark"');
    const auto = await (await browser.request("/dashboard?theme=auto")).text();
    expect(auto).toContain('<html lang="en">');
  });

  it("marks the current choices in the switches", () => {
    const html = signInPage({ lang: "vi", theme: "light" });
    expect(html).toContain('<a href="/dashboard?lang=vi" aria-current="true" lang="vi"');
    expect(html).toContain('<a href="/dashboard?theme=light" aria-current="true">Sáng</a>');
    expect(html).toContain('<a href="/dashboard?theme=auto">Tự động</a>');
  });

  it("translates the consent page and keeps the OAuth request in its switch links", async () => {
    const browser = newBrowser(oauthEnv(), githubFetch(OCTOCAT).fetch);
    await signIn(browser);
    const clientId = await registerClient(browser, "Cursor");
    const query = `response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=abcdefghijabcdefghijabcdefghijabcdefghij123&code_challenge_method=S256&state=s`;
    const response = await browser.request(`/oauth/authorize?${query}&lang=vi`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<html lang="vi">');
    expect(html).toContain("Cho phép <em>Cursor</em> dùng multix?");
    expect(html).toContain(`href="/oauth/authorize?${query.replaceAll("&", "&#38;")}&#38;lang=en"`);
    expect(html).toContain('name="decision" value="approve"');
  });

  it("translates notices and copy messages", () => {
    const html = dashboardPage(
      dashboardView({ notice: "r2-denied", prefs: { lang: "vi", theme: "auto" } }),
    );
    expect(html).toContain('<p class="notice warn" role="status">Chưa lưu cấu hình R2');
    expect(html).toContain('data-copied="Đã sao chép"');
    expect(html).toContain('aria-label="Sao chép URL MCP server"');
  });
});

describe("app shell", () => {
  it("leaves out the language and theme switches while a just-created key is shown", () => {
    expect(dashboardPage(dashboardView())).toContain('class="prefs"');
    const html = dashboardPage(dashboardView({ newApiKey: { name: "ci", key: "mx_test_key" } }));
    expect(html).toContain("mx_test_key");
    expect(html).not.toContain('class="prefs"');
  });

  it("has a sidebar with the dashboard sections, the docs link and sign-out", () => {
    const html = dashboardPage(dashboardView());
    expect(html).toContain('<header class="sidebar">');
    expect(html).toContain('<nav aria-label="Dashboard">');
    for (const href of [
      "#overview",
      "#provider-keys",
      "#storage",
      "#api-keys",
      "#clients",
      "/api/docs",
    ]) {
      expect(html).toContain(`class="nav-link" href="${href}"`);
    }
    for (const id of ["overview", "provider-keys", "storage", "api-keys", "clients"]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('<form method="post" action="/dashboard/logout">');
    expect(html).toContain('<main id="main" class="content">');
    expect(html).toContain('<a class="skip" href="#main">');
    expect(html).toContain('<meta name="robots" content="noindex">');
  });

  it("uses only the shared tokens, on every page", () => {
    const pages = [
      signInPage(),
      dashboardPage(dashboardView()),
      apiDocsPage(ORIGIN),
      messagePage("Sign-in failed", "Try again."),
    ];
    for (const html of pages) {
      expect(html).toContain("--mx-obsidian-1:");
      expect(html).not.toMatch(/#f6f7f9|#2f5bea|--bg:|--accent:|--card:/i);
    }
    // Colour literals live only in the generated tokens.
    const dir = new URL("../src/pages/", import.meta.url);
    for (const file of readdirSync(dir)) {
      if (file === "design-tokens.ts") continue;
      const source = readFileSync(new URL(file, dir), "utf8");
      expect(source, file).not.toMatch(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b(?![0-9a-z-])|rgba?\(/i);
    }
  });
});

describe("onboarding", () => {
  const step = (html: string, title: string) => {
    const at = html.indexOf(`<h3>${title}</h3>`);
    expect(at).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf("<li class=", at), html.indexOf("</li>", at));
  };

  it("starts with only the sign-in step done", () => {
    const html = dashboardPage(dashboardView());
    expect(step(html, "Sign in with GitHub")).toContain('class="step done"');
    expect(step(html, "Add a provider key")).toContain('<li class="step">');
    expect(step(html, "Add a provider key")).toContain('href="#provider-keys"');
    const connect = step(html, "Paste the MCP URL into your client");
    expect(connect).toContain('<li class="step">');
    expect(connect).toContain("<pre>https://mcp.example.com/mcp</pre>");
    expect(html).toContain(`0 of ${PROVIDER_KEY_GROUPS.length} providers ready`);
  });

  it("marks a provider ready and the key step done once a key is saved", () => {
    const html = dashboardPage(dashboardView({ secrets: { GEMINI_API_KEY: storedSecret() } }));
    expect(step(html, "Add a provider key")).toContain('class="step done"');
    expect(html).toContain("1 provider is ready.");
    expect(html).toContain(
      '<a href="#provider-gemini"><span>Gemini</span><span class="status status-ok">',
    );
    expect(html).toContain('<details class="provider" id="provider-gemini" open>');
    expect(html).toContain(`1 of ${PROVIDER_KEY_GROUPS.length} providers ready`);
  });

  it("marks the connect step done once a client is connected", () => {
    const html = dashboardPage(
      dashboardView({ clients: [{ grantId: "g1", clientName: "Claude", createdAt: 0 }] }),
    );
    expect(step(html, "Paste the MCP URL into your client")).toContain('class="step done"');
    expect(html).toContain("1 client is connected.");
  });

  it("escapes account and client data", () => {
    const html = dashboardPage(
      dashboardView({
        account: { ...dashboardView().account, login: '<img src=x onerror="1">' },
        clients: [{ grantId: "g", clientName: "<b>x</b>", createdAt: 0 }],
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>x</b>");
  });
});
