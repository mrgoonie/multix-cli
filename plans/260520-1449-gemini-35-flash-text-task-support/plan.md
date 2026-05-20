---
title: Gemini 3.5 Flash Text Task Support
description: >-
  TDD plan to support Gemini 3.5 Flash for Gemini text-output tasks only:
  analyze, transcribe, extract, and doc convert.
status: completed
priority: P2
branch: ''
tags:
  - gemini
  - models
  - tdd
  - docs
  - skill
blockedBy: []
blocks: []
created: '2026-05-20T07:49:16.555Z'
createdBy: 'ck:plan'
source: skill
---

# Gemini 3.5 Flash Text Task Support

## Overview

Promote `gemini-3.5-flash` as the supported default for Gemini text-output workflows:

- `multix gemini analyze`
- `multix gemini transcribe`
- `multix gemini extract`
- `multix doc convert`

Keep image, TTS, and video generation on their specialized models. Google docs verify `gemini-3.5-flash` accepts multimodal inputs but outputs text only, with image/audio generation unsupported. Research source: [standalone report](../reports/260520-1442-gemini-3-5-flash-omni-research.md).

## Scope

In:

- Add explicit model constants/tests for Gemini text-output models.
- Change default analysis/transcribe/extract/doc model from `gemini-2.5-flash` to `gemini-3.5-flash`.
- Preserve existing env override behavior: `MULTIMODAL_MODEL` / `GEMINI_MODEL` still override analyze/transcribe/extract; doc convert keeps `--model` override.
- Update `README.md` and repo packaged `skill/SKILL.md`.
- Verify help/build/typecheck/lint/tests.

Out:

- No Gemini Omni implementation until API docs/model ID exist.
- No `gemini-3.5-flash` in image, TTS, video, Live API, or OpenRouter media generation registries.
- No new `--thinking-level` flag in this patch.
- No provider architecture rewrite.

## Existing Touchpoints

- `src/providers/gemini/models.ts` owns Gemini defaults and task default routing.
- `src/commands/doc/index.ts` exposes the doc default in help text through `DOC_MODEL_DEFAULT`.
- `src/commands/doc/convert.ts` uses `DOC_MODEL_DEFAULT` when `--model` is omitted.
- `src/providers/gemini/commands/{analyze,transcribe,extract}.ts` use `getDefaultModel(...)`.
- `src/providers/gemini/commands/generate-video.ts` already rejects non-`veo-*` video models.
- `src/providers/gemini/commands/image-to-video.ts` also rejects non-`veo-*` video models through the same `generate-video` default path.
- `src/providers/gemini/voices.ts` owns the TTS allowlist.
- `README.md` and `skill/SKILL.md` are user-facing surfaces.
- Tests live under `tests/unit/**` and `tests/smoke/**`.

## Key Decisions

1. `gemini-3.5-flash` becomes the default text-output model because it is stable/current in the Gemini API and the user asked to support it in text-output commands.
2. Existing env names are sufficient. Do not add `GEMINI_35_MODEL` or similar.
3. Tests come first. The first phase should fail before implementation.
4. Skill update is required because users invoke `multix` through the packaged skill.
5. Omni is tracked in research only. No speculative API support.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Contract Tests](./phase-01-contract-tests.md) | Completed |
| 2 | [Model Registry And Defaults](./phase-02-model-registry-and-defaults.md) | Completed |
| 3 | [Docs And Skill Surface](./phase-03-docs-and-skill-surface.md) | Completed |
| 4 | [Verification](./phase-04-verification.md) | Completed |

## Dependencies

No blocking dependency. Older bootstrap/image-provider plans are stale relative to current code and remain non-blocking. This plan uses current source files plus the Gemini 3.5/Omni research report as source of truth.

## Success Criteria

- `gemini-3.5-flash` is the default for analyze/transcribe/extract/doc convert when no override is provided.
- `MULTIMODAL_MODEL` and `GEMINI_MODEL` still override analyze/transcribe/extract.
- `--model` still overrides doc convert.
- Image/TTS/video defaults and allowlists do not include `gemini-3.5-flash`.
- README and `skill/SKILL.md` document the new supported text-output default and the media-generation boundary.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` pass.

## Validation Log

### Verification Results

- **Tier:** Standard
- **Claims checked:** 18
- **Verified:** 18 | **Failed:** 0 | **Unverified:** 0

Verified plan facts:

1. `src/providers/gemini/models.ts` exports `ANALYSIS_MODEL_DEFAULT`, `DOC_MODEL_DEFAULT`, `VIDEO_MODEL_DEFAULT`, `IMAGE_MODEL_DEFAULT`, `GEMINI_IMAGE_MODELS`, and `getDefaultModel()`.
2. `getDefaultModel()` currently uses `MULTIMODAL_MODEL` before `GEMINI_MODEL` for analyze/transcribe/extract.
3. `src/commands/doc/index.ts` shows `DOC_MODEL_DEFAULT` in `doc convert --help`.
4. `src/commands/doc/convert.ts` uses `opts.model ?? DOC_MODEL_DEFAULT`.
5. `src/providers/gemini/commands/generate-video.ts` and `src/providers/gemini/commands/image-to-video.ts` both require `veo-*` models.
6. `src/providers/gemini/voices.ts` owns the TTS model allowlist.
7. `tests/smoke/parse-args.test.ts` uses `dist/cli.js`, so full smoke tests need a build first.

### Validation Decisions

1. Default vs opt-in: keep the plan decision to make `gemini-3.5-flash` the default for text-output tasks. User asked to add/support it for all four text-output commands, and official docs mark it stable/current.
2. Thinking controls: keep out of scope. No `--thinking-level` in this patch.
3. Gemini Omni: keep out of scope. No API docs/model ID yet.

## Red Team Review

| ID | Severity | Finding | Evidence | Disposition | Plan Delta |
|---|---|---|---|---|---|
| RT1 | High | Full `npm test` can fail or test stale CLI because smoke tests invoke `dist/cli.js`; verification order had build after tests. | `tests/smoke/parse-args.test.ts:11` | Accepted | Phase 4 now builds before full `npm test` and before CLI help smoke. |
| RT2 | Medium | Media boundary only named `generate-video`, but `image-to-video` also uses the Veo default path and should be explicitly protected. | `src/providers/gemini/commands/image-to-video.ts:70` | Accepted | Plan and phases now include `image-to-video` in video boundary checks. |
| RT3 | Medium | Env override tests mutate `process.env`; without cleanup they can leak into later tests. | `src/providers/gemini/models.ts:65` | Accepted | Phase 1 now requires env snapshot/restore around override tests. |

### Whole-Plan Consistency Sweep

- Files reread: `plan.md`, all four phase files.
- Decision deltas checked: 3.
- Reconciled stale references: 4.
- Unresolved contradictions: 0.
