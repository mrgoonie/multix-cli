---
phase: 1
title: "Interaction client, Files API bridge, and capability registry"
status: complete
priority: P1
effort: "6h"
dependencies: []
---

# Phase 01: Interaction Client, Files API Bridge, and Capability Registry

## Overview

Create typed, testable Gemini Interaction API helpers without disturbing the existing `generateContent` and Veo operation paths. Centralize image-model capability rules so `generate` and `image-to-image` cannot drift.

## Requirements

- Call `https://generativelanguage.googleapis.com/v1beta/interactions` with `x-goog-api-key`; preserve the current error hierarchy and never expose credentials.
- Represent prompt, inline image, uploaded-video `document` URI, `previous_interaction_id`, returned interaction ID, and video delivery variants without broad `any` propagation. Fixture the raw REST `input` and `steps[].content[]` schema rather than reading SDK-only convenience fields.
- Reuse `uploadFile()` / `FileRef` but make the caller able to require Files API for Omni video regardless of file size; poll `PROCESSING`, reject `FAILED`, timeout cleanly, and only submit `ACTIVE` files.
- Request URI delivery explicitly, capture its creation-response URI before any interaction GET, poll the generated File to `ACTIVE`, and download it through an authenticated Gemini boundary. Parse inline base64 as a supported fallback. A structurally valid response with no video is a provider error, not a successful empty output.
- Make the storage trade-off explicit: stateful edits use default `store=true`; never silently set `store=false`, which disables `previous_interaction_id` follow-ups.
- Add a named Lite model constant and capability helper validating the documented ratios and forcing 1K when that model is selected. Existing model defaults and non-Lite sizes remain compatible.

## Related code files

- Modify: `src/providers/gemini/client.ts`
- Modify: `src/providers/gemini/models.ts`
- Read only for compatibility: `src/core/http-client.ts`, `src/core/errors.ts`, `src/providers/gemini/task-resolver.ts`
- Create: `tests/unit/providers/gemini/interaction-client.test.ts`
- Create: `tests/unit/providers/gemini/image-model-capabilities.test.ts`
- Reuse: `tests/helpers/mock-fetch.ts`

## Implementation steps

1. Write failing fixtures that inspect the Interaction endpoint, auth header, raw body input parts (including a video File URI as `document`), optional `previous_interaction_id`, input and generated-output Files poll behavior, raw `steps[].content[]` variants, malformed response handling, and Lite 1K/ratio validation.
2. Introduce small exported request/response types and functions in `client.ts`: submit interaction with explicit URI delivery, normalize raw output, poll generated Files, and download a URI with the same authenticated/error-aware boundary as other Gemini file access. Keep generic `generateContent` unchanged.
3. Reuse `uploadFile()` for local video but expose only the minimum option necessary to force the existing upload/poll route; do not duplicate MIME tables or multipart code.
4. Add `IMAGE_MODEL_LITE` plus a model-capability function in `models.ts`; use the existing `ASPECT_RATIOS` constant as the single source of accepted values.
5. Run the two new focused suites, then `npm run typecheck` before handing the helpers to command phases.

## Success criteria

- [x] Tests prove raw interaction request/output variants and provider-storage request behavior.
- [x] Files API `PROCESSING → ACTIVE` is awaited before an Omni request and before URI-delivered video download; `FAILED` and timeout fail deterministically.
- [x] Lite capability validation accepts only the specified ratios and 1K; non-Lite behavior is unchanged.
- [x] No SDK, credential, persistent state, or new general-purpose media abstraction is introduced.

## Risks and mitigations

- Preview API response fields can change. Keep raw-field decoding contained to one client adapter and assert a useful unexpected-response error.
- URI downloads may need Gemini auth. Test that the client uses the required authenticated fetch path rather than the unauthenticated generic downloader.
- Files can be large. Keep the existing stream/buffer trade-off documented; this phase must not silently route a user video inline.
