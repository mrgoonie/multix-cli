# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.2](https://github.com/mrgoonie/multix-cli/compare/v0.5.1...v0.5.2) (2026-07-30)


### Documentation

* add media prerequisites ([#40](https://github.com/mrgoonie/multix-cli/issues/40)) ([3ad9dbd](https://github.com/mrgoonie/multix-cli/commit/3ad9dbdcbc8b216833f27010ad1f568a3f7a6a86))

## [0.5.1](https://github.com/mrgoonie/multix-cli/compare/v0.5.0...v0.5.1) (2026-07-30)


### Documentation

* add provider guides and banner ([#38](https://github.com/mrgoonie/multix-cli/issues/38)) ([428390d](https://github.com/mrgoonie/multix-cli/commit/428390d399e51cff23a1f898162c6153a21a4785))

## [0.5.0](https://github.com/mrgoonie/multix-cli/compare/v0.4.0...v0.5.0) (2026-07-30)


### Added

* **gemini:** default text tasks to 3.6 Flash ([#36](https://github.com/mrgoonie/multix-cli/issues/36)) ([ec1e019](https://github.com/mrgoonie/multix-cli/commit/ec1e0193dc9f8e0570ffc0f57901d5846b44c91f))

## [0.4.0](https://github.com/mrgoonie/multix-cli/compare/v0.3.0...v0.4.0) (2026-07-30)


### Added

* add multix CLI documentation site ([#34](https://github.com/mrgoonie/multix-cli/issues/34)) ([cf2540d](https://github.com/mrgoonie/multix-cli/commit/cf2540dc9d4b7b416214395603fd071af49cf7a7))

## [0.3.0](https://github.com/mrgoonie/multix-cli/compare/v0.2.0...v0.3.0) (2026-07-29)


### Added

* **cloudflare:** add Workers AI media generation ([#26](https://github.com/mrgoonie/multix-cli/issues/26)) ([53c1831](https://github.com/mrgoonie/multix-cli/commit/53c183187571d59f350af7c769927e488afd36aa))

## [0.2.0](https://github.com/mrgoonie/multix-cli/compare/v0.1.1...v0.2.0) (2026-05-27)


### Added

* improve agent-facing command and skill descriptions ([#19](https://github.com/mrgoonie/multix-cli/issues/19)) ([a0f1dab](https://github.com/mrgoonie/multix-cli/commit/a0f1dab7e76295d5eb6a9d6dff237d28d2832596)), closes [#18](https://github.com/mrgoonie/multix-cli/issues/18)

## [0.1.1](https://github.com/mrgoonie/multix-cli/compare/v0.1.0...v0.1.1) (2026-05-20)


### Fixed

* **release:** merge release PR with explicit repo ([#15](https://github.com/mrgoonie/multix-cli/issues/15)) ([4695e3b](https://github.com/mrgoonie/multix-cli/commit/4695e3b5f6d66e59e5bb34db265beb78ae72c667))

## [0.1.0](https://github.com/mrgoonie/multix-cli/compare/v0.0.8...v0.1.0) (2026-05-20)


### Added

* **openai:** add provider media commands ([#9](https://github.com/mrgoonie/multix-cli/issues/9)) ([#11](https://github.com/mrgoonie/multix-cli/issues/11)) ([512d689](https://github.com/mrgoonie/multix-cli/commit/512d689f3fa5dcb2fb7ccce26a7d8d33b0091564))


### Fixed

* **release:** auto-complete stable releases ([#13](https://github.com/mrgoonie/multix-cli/issues/13)) ([20d65d4](https://github.com/mrgoonie/multix-cli/commit/20d65d46cbacacf28008996f7d13c0a17a00b540))
* **release:** resolve release PR without checkout ([#14](https://github.com/mrgoonie/multix-cli/issues/14)) ([64632ad](https://github.com/mrgoonie/multix-cli/commit/64632ad08e71a3ed94ac3b12f136403cd9c15651))

## [0.0.8] - 2026-05-11

### Fixed
- `multix openrouter image-to-image` previously failed for any non-Gemini text+image model (e.g. `openai/gpt-5.4-image-2`, `openai/gpt-5-image-mini`, `recraft/recraft-v3`) because the `modalities` heuristic forced `["image"]` for non-Gemini models. The new default is `["image","text"]`, with `["image"]` only emitted for verified image-only families (`black-forest-labs/`, `bytedance-seed/seedream`, `sourceful/`).
- "No images in response" errors now include the model id, `finish_reason`, the model's text reply (if any), and a hint about modalities — previously a single generic line.

### Added
- `multix openrouter image-to-image --strength <0..1>` — Recraft init-image strength control.
- `OPENROUTER_FALLBACK_MODELS` (CSV) now applies to `image-to-image` (previously `generate` only). Sends `models: [primary, ...fallbacks]` so OpenRouter can route on availability.
- New shared module `src/providers/openrouter/payload.ts` — `resolveModalities`, `buildOpenRouterHeaders`, `extractImagesFromResponse`, `formatNoImagesError`, `buildI2IPayload`. DRY across `generate` + `image-to-image`.

### Changed
- README and `skill/SKILL.md` document the OpenRouter model-family matrix (Gemini / OpenAI gpt-image / Recraft → text+image; Flux 2.x / Seedream 4.5 / Sourceful → image-only) and the new flags.

### Verified live
`openai/gpt-5.4-image-2`, `openai/gpt-5-image-mini`, `google/gemini-2.5-flash-image`, `black-forest-labs/flux.2-pro`, `flux.2-max`, `flux.2-flex`, `bytedance-seed/seedream-4.5`.

## [0.0.7] - 2026-05-05

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

## [0.0.6] - 2026-05-05

### Added
- `multix byteplus generate-3d` (alias `3d`) — BytePlus Hyper3D / Hitem3d 3D generation on the ARK async tasks endpoint. Models: `hyper3d-gen2-260112` (text-to-3D + image-to-3D, 1–5 refs), `hitem3d-2-0-251223` (image-to-3D). Provider-specific knobs (`--mesh_mode`, `--hd_texture`, `--material`, `--ff`, `--resolution`, …) passed via `--flags <raw>` pass-through. Auto-detects output extension (`.glb` / `.gltf` / `.zip` …) from response URL.
- `multix byteplus status --download` extended to also fetch `content.file_url` for 3D tasks alongside `content.video_url` for video.
- New env override: `BYTEPLUS_3D_MODEL` (default `hyper3d-gen2-260112`).

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
