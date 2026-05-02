# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.1] - 2026-05-02

### Added
- Initial release — TypeScript/ESM port of Python `ai-multimodal` skill scripts.
- `multix gemini` — analyze, transcribe, extract, generate images (Nano Banana / Imagen 4), generate-video (Veo, experimental).
- `multix minimax` — image, video (async polling), speech (TTS), music generation.
- `multix openrouter` — image generation via chat completions API with fallback model support.
- `multix media` — optimize video/audio/images (ffmpeg + ImageMagick), split long videos, batch process directories.
- `multix doc` — convert PDFs, Office docs, images to Markdown via Gemini Files API.
- `multix check` — diagnostics: tooling presence, API key validation, Gemini live ping, setup hints.
- Shared core: env loader (layered .env), result type, HTTP client (globalThis.fetch), output dir, ANSI logger.
- Vitest unit + smoke tests (103 tests); GitHub Actions CI on Node 20/22 × Ubuntu/Windows.
- Companion `skill/SKILL.md` for Claude Code skill catalog.
