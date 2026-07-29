---
phase: 2
title: "Omni video generation and explicit conversational editing CLI"
status: complete
priority: P1
effort: "6h"
dependencies: [1]
---

# Phase 02: Omni Video Generation and Explicit Conversational Editing CLI

## Overview

Register a focused `multix gemini omni-video` command that uses the Interaction API. A user edits a previous result by repeating the command with its printed `--previous-interaction-id`, making conversation state explicit and portable.

## Requirements

- Command contract:

  ```text
  multix gemini omni-video --prompt <text>
    [--video <local-path>] [--image <local-path>]...
    [--previous-interaction-id <id>] [--output <path>] [-v]
  ```

- Require a prompt; permit prompt-only generation, image guidance, or one uploaded local video. Reject a second video, URL video input, missing files, unsupported extensions, and conflicting input combinations before the paid API call.
- On success, write a descriptive `.mp4` to `getOutputDir()`, copy it to `--output` when provided, write a sidecar JSON with provider/model/prompt/input basenames/timestamp/interaction ID, and print both the saved file and new interaction ID prominently for the next edit. The sidecar must omit credentials and absolute local paths.
- Help and validation must state paid-preview, 3–10 second 720p output, no audio refs, no video extension/interpolation/voice editing, unsupported multi-video, and the EEA/CH/UK uploaded-video-edit limitation. It must also disclose that a follow-up ID relies on provider-side stored interactions; no local history is retained, and `store=false` cannot support follow-up edits. Do not imply that ≤3-second video references will be processed correctly.
- Preserve Veo commands unchanged. Do not overload `generate-video` model validation or coerce the Omni model through Veo operations.

## Related code files

- Create: `src/providers/gemini/commands/omni-video.ts`
- Modify: `src/providers/gemini/commands/index.ts`
- Read only: `src/providers/gemini/commands/generate-video.ts`, `src/providers/gemini/commands/image-to-video.ts`, `src/core/output-dir.ts`, `src/core/errors.ts`
- Modify: `tests/smoke/cli.test.ts`
- Modify: `tests/smoke/parse-args.test.ts`
- Create or extend: `tests/unit/providers/gemini/omni-video-command.test.ts`

## Implementation steps

1. Add failing command-level tests for registration/help, input preflight, single-video enforcement, previous-ID forwarding, output naming/copy semantics, metadata redaction, and a no-video interaction.
2. Implement the command using Phase 01 helpers. Keep parsing/preflight and file save logic in small local helpers so tests can cover them without spawning a process or exiting it.
3. Register the command after existing Gemini commands; update smoke command arrays and assert help includes `omni-video`.
4. Validate the focused unit/smoke tests, then run `npm run build` and use compiled `dist/cli.js gemini omni-video --help` as a contract check.

## Success criteria

- [x] Omni and Veo use separate commands/endpoints.
- [x] A generated interaction ID is printed and can be supplied in the next command.
- [x] Unsupported input validation runs before upload/submission with actionable errors.
- [x] Both output transports are implemented with local MP4 and `--output` sidecar-copy behavior; paid live verification remains in Phase 04.

## Risks and mitigations

- The API may reject some mixed image/video requests. Preserve API error text through `ProviderError`; do not invent fallback behavior.
- CLI output is the continuation contract. Keep the interaction ID on a stable labelled line; do not promise local history recovery.
- Geographical availability is account-side. Document the restriction, but do not make unreliable client-side region guesses.
