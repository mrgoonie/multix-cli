---
phase: 3
title: Docs And Skill Surface
status: completed
priority: P2
effort: 1h
dependencies:
  - 2
---

# Phase 3: Docs And Skill Surface

## Overview

Update user-facing documentation and the packaged repo skill so `gemini-3.5-flash` support is discoverable and correctly scoped.

## Requirements

- Functional: README documents `gemini-3.5-flash` for analyze/transcribe/extract/doc convert.
- Functional: `skill/SKILL.md` includes the new default in command guidance.
- Functional: docs explicitly avoid implying `gemini-3.5-flash` generates images, TTS, or videos.
- Non-functional: concise wording; no speculative Omni API commands.

## Architecture

Documentation should mirror the code boundary:

- Text-output Gemini tasks: `gemini-3.5-flash`.
- Image: Nano Banana / Imagen model IDs.
- Video: Veo model IDs.
- TTS: Gemini Flash TTS model IDs.

## Related Code Files

- Modify: `README.md`
- Modify: `skill/SKILL.md`
- Optional modify: `.env.example` only if it currently lists model defaults that become stale.
- Read: `plans/reports/260520-1442-gemini-3-5-flash-omni-research.md`

## Implementation Steps

1. README:
   - Update env table wording for `MULTIMODAL_MODEL` to mention default `gemini-3.5-flash`.
   - Update Gemini command examples or model list:
     - Analysis default: `gemini-3.5-flash`.
     - Doc convert example: `--model gemini-3.5-flash`.
   - Add one short note: `gemini-3.5-flash` is text-output only; use Nano Banana/Imagen, Veo, and Flash TTS for media generation.
2. Skill:
   - Update description or usage sections for analyze/transcribe/extract/doc convert.
   - Add an explicit command example:
     - `multix gemini analyze --files photo.jpg --model gemini-3.5-flash --prompt "..."`
     - `multix doc convert --input report.pdf --model gemini-3.5-flash`
   - Keep image/video/TTS sections on existing specialized models.
3. Do not add Gemini Omni commands. At most mention API pending in prose if useful, but avoid making it look executable.
4. Add or update smoke/help assertions only if current test coverage checks hardcoded README/help strings.

## Success Criteria

- [ ] README and skill agree with code defaults.
- [ ] Skill update is repo-local under `skill/SKILL.md`; no global skill directory touched.
- [ ] Docs do not route `gemini-3.5-flash` to media generation commands.
- [ ] Old explicit model override remains documented enough for fallback users.

## Risk Assessment

Risk: docs overpromise Gemini Omni or media support.
Mitigation: phrase Omni as "API pending" only if mentioned; no commands until Google publishes API docs/model ID.
