---
phase: 2
title: Model Registry And Defaults
status: completed
priority: P1
effort: 45m
dependencies:
  - 1
---

# Phase 2: Model Registry And Defaults

## Overview

Update Gemini model constants so text-output tasks officially default to `gemini-3.5-flash` while media commands stay on specialized models.

## Requirements

- Functional: default analyze/transcribe/extract/doc convert model is `gemini-3.5-flash`.
- Functional: existing `MULTIMODAL_MODEL` / `GEMINI_MODEL` override behavior remains unchanged.
- Functional: image/TTS/video defaults and allowlists stay unchanged.
- Non-functional: keep change localized; no API wrapper rewrite.

## Architecture

Keep `getDefaultModel()` as the single routing point for Gemini command defaults. Add a named text-output default constant to make intent clear and avoid scattering `gemini-3.5-flash` across files. Doc conversion can either reuse the same constant or keep `DOC_MODEL_DEFAULT` assigned to the same value.

## Related Code Files

- Modify: `src/providers/gemini/models.ts`
- Do not modify: `src/providers/gemini/client.ts` unless tests expose an actual API-shape issue.
- Do not modify: `src/providers/gemini/voices.ts`
- Do not modify: `src/providers/gemini/commands/generate-video.ts`
- Do not modify: `src/providers/gemini/commands/image-to-video.ts`

## Implementation Steps

1. Add a text-output default constant, e.g. `TEXT_MODEL_DEFAULT = "gemini-3.5-flash"`.
2. Set `ANALYSIS_MODEL_DEFAULT` to the new text default.
3. Set `DOC_MODEL_DEFAULT` to the new text default.
4. Keep `IMAGE_MODEL_DEFAULT`, `IMAGE_MODEL_FALLBACK`, `VIDEO_MODEL_DEFAULT`, and `TTS_MODEL_DEFAULT` unchanged.
5. Keep `getDefaultModel("analyze" | "transcribe" | "extract")` override order:
   - `MULTIMODAL_MODEL`
   - `GEMINI_MODEL`
   - `ANALYSIS_MODEL_DEFAULT`
6. Keep the `generate-video` default path unchanged so both text-to-video and image-to-video remain Veo-only.
7. Do not add validation that blocks arbitrary `--model` for text-output commands. Existing CLI flexibility is useful for hot model rollouts.
8. Run focused unit tests from Phase 1 and make them pass.

## Success Criteria

- [ ] Phase 1 tests pass.
- [ ] `gemini-3.5-flash` is centralized in model constants.
- [ ] No media-generation default changes.
- [ ] No new dependencies.

## Risk Assessment

Risk: changing defaults may increase cost/latency for some users.
Mitigation: preserve existing env and `--model` overrides; document old model as an explicit fallback.
