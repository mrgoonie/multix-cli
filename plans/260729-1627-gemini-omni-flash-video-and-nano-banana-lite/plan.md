---
title: "Gemini Omni Flash Video and Nano Banana 2 Lite"
description: "Add paid-preview Gemini Omni video generation and iterative video editing, plus Nano Banana 2 Lite image generation and editing."
status: pending
priority: P1
effort: "2-3d"
branch: "feat/gemini-omni-video-editing"
tags: [gemini, video, image, preview, tdd]
blockedBy: []
blocks: []
created: "2026-07-29"
source: "GitHub issue #21"
---

# Plan: Gemini Omni Flash Video and Nano Banana 2 Lite

## Outcome

Expose paid-preview Gemini capabilities through the existing `multix gemini` group:

```text
multix gemini omni-video --prompt "..." [--video ./clip.mp4] [--image ./frame.png] \
  [--previous-interaction-id <id>] [--output ./result.mp4]
multix gemini generate --model gemini-3.1-flash-lite-image --prompt "..." --size 1K
multix gemini image-to-image --model gemini-3.1-flash-lite-image --prompt "..." --ref ./image.png
```

`omni-video` is deliberately separate from the existing Veo `generate-video` / `image-to-video` operations: Omni uses the synchronous Interaction API and returns an interaction ID that the user supplies on the next edit. It does not add hidden local conversation storage.

## Constraints and non-goals

- Use raw REST only: `POST /v1beta/interactions`, model `gemini-omni-flash-preview`, and the existing `GEMINI_API_KEY` resolver. Do not add Google SDKs or new credentials. Keep raw `input` and `steps[].content[]` parsing in a fixture-tested adapter; never rely on SDK-only `output_video` fields.
- A local uploaded video always goes through the Gemini Files API, waits for `ACTIVE`, then sends its file URI as the documented `document` input. Images may use inline data; the final request shape and response variants stay isolated in the client.
- Request `response_format: { type: "video", delivery: "uri" }` for Omni. Capture the creation response's file URI, poll the generated File to `ACTIVE`, then download it with Gemini authentication; still parse inline base64 where supplied.
- Iterative Omni edits use explicit `--previous-interaction-id`; do not persist history locally, extend/interpolate video, edit voices, accept audio references, or accept multiple video inputs. Explain that this requires provider-side storage (`store=true`), which is retained for up to 55 days on the paid tier and cannot be combined with `store=false`.
- Reject unsupported local inputs before a paid request. Explain preview/billing requirements and the documented EEA/CH/UK uploaded-video-edit restriction in help/README; do not attempt client-side geography detection.
- Lite uses `gemini-3.1-flash-lite-image`, 1K only, and only `1:1`, `3:2`, `2:3`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`. It remains one request per edit: multi-reference and multi-turn editing are warned as not optimized, not replaced with a new workflow.

## Acceptance criteria

- `multix gemini --help` lists `omni-video`; its help documents prompt-only, image/video input, iterative-edit, output, billing/preview, and unsupported-mode behavior.
- A video input is uploaded and polled through Files API even below the general 20 MB inline threshold; only one video is accepted. An `ACTIVE` URI is used in the interaction request.
- Omni request serialization includes the selected input parts and, when present, `previous_interaction_id`; fixtures assert the raw REST request and `steps[].content[]` response parsing. Response handling returns the new interaction ID plus the first generated video from inline data or a completed URI-delivered File.
- Generated MP4 is written atomically enough for normal CLI use to the standard output directory, copied to `--output` when requested, and failures retain provider/HTTP context without printing the API key.
- Lite is selectable for both Gemini generate and image-to-image; invalid Lite size/aspect combinations fail before network work, while existing image models preserve their current size behavior.
- Focused unit tests, CLI help smoke tests, `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build` pass. A manually authorized paid beta smoke proves prompt-to-video, one iterative edit, Lite generate, and Lite single-reference edit without committing media or credentials.

## Phases

| # | File | Title | Status | Depends on |
|---|---|---|---|---|
| 01 | [phase-01-gemini-interaction-client.md](phase-01-gemini-interaction-client.md) | Interaction client, Files API bridge, and capability registry | pending | — |
| 02 | [phase-02-omni-video-command.md](phase-02-omni-video-command.md) | Omni video generation and explicit conversational editing CLI | pending | 01 |
| 03 | [phase-03-nano-banana-lite-image-commands.md](phase-03-nano-banana-lite-image-commands.md) | Lite image generation/editing validation and UX | pending | 01 |
| 04 | [phase-04-documentation-verification-beta.md](phase-04-documentation-verification-beta.md) | README, full verification, and beta release evidence | pending | 02, 03 |

## TDD sequence

1. Add failing unit cases for raw request serialization, Files API `PROCESSING → ACTIVE` for both uploaded input and URI output, `steps[].content[]` inline/URI extraction, and Lite capability validation plus exact request configuration.
2. Implement the narrowly exported client/model helpers until those tests pass.
3. Add failing CLI help/argument validation cases, implement `omni-video` and command integrations, then make focused tests pass.
4. Update README only after command behavior is locked; run the complete quality gates and the paid manual beta smoke last.

## Dependencies and docs impact

- The historical `plans/260505-1315-images-to-image-all-providers/` plan overlaps only in the existing Gemini i2i command and is nonblocking; this plan changes the current code directly.
- Docs impact: minor but required. Update [README.md](../../README.md) only; no evergreen `docs/` tree exists and no new environment variable is needed.

## Release checks

Commit as a focused `feat:` change. Before a dev-channel beta release, verify exact branch/SHA, all local gates, generated CLI help, paid-preview account access, and four manual smoke scenarios. Publish only through the existing dev Release Please prerelease workflow; confirm the npm `beta` receipt and install/smoke the exact beta package before proposing stable promotion.

## Unresolved questions

None. The implementation must re-check the Interaction API's current request/response field names immediately before coding because the feature is preview, while preserving the command contract above.
