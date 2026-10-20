---
type: research
topic: gemini-3.5-flash-and-gemini-omni
created: 2026-05-20 14:42 Asia/Ho_Chi_Minh
sources: official-google-primary
---

# Research Report: Gemini 3.5 Flash And Gemini Omni

## Summary

`gemini-3.5-flash` is not an image, TTS, Live API, or video generation model. It accepts text, image, video, audio, and PDF inputs, but only returns text. Official Gemini API docs explicitly mark audio generation and image generation as not supported. Video generation is not listed as a capability for this model, and the current Gemini API video generation guide still points to Veo 3.1 models.

`Gemini Omni Flash` is the relevant new video-generation/editing model family. Google announced it at I/O 2026: any input to video output first, image/audio output later. Current availability is Gemini app, Google Flow, and YouTube Shorts/Create. API access is not live in docs yet; Google says developer and enterprise APIs are coming in the next weeks.

## Scout Findings

- Repo is TypeScript Node CLI with Commander, `tsup`, `tsc`, Vitest.
- Gemini code is already separated by modality:
  - analysis/doc/transcribe: `src/providers/gemini/models.ts` defaults to `gemini-2.5-flash`
  - image: `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`, Imagen IDs
  - video: `veo-3.1-generate-preview`, command validates `model.startsWith("veo-")`
  - TTS: `GEMINI_TTS_MODELS` allowlist in `src/providers/gemini/voices.ts`
- No `docs/` directory exists. Standalone reports live in `plans/reports/`.

## Source Verification

### Gemini 3.5 Flash

Official Gemini API model page:

- Model ID: `gemini-3.5-flash`
- Inputs: text, image, video, audio, PDF
- Output: text
- Audio generation: not supported
- Image generation: not supported
- Live API: not supported
- Latest update: May 2026

Source: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash

Official Gemini 3.5 blog frames it as an agentic/coding/multimodal-understanding model, available in Gemini API. It does not present it as a media generation model.

Source: https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5/

### Current Gemini API Video Generation

Official Gemini API video generation guide is still Veo 3.1:

- Page title: "Generate videos with Veo 3.1 in Gemini API"
- API examples use `veo-3.1-generate-preview`
- REST endpoint uses `models/veo-3.1-generate-preview:predictLongRunning`
- No `Omni` mention on the current API video page.

Source: https://ai.google.dev/gemini-api/docs/video

### Gemini Omni

Official Google announcement:

- `Gemini Omni` is a new model family for creation.
- First model: `Gemini Omni Flash`.
- It can combine image, audio, video, and text inputs to generate high-quality videos.
- It supports conversational video editing.
- Initial rollout: Gemini app, Google Flow, YouTube Shorts/Create.
- API access: "In the coming weeks" for developers and enterprises.
- Future output modalities: image and audio later.

Source: https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-omni/

Google Flow announcement confirms Gemini Omni Flash is available inside Flow and compares it to Nano Banana for video.

Source: https://blog.google/innovation-and-ai/models-and-research/google-labs/flow-updates/

## Recommendation

For `multix-cli`, do not add `gemini-3.5-flash` to image/TTS/video generation registries.

Best next design:

1. Support `gemini-3.5-flash` only for text-output Gemini tasks:
   - `gemini analyze`
   - `gemini transcribe`
   - `gemini extract`
   - `doc convert`
2. Consider changing default analysis/doc model to `gemini-3.5-flash` only if user wants quality/coding/agentic boost over cost/latency stability.
3. Track `Gemini Omni Flash` as a future video provider/model, but do not implement until Google publishes API docs/model ID.
4. For now, keep Gemini video default on Veo 3.1.

## Implementation Boundary

In scope for a future plan:

- README and help text update.
- Model constants/tests for text-output Gemini tasks.
- Optional `--thinking-level minimal|low|medium|high` for `gemini-3.5-flash` analysis/doc/extract/transcribe.
- Add "Gemini Omni Flash pending API docs" note if desired.

Out of scope now:

- Adding Omni API support before API docs/model ID exist.
- Routing `gemini-3.5-flash` through image, TTS, or video generation commands.
- Replacing Veo with Omni.

## Unresolved Questions

- Should `gemini-3.5-flash` become default for analysis/doc tasks, or stay opt-in via `--model`?
- Should we add `--thinking-level` in the same change, or keep first patch as model/docs only?
- Should README mention Gemini Omni now as "API pending", or wait until Google publishes API docs?
