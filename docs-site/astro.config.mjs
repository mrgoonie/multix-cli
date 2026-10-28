import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

const structuredData = JSON.stringify([
  {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "multix CLI documentation",
    url: "https://multix.zuey.me",
    inLanguage: ["en", "vi"],
  },
  {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "multix",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    url: "https://github.com/mrgoonie/multix-cli",
    description:
      "AI multimodal command-line interface for image, video, speech, music, document, and media workflows.",
  },
]);

const openSearchWithShortcut = `
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("site-search button[data-open-modal]")?.click();
  }
});
// Starlight labels the search button "Search" while it shows "Search Ctrl K";
// name it after what it shows so speech-input users can say the visible text.
// Runs after Starlight's module script has picked Ctrl or the Mac command key.
document.addEventListener("DOMContentLoaded", () => {
  const button = document.querySelector("site-search button[data-open-modal]");
  const keys = [...(button?.querySelectorAll("kbd kbd") ?? [])].map((key) => key.textContent).join(" ");
  if (button && keys) button.setAttribute("aria-label", \`\${button.getAttribute("aria-label")} \${keys}\`);
});
`;

export default defineConfig({
  site: "https://multix.zuey.me",
  output: "static",
  integrations: [
    starlight({
      title: "multix",
      description:
        "Command reference for the multix AI multimodal CLI: images, video, speech, music, media, and document conversion.",
      // Starlight's own 404 route looks up a docs entry named 404 and Astro 7.3
      // warns when it is missing; src/pages/404.astro renders the same page.
      disable404Route: true,
      defaultLocale: "root",
      locales: {
        root: { label: "English", lang: "en" },
        vi: { label: "Tiếng Việt", lang: "vi" },
      },
      social: [
        {
          icon: "github",
          label: "multix-cli on GitHub",
          href: "https://github.com/mrgoonie/multix-cli",
        },
      ],
      head: [
        {
          tag: "script",
          attrs: { type: "application/ld+json" },
          content: structuredData,
        },
        { tag: "script", content: openSearchWithShortcut },
      ],
      sidebar: [
        {
          // The landing page owns "/", so the docs open on the install guide.
          label: "Start here",
          translations: { vi: "Bắt đầu" },
          items: [
            {
              label: "Install and configure",
              translations: { vi: "Cài đặt và cấu hình" },
              slug: "getting-started",
            },
          ],
        },
        {
          label: "Commands",
          translations: { vi: "Lệnh" },
          items: [
            { label: "Command overview", translations: { vi: "Tổng quan lệnh" }, slug: "commands" },
            {
              label: "Speech (all providers)",
              translations: { vi: "Speech (mọi provider)" },
              slug: "commands/speech",
            },
            { label: "Gemini", slug: "commands/gemini" },
            { label: "OpenAI", slug: "commands/openai" },
            { label: "MiniMax", slug: "commands/minimax" },
            { label: "OpenRouter", slug: "commands/openrouter" },
            { label: "Leonardo", slug: "commands/leonardo" },
            { label: "BytePlus", slug: "commands/byteplus" },
            { label: "Cloudflare", slug: "commands/cloudflare" },
            { label: "ElevenLabs", slug: "commands/elevenlabs" },
            { label: "Fish Audio", slug: "commands/fish" },
            { label: "fal.ai", slug: "commands/fal" },
            { label: "Atlas Cloud", slug: "commands/atlascloud" },
            { label: "Replicate", slug: "commands/replicate" },
            { label: "Runway", slug: "commands/runway" },
            { label: "HeyGen", slug: "commands/heygen" },
            {
              label: "Scenes (dialogue audio)",
              translations: { vi: "Scene (audio hội thoại)" },
              slug: "commands/scene",
            },
            {
              label: "Provider directory",
              translations: { vi: "Danh mục provider" },
              slug: "commands/providers",
            },
            {
              label: "Media and documents",
              translations: { vi: "Media và tài liệu" },
              slug: "commands/media-and-documents",
            },
          ],
        },
        {
          label: "Guides",
          translations: { vi: "Hướng dẫn" },
          items: [
            {
              label: "Remote MCP server",
              translations: { vi: "MCP server từ xa" },
              slug: "guides/mcp-server",
            },
            {
              label: "REST API",
              translations: { vi: "REST API" },
              slug: "guides/rest-api",
            },
          ],
        },
        {
          label: "Reference",
          translations: { vi: "Tham chiếu" },
          items: [
            {
              label: "Environment variables",
              translations: { vi: "Biến môi trường" },
              slug: "reference/environment",
            },
            {
              label: "Output and troubleshooting",
              translations: { vi: "Output và xử lý lỗi" },
              slug: "reference/output-and-troubleshooting",
            },
            {
              label: "For AI agents",
              translations: { vi: "Dành cho AI agent" },
              slug: "reference/for-ai-agents",
            },
          ],
        },
      ],
      components: {
        Footer: "./src/components/DocsFooter.astro",
        SiteTitle: "./src/components/starlight/SiteTitle.astro",
      },
      // Code frames are obsidian wells in both themes: one dark theme on a fixed
      // primitive background, so a light page without JS never shows dark syntax
      // colours on a light frame.
      expressiveCode: {
        themes: ["vitesse-black"],
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderColor: "var(--mx-line-strong)",
          borderRadius: "var(--mx-radius-lg)",
          codeBackground: "var(--mx-obsidian-2)",
          codeFontFamily: "var(--mx-font-mono)",
          uiFontFamily: "var(--mx-font-sans)",
          frames: {
            editorActiveTabBackground: "var(--mx-obsidian-2)",
            editorActiveTabIndicatorTopColor: "var(--mx-white)",
            editorTabBarBackground: "var(--mx-obsidian-1)",
            editorTabBarBorderBottomColor: "var(--mx-graphite-1)",
            terminalBackground: "var(--mx-obsidian-2)",
            terminalTitlebarBackground: "var(--mx-obsidian-1)",
            terminalTitlebarBorderBottomColor: "var(--mx-graphite-1)",
            terminalTitlebarForeground: "var(--mx-graphite-3)",
            terminalTitlebarDotsForeground: "var(--mx-graphite-2)",
            frameBoxShadowCssValue: "none",
            inlineButtonForeground: "var(--mx-graphite-4)",
            inlineButtonBorder: "var(--mx-graphite-1)",
            tooltipSuccessBackground: "var(--mx-white)",
            tooltipSuccessForeground: "var(--mx-obsidian-1)",
          },
        },
      },
      customCss: [
        "./src/styles/fonts.css",
        "./src/styles/tokens.css",
        "./src/styles/custom.css",
        "./src/styles/starlight-chrome.css",
        "./src/styles/starlight-content.css",
      ],
    }),
  ],
});
