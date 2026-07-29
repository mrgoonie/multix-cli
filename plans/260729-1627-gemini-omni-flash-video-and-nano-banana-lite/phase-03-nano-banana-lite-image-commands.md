---
phase: 3
title: "Lite image generation/editing validation and UX"
status: pending
priority: P2
effort: "4h"
dependencies: [1]
---

# Phase 03: Nano Banana 2 Lite Image Generation and Editing Validation and UX

## Overview

Make `gemini-3.1-flash-lite-image` a first-class, correctly constrained option for the existing image generation and image-to-image commands, rather than introducing duplicate Lite-only commands.

## Requirements

- `multix gemini generate --model gemini-3.1-flash-lite-image` accepts only 1K and the Lite aspect-ratio set; omitted size resolves to 1K. Tests must assert the outgoing `generationConfig` includes the resolved `1K` and selected aspect ratio.
- Reject `--size 2K` / `4K` and unsupported aspect ratios before network work when Lite is selected. Preserve current generic size validation for other supported models.
- `multix gemini image-to-image --model gemini-3.1-flash-lite-image` remains a single-request edit using the existing image parts. Add any missing `--aspect-ratio` / size handling only when needed to send the validated Lite image configuration, and assert it in a request-construction test; do not add previous-interaction support.
- Help and README describe 1K-only and the practical caveat that Lite is not optimized for multiple references or multi-turn edits. Keep multi-ref syntax backward compatible; warn clearly when Lite is used with more than one ref rather than silently pretending it is robust.

## Related code files

- Modify: `src/providers/gemini/commands/generate.ts`
- Modify: `src/providers/gemini/commands/image-to-image.ts`
- Read only: `src/providers/gemini/models.ts`, `src/providers/gemini/client.ts`, `src/core/image-input.ts`
- Modify: `tests/unit/providers/gemini/image-model-capabilities.test.ts`
- Create or extend: `tests/unit/providers/gemini/generate-command.test.ts`
- Create or extend: `tests/unit/providers/gemini/image-to-image-command.test.ts`
- Modify: `tests/smoke/parse-args.test.ts`

## Implementation steps

1. Extend Phase 01 failing cases into command-level tests for defaulted Lite 1K, rejected 2K/4K, valid landscape/portrait ratios, and multi-ref warning behavior.
2. Route both command implementations through the shared capability helper before issuing `generateContent`; keep request assembly specific to the command and avoid a large provider abstraction.
3. Ensure `imageConfig` is sent only with fields the selected model supports and the existing default Nano Banana 2 behavior stays unchanged.
4. Update smoke help expectations only after the help strings accurately communicate the model limits; run focused image test suites and typecheck.

## Success criteria

- [ ] Lite generate and edit work through existing CLI surfaces and use the exact model ID.
- [ ] Invalid Lite capability combinations make no HTTP request.
- [ ] Existing image model defaults, aspect ratios, outputs, and multi-ref contract remain backward compatible.
- [ ] Users see the Lite optimization caveat before relying on multi-ref/multi-turn workflows.

## Risks and mitigations

- Reusing global `IMAGE_SIZES` can accidentally advertise 2K/4K for Lite. Model-aware validation and help wording must override that generic list.
- A hard multi-ref ban would be an unnecessary compatibility break. Warn instead, unless current API verification proves a hard limit.
