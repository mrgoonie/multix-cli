---
phase: 4
title: Tests & README
status: completed
priority: P1
effort: 45m
dependencies:
  - 1
  - 2
  - 3
---

# Phase 4: Tests & README

## Overview
Unit tests for new `payload.ts` helpers. End-to-end validation against the live API for the failing case + 2 regressions. README doc updates.

## Requirements
- Functional: vitest unit tests cover modalities resolver, payload builder, response parser, and error formatter.
- Functional: live smoke test passes for `openai/gpt-5.4-image-2`, `google/gemini-2.5-flash-image`, `black-forest-labs/flux-kontext-pro`.
- Non-functional: no fake/mock data in unit tests where real shape is fixed; live test is manual (gated on `OPENROUTER_API_KEY`).

## Related Code Files
- Modify: `tests/unit/providers/openrouter/build-payload.test.ts` (extend with new cases)
- Create: `tests/unit/providers/openrouter/extract-images.test.ts`
- Modify: `README.md` (openrouter section)

## Implementation Steps

### Tests
1. Extend `build-payload.test.ts`:
   - `resolveModalities("openai/gpt-5.4-image-2")` → `["image","text"]`
   - `resolveModalities("google/gemini-2.5-flash-image")` → `["image","text"]`
   - `resolveModalities("black-forest-labs/flux-kontext-pro")` → `["image"]`
   - `resolveModalities("sourceful/foo")` → `["image"]`
   - `buildI2IPayload` cases: with/without `--strength`, with/without fallbacks, modalities matches model family, content order = images then text.
2. Create `extract-images.test.ts`:
   - Canonical Gemini-shape response → returns urls array.
   - Empty `images[]` + text content → returns `urls=[]`, `textContent`, `finishReason`.
   - Fallback path: `message.content[]` containing `image_url` parts → returns urls.
   - `formatNoImagesError` includes model id, finish reason, truncated text.
3. Run: `npm test -- openrouter` — all green.

### Live smoke (manual; gated by env)
4. Set `OPENROUTER_API_KEY`. Run from worktree root:
   ```
   node dist/index.js openrouter i2i --prompt "chuyển hình ảnh này thành phong cách vẽ phác thảo và có chút màu nước" --ref tests/demo/zuey.png -m openai/gpt-5.4-image-2 -v
   node dist/index.js openrouter i2i --prompt "make it watercolor" --ref tests/demo/zuey.png -m google/gemini-2.5-flash-image -v
   node dist/index.js openrouter i2i --prompt "cyberpunk style" --ref tests/demo/zuey.png -m black-forest-labs/flux-kontext-pro -v
   ```
   Each must save a PNG under `multix-output/`.

### README
5. In `## multix openrouter` section:
   - Add `[--strength <0..1>]` to the `image-to-image` usage line.
   - Add a short note: "Supported model families: Gemini (default), OpenAI gpt-image, Recraft, Flux/Sourceful (image-only). `--strength` is Recraft-specific."
   - Note that `OPENROUTER_FALLBACK_MODELS` now also applies to i2i (was generate-only).

## Success Criteria
- [ ] All vitest unit tests pass: `npm test`.
- [ ] Live: `openai/gpt-5.4-image-2` invocation produces a PNG.
- [ ] Live: `google/gemini-2.5-flash-image` still produces a PNG.
- [ ] Live: `black-forest-labs/flux-kontext-pro` still produces a PNG.
- [ ] README updated; `multix openrouter i2i --help` matches.
- [ ] `npm run build` clean; lint clean (`biome check` if configured).

## Risk Assessment
- Risk: live tests need API credits + may flake on provider downtime. Mitigation: require unit test green as primary gate; live smoke is final acceptance.
- Risk: README drift if other openrouter commands change concurrently. Mitigation: limited scope edit to i2i subsection only.

## Next Steps
- After all phases pass: commit + push, open PR back to `main`.
- Delegate to `docs-manager` if additional docs (codebase-summary) need refresh.
