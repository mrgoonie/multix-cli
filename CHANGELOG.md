# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.5] - 2026-05-05

### Added
- `multix <provider> image-to-image` (alias `i2i`) for all five providers — BytePlus (Seedream multi-ref), Gemini (Nano Banana edit/compose), OpenRouter (chat-image with `image_url` parts), Leonardo (init image via existing imageId), MiniMax (subject_reference; CAVEAT: not free-form editing — preserves character identity in a new prompt).
- Promoted `src/core/image-input.ts` (URL / local-file resolver, base64 inlining with configurable size caps) so all providers share one resolver.

## [0.0.4] - 2026-05-04

### Added
- `--wait` / `--wait-timeout` / `--download` / `--output` / `--no-thumb` flags across all video commands (BytePlus, Gemini, Leonardo, MiniMax, OpenRouter) for unified poll-and-download UX.
- Auto-detection and download of video thumbnails (`cover_image_url`, `thumbnail_url`, `first_frame_url`, etc.) saved beside the video as `<base>_thumb.<ext>`.
- `multix leonardo status` now supports `--wait` / `--download`; `multix openrouter video-status` now polls properly instead of single GET.
- `.env.example` documenting all supported environment variables (provider keys, model overrides, CLI behavior).
- Core helper `src/core/video-thumb.ts` with `detectThumbUrl`, `downloadThumbBeside`, `maybeDownloadThumb`.

## [0.0.3] - 2026-05-03

### Added
- `multix gemini generate-speech` — Gemini 3.1 Flash TTS with single- and multi-speaker (max 2) modes, 30 prebuilt voices, WAV (default) or raw PCM output. Models: `gemini-3.1-flash-tts-preview` (default), `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`. Env: `GEMINI_TTS_MODEL` / `TTS_MODEL`.
- `multix byteplus` — BytePlus provider: Seedream 4.0 image generation (`generate`), Seedance 2.0 text-to-video (`video`), image-to-video (`image-to-video` / `i2v`), reference-to-video with up to 9 image + 3 video + 3 audio refs (`reference-to-video` / `r2v`), task polling (`status`). Env: `BYTEPLUS_API_KEY` (or `ARK_API_KEY`), plus model + base-url overrides.
- `multix check` now reports BytePlus key status alongside the other providers.

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
