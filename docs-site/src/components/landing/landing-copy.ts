/**
 * Every string on the landing page, in English and Vietnamese. Commands are
 * real multix commands (see README.md and the docs) and stay untranslated.
 */

export type Lang = "en" | "vi";

export const SITE = "https://multix.zuey.me";

/** Prefix a docs path with the locale: `/getting-started/` → `/vi/getting-started/`. */
export const localePath = (lang: Lang, path: string) => (lang === "vi" ? `/vi${path}` : path);

export interface Sense {
  flag: string;
  organ: string;
  title: string;
  body: string;
  command: string;
}

export interface Surface {
  name: string;
  title: string;
  body: string;
  code: string;
  href: string;
  cta: string;
}

const senseCommands = {
  see: 'multix gemini analyze --files photo.jpg --prompt "Describe this"',
  hear: "multix openai transcribe --input meeting.mp3",
  speak: 'multix elevenlabs tts --text "Hello world"',
  create: 'multix gemini generate --prompt "A sunset over mountains" --aspect-ratio 16:9',
};

export const installCommands = [
  "npm install -g @mrgoonie/multix",
  "multix check",
  'multix fal image "a red fox" --dry-run --json',
];

const surfaceCode = {
  cli: 'multix gemini generate --prompt "A mountain lake"',
  mcp: "https://multix.zuey.me/mcp",
  rest: 'curl https://multix.zuey.me/api/v1/me \\\n  -H "Authorization: Bearer $MULTIX_API_KEY"',
};

const en = {
  lang: "en",
  htmlLang: "en",
  ogLocale: "en_US",
  title: "multix — the multimodal layer for AI agents",
  description:
    "Unlock multimodal for every AI agent: 17 providers behind one CLI, one MCP server and one REST API for images, video, speech, music and documents.",
  skip: "Skip to content",
  nav: {
    label: "Main",
    docs: "Docs",
    mcp: "MCP",
    rest: "REST API",
    github: "GitHub",
    theme: "Theme",
    themeAuto: "Auto",
    themeLight: "Light",
    themeDark: "Dark",
    language: "Language",
  },
  hero: {
    eyebrow: "The multimodal layer for AI agents",
    headline: {
      lead: "Give every AI agent",
      soft: "eyes, ears, a voice —",
      em: "and imagination.",
    },
    subline: {
      strong: "Unlock multimodal for every AI agent",
      rest: " — 17 providers behind one CLI, one MCP server and one REST API",
    },
    install: "npm i -g @mrgoonie/multix",
    installHref: "#install",
    mcp: "Connect MCP",
    unlock: "Unlock senses",
    lock: "Lock senses",
    posterAlt: "A digital head drawn in dots",
    labels: {
      eyes: "image · video",
      ears: "stt · music",
      mouth: "tts · avatar",
      create: "image · video · music · 3d",
    },
  },
  specs: {
    label: "At a glance",
    items: [
      { value: "17", label: "providers" },
      { value: "5", label: "modalities" },
      { value: "CLI · MCP · REST", label: "three surfaces" },
      { value: "--dry-run", label: "free validation" },
    ],
  },
  senses: {
    eyebrow: "Four senses",
    title: "One install, four new senses",
    lead: "Each sense is a real multix command your agent can call today. Swap the provider, keep the command shape.",
    items: [
      {
        flag: "--see",
        organ: "Eyes",
        title: "Read images, video and documents",
        body: "Describe a photo, pull tables out of a PDF or summarise a clip.",
        command: senseCommands.see,
      },
      {
        flag: "--hear",
        organ: "Ears",
        title: "Transcribe speech",
        body: "Turn meetings, calls and voice notes into text, with diarisation where the model supports it.",
        command: senseCommands.hear,
      },
      {
        flag: "--speak",
        organ: "Voice",
        title: "Speak in any voice",
        body: "Text to speech from ElevenLabs, OpenAI, Gemini, MiniMax, Fish Audio and more.",
        command: senseCommands.speak,
      },
      {
        flag: "--create",
        organ: "Imagination",
        title: "Create images, video, music and 3D",
        body: "Generate stills, clips, songs and meshes from one prompt, with the provider you choose.",
        command: senseCommands.create,
      },
    ] satisfies Sense[],
  },
  install: {
    eyebrow: "Quick start",
    title: "Install in one line",
    lead: "Node 20 or newer. Add a provider key, then validate a request for free with --dry-run before you spend a credit.",
    copy: "Copy",
    copied: "Copied",
    codeLabel: "Install and first commands",
    more: "Install and configure",
  },
  surfaces: {
    eyebrow: "Three surfaces",
    title: "Wherever your agent runs",
    items: [
      {
        name: "CLI",
        title: "On your machine",
        body: "One binary for every provider. JSON envelopes, class exit codes and cost guards for agents.",
        code: surfaceCode.cli,
        href: "/getting-started/",
        cta: "Read the CLI guide",
      },
      {
        name: "MCP",
        title: "In hosted assistants",
        body: "A remote MCP server over Streamable HTTP runs CLI commands in a container with your own keys.",
        code: surfaceCode.mcp,
        href: "/guides/mcp-server/",
        cta: "Connect the MCP server",
      },
      {
        name: "REST",
        title: "From scripts and CI",
        body: "The same runner as JSON over HTTP, with account API keys and signed webhooks.",
        code: surfaceCode.rest,
        href: "/guides/rest-api/",
        cta: "Use the REST API",
      },
    ] satisfies Surface[],
  },
  caseStudies: {
    eyebrow: "Case studies",
    title: "Made with multix",
    play: "Play video",
  },
  footer: {
    docs: "Documentation",
    made: "Made with",
    love: "love",
    by: "by",
    author: "Author",
  },
};

export type LandingCopy = typeof en;

const vi: LandingCopy = {
  lang: "vi",
  htmlLang: "vi",
  ogLocale: "vi_VN",
  title: "multix — lớp đa phương thức cho AI agent",
  description:
    "Mở khóa đa phương thức cho mọi AI agent: 17 provider trong một CLI, một MCP server và một REST API cho ảnh, video, giọng nói, âm nhạc và tài liệu.",
  skip: "Bỏ qua tới nội dung",
  nav: {
    label: "Chính",
    docs: "Tài liệu",
    mcp: "MCP",
    rest: "REST API",
    github: "GitHub",
    theme: "Giao diện",
    themeAuto: "Tự động",
    themeLight: "Sáng",
    themeDark: "Tối",
    language: "Ngôn ngữ",
  },
  hero: {
    eyebrow: "Lớp đa phương thức cho AI agent",
    headline: {
      lead: "Cho mọi AI agent",
      soft: "đôi mắt, đôi tai, giọng nói —",
      em: "và trí tưởng tượng.",
    },
    subline: {
      strong: "Mở khóa đa phương thức cho mọi AI agent",
      rest: " — 17 provider trong một CLI, một MCP server và một REST API",
    },
    install: "npm i -g @mrgoonie/multix",
    installHref: "#install",
    mcp: "Kết nối MCP",
    unlock: "Mở khóa giác quan",
    lock: "Khóa giác quan",
    posterAlt: "Một cái đầu kỹ thuật số vẽ bằng các chấm",
    labels: {
      eyes: "ảnh · video",
      ears: "chuyển giọng nói · nhạc",
      mouth: "đọc văn bản · avatar",
      create: "ảnh · video · nhạc · 3D",
    },
  },
  specs: {
    label: "Tóm tắt",
    items: [
      { value: "17", label: "provider" },
      { value: "5", label: "phương thức" },
      { value: "CLI · MCP · REST", label: "ba cách dùng" },
      { value: "--dry-run", label: "kiểm tra miễn phí" },
    ],
  },
  senses: {
    eyebrow: "Bốn giác quan",
    title: "Một lần cài, bốn giác quan mới",
    lead: "Mỗi giác quan là một lệnh multix thật mà agent gọi được ngay hôm nay. Đổi provider, giữ nguyên dạng lệnh.",
    items: [
      {
        flag: "--see",
        organ: "Mắt",
        title: "Đọc ảnh, video và tài liệu",
        body: "Mô tả một bức ảnh, rút bảng từ PDF hoặc tóm tắt một đoạn video.",
        command: senseCommands.see,
      },
      {
        flag: "--hear",
        organ: "Tai",
        title: "Chuyển giọng nói thành văn bản",
        body: "Biến cuộc họp, cuộc gọi và ghi âm thành chữ, tách người nói khi model hỗ trợ.",
        command: senseCommands.hear,
      },
      {
        flag: "--speak",
        organ: "Giọng nói",
        title: "Nói bằng bất kỳ giọng nào",
        body: "Đọc văn bản bằng ElevenLabs, OpenAI, Gemini, MiniMax, Fish Audio và nhiều provider khác.",
        command: senseCommands.speak,
      },
      {
        flag: "--create",
        organ: "Trí tưởng tượng",
        title: "Tạo ảnh, video, nhạc và 3D",
        body: "Sinh ảnh, clip, bài hát và mô hình 3D từ một prompt, với provider bạn chọn.",
        command: senseCommands.create,
      },
    ],
  },
  install: {
    eyebrow: "Bắt đầu nhanh",
    title: "Cài bằng một dòng lệnh",
    lead: "Cần Node 20 trở lên. Thêm key của một provider, rồi kiểm tra request miễn phí với --dry-run trước khi tốn credit.",
    copy: "Sao chép",
    copied: "Đã chép",
    codeLabel: "Lệnh cài đặt và các lệnh đầu tiên",
    more: "Cài đặt và cấu hình",
  },
  surfaces: {
    eyebrow: "Ba cách dùng",
    title: "Agent chạy ở đâu cũng dùng được",
    items: [
      {
        name: "CLI",
        title: "Trên máy của bạn",
        body: "Một lệnh cho mọi provider. JSON envelope, mã thoát theo lớp lỗi và giới hạn chi phí cho agent.",
        code: surfaceCode.cli,
        href: "/getting-started/",
        cta: "Đọc hướng dẫn CLI",
      },
      {
        name: "MCP",
        title: "Trong trợ lý AI trên web",
        body: "MCP server từ xa qua Streamable HTTP chạy lệnh CLI trong container bằng key của chính bạn.",
        code: surfaceCode.mcp,
        href: "/guides/mcp-server/",
        cta: "Kết nối MCP server",
      },
      {
        name: "REST",
        title: "Từ script và CI",
        body: "Cùng bộ chạy lệnh qua JSON trên HTTP, với API key của tài khoản và webhook có chữ ký.",
        code: surfaceCode.rest,
        href: "/guides/rest-api/",
        cta: "Dùng REST API",
      },
    ],
  },
  caseStudies: {
    eyebrow: "Dự án thực tế",
    title: "Làm bằng multix",
    play: "Phát video",
  },
  footer: {
    docs: "Tài liệu",
    made: "Làm với",
    love: "tình yêu",
    by: "bởi",
    author: "Tác giả",
  },
};

export const copy: Record<Lang, LandingCopy> = { en, vi };
