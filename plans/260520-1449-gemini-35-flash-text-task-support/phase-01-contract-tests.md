---
phase: 1
title: Contract Tests
status: completed
priority: P1
effort: 45m
dependencies: []
---

# Phase 1: Contract Tests

## Overview

Write failing tests that lock the intended model contract before changing production code.

## Requirements

- Functional: tests must assert `gemini-3.5-flash` is the default for text-output Gemini tasks.
- Functional: tests must assert media generation registries do not accept or default to `gemini-3.5-flash`.
- Non-functional: tests should be deterministic and not hit Gemini API.

## Architecture

Add a focused unit test around `src/providers/gemini/models.ts`. The test should validate default routing and env override precedence without executing command actions. Keep media boundary checks local to model registries and existing TTS/video validators.

## Related Code Files

- Create: `tests/unit/providers/gemini/models.test.ts`
- Read: `src/providers/gemini/models.ts`
- Read: `src/providers/gemini/voices.ts`
- Read: `src/providers/gemini/commands/generate-video.ts`
- Read: `src/providers/gemini/commands/image-to-video.ts`

## Implementation Steps

1. Add `tests/unit/providers/gemini/models.test.ts`.
2. Test default model routing:
   - `getDefaultModel("analyze") === "gemini-3.5-flash"`
   - `getDefaultModel("transcribe") === "gemini-3.5-flash"`
   - `getDefaultModel("extract") === "gemini-3.5-flash"`
   - `DOC_MODEL_DEFAULT === "gemini-3.5-flash"`
3. Test env override precedence:
   - `MULTIMODAL_MODEL` overrides text-output defaults.
   - `GEMINI_MODEL` is used when `MULTIMODAL_MODEL` is absent.
   - `MULTIMODAL_MODEL` wins over `GEMINI_MODEL`.
4. Snapshot and restore relevant `process.env` keys around each override test:
   - `MULTIMODAL_MODEL`
   - `GEMINI_MODEL`
   - `IMAGE_GEN_MODEL`
   - `GEMINI_IMAGE_GEN_MODEL`
   - `VIDEO_GEN_MODEL`
   - `GEMINI_TTS_MODEL`
   - `TTS_MODEL`
5. Test media boundary:
   - `IMAGE_MODEL_DEFAULT` remains an image model, not `gemini-3.5-flash`.
   - `VIDEO_MODEL_DEFAULT` remains `veo-*`.
   - `GEMINI_IMAGE_MODELS` does not contain `gemini-3.5-flash`.
   - Both `generate-video` and `image-to-video` continue to use the `generate-video` default path and require `veo-*` models.
6. Extend `tests/unit/providers/gemini/speech.test.ts` or the new models test to assert `GEMINI_TTS_MODELS` does not contain `gemini-3.5-flash`.
7. Run the focused test and confirm it fails for the expected default assertions before Phase 2.

## Success Criteria

- [ ] Tests exist and fail against current `gemini-2.5-flash` defaults.
- [ ] Tests cover text-output defaults, env overrides, and media-generation exclusion.
- [ ] Env override tests restore `process.env` after each case.
- [ ] No network/API key required.

## Risk Assessment

Risk: tests become brittle if they duplicate production logic.
Mitigation: assert exported constants and public `getDefaultModel` behavior only.
