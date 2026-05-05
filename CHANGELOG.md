# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.5] - 2026-05-05

### Added
- **ElevenLabs provider** — full integration with 13 subcommands:
  - `tts` — text-to-speech (sync audio bytes) with voice settings, language code, seed, context continuity, and `--no-speaker-boost` opt-out.
  - `voices list|get|search|design|create-from-preview|delete` — voice library management and prompt-based voice design.
  - `clone` — instant voice cloning via multipart audio sample upload.
  - `voice-changer` — speech-to-speech voice conversion.
  - `transcribe` — Scribe STT with diarization, audio-event tagging, and `text|json|srt|vtt` output.
  - `sfx` — sound effects generation with prompt influence and looping.
  - `music` — music generation (`music_v1`) from prompt or composition plan.
  - `dub` / `dub-status` — async dubbing with `--wait` / `--download` polling and per-language audio download.
  - `isolate` — voice isolator (background noise removal).
  - `align` — forced alignment (transcript ↔ audio timing).
  - `account` / `models` — usage / subscription tier and model catalog.
- `ELEVENLABS_RECOMMENDED_VOICES` with 11 verified conversational voice IDs (Alexandra default).
- TTS models: `eleven_multilingual_v2` (default), `eleven_flash_v2_5`, `eleven_flash_v2`, `eleven_turbo_v2_5`, `eleven_turbo_v2`, `eleven_v3`. STT: `scribe_v1`, `scribe_v1_experimental`. Voice changer: `eleven_multilingual_sts_v2`. Output formats: `mp3_*`, `pcm_*`, `ulaw_8000`.
- `multix check` and `.env.example` document `ELEVENLABS_API_KEY`.

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
