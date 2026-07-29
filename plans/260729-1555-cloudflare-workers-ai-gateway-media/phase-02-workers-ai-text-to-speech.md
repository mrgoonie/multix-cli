---
phase: 2
title: "Workers AI text to speech"
status: completed
priority: P1
effort: "2-3h"
dependencies: [1]
---

# Phase 2: Workers AI text to speech

## Overview

Expose the confirmed MeloTTS contract as `multix cloudflare generate-speech`; save MP3 without assuming every Workers AI response is JSON.

## Requirements

- Default/only curated TTS model: `@cf/myshell-ai/melotts`.
- Map CLI `--text` to model `prompt`; support documented `--lang`; `--output` overrides the generated MP3 destination.
- Request and persist the documented binary `audio/mpeg` response. The catalog page also permits JSON but does not document a stable JSON audio field, so reject that unmodeled form rather than inventing a parser.

## Related code files

- Create: `src/providers/cloudflare/commands/generate-speech.ts` — Commander action and validation.
- Create: `src/providers/cloudflare/media-output.ts` — bounded binary/base64 persistence helpers shared with image phase.
- Create: `tests/unit/providers/cloudflare/generate-speech.test.ts` — payload/result/output cases.
- Modify: `src/providers/cloudflare/commands/index.ts` — register command after its test contract exists.

## Tests first

1. Assert `--text`, default model, language, direct/Gateway transport, and explicit output generate the correct request/result path.
2. Stub binary MP3 and assert bytes written with no base64/text corruption.
3. Assert bad language/model, missing text, failed envelope, JSON output, absent audio, and unexpected content type fail before/after fetch as appropriate.

## Implementation steps

1. Add the command with `--text`, `--lang`, `--model`, `--output`, and `--verbose`; avoid unsupported voice/streaming flags.
2. Build `{prompt, lang?}` and delegate routing/response handling to Phase 1.
3. Save one `.mp3` under `MULTIX_OUTPUT_DIR` unless `--output` is supplied; print only the destination and model, never configuration values.
4. Register the command and run its unit tests plus typecheck.

## Success criteria

- [ ] Direct and Gateway TTS preserve `{prompt, lang?}`.
- [ ] The documented MP3 response produces playable bytes; unmodeled JSON never becomes a corrupt file.
- [ ] Validation and provider failures leave no partial output file.

## Risks and rollback

Binary output may vary by content type. Treat only documented MP3 binary as supported and surface a safe error for JSON/new shapes; do not guess an extension.
