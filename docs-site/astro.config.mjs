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
            { label: "Gemini", slug: "commands/gemini" },
            { label: "OpenAI", slug: "commands/openai" },
            {
              label: "Other providers",
              translations: { vi: "Provider khác" },
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
