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
          label: "Start here",
          translations: { vi: "Bắt đầu" },
          items: [
            { label: "Overview", translations: { vi: "Tổng quan" }, slug: "index" },
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
              label: "Catalog (prices, usage, reviews)",
              translations: { vi: "Catalog (giá, mức sử dụng, đánh giá)" },
              slug: "commands/catalog",
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
      },
      customCss: ["./src/styles/custom.css"],
    }),
  ],
});
