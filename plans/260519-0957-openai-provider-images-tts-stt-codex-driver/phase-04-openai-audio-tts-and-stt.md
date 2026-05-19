---
phase: 4
title: "OpenAI Audio TTS and STT"
status: complete
priority: P1
effort: "3h"
dependencies: [1]
---

# Phase 4: OpenAI Audio TTS and STT

## Context Links

- OpenAI TTS docs: `https://developers.openai.com/api/docs/guides/text-to-speech`
- OpenAI STT docs: `https://developers.openai.com/api/docs/guides/speech-to-text`
- Existing TTS command pattern: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/elevenlabs/commands/tts.ts`
- Existing STT command pattern: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/elevenlabs/commands/transcribe.ts`

## Overview

Implement OpenAI TTS and STT commands using Audio API endpoints. Keep diarization explicit and model-aware.

## Requirements

- Functional: `generate-speech` returns audio bytes and writes to output.
- Functional: `transcribe` accepts local audio/video file and writes text/json outputs.
- Functional: diarization works only when `--model gpt-4o-transcribe-diarize`; `--format diarized_json` implies required chunking strategy.
- Functional: CLI `--format text` for `gpt-4o-transcribe` and `gpt-4o-mini-transcribe` must request API `response_format=json` and write the returned `.text`; do not send unsupported API `response_format=text` for those models.
- Functional: known speaker support uses paired `--known-speaker-name <name>` and `--known-speaker-reference <path>` flags, converted to `known_speaker_names[]` and `known_speaker_references[]` data URLs.
- Non-functional: no streaming in first pass.
- Non-functional: no fake SRT/VTT conversion for models that do not support those formats.

## Architecture

Add audio helpers in OpenAI provider:

```text
POST /v1/audio/speech         -> binary response
POST /v1/audio/transcriptions -> multipart response
```

Reuse `readFileAsBlob` style from ElevenLabs or move a small generic file-to-File helper into OpenAI client. Do not refactor all providers in this feature.

## Related Code Files

- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/client.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/openai-audio.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/commands/generate-speech.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/commands/transcribe.ts`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/commands/index.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/unit/providers/openai/audio-payload.test.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/unit/providers/openai/transcribe-validation.test.ts`

## Implementation Steps

### Tests Before

1. Add failing TTS tests:
   - default model `gpt-4o-mini-tts`
   - default/recommended voice behavior accepts `marin` and `cedar`
   - `instructions` are included only when passed
   - binary response saves correct extension
2. Add failing STT tests:
   - `gpt-4o-transcribe` CLI `text` maps to API `response_format=json`, then extracts `.text`.
   - `gpt-4o-mini-transcribe` CLI `text` maps to API `response_format=json`, then extracts `.text`.
   - `gpt-4o-transcribe-diarize` API `response_format` can be `json`, `text`, or `diarized_json`.
   - `diarized_json` requires diarize model or errors.
   - diarize model with long audio defaults `chunking_strategy=auto` when not provided
   - known speaker names and references must have equal counts, max 4, and references become audio data URLs.

### Refactor

3. Implement `generateOpenAISpeech()` with `apiPostBinary`.
4. Implement `transcribeOpenAIAudio()` with multipart FormData.
5. Implement model/format validation helpers in `models.ts`.
6. Implement `resolveTranscriptionRequestFormat(cliFormat, model)` so CLI output format and API `response_format` are separate concepts.
7. Implement known speaker reference conversion using supported audio file extensions and 2-10 second duration note in validation error/docs. Do not inspect duration unless using an existing media helper; rely on API error in first pass if duration is unknown.
8. Register commands.
9. Print transcript to stdout only for text format, matching ElevenLabs behavior.

### Tests After

8. Add mocked HTTP success/error tests.
9. Add CLI help smoke coverage for audio commands.

### Regression Gate

```bash
npm run typecheck
npm test -- tests/unit/providers/openai tests/smoke
```

## Success Criteria

- [x] TTS writes playable bytes to output path.
- [x] STT writes requested output format.
- [x] Diarization cannot be accidentally requested with incompatible model/format.
- [x] Non-diarize GPT transcription models never receive unsupported API `response_format=text`.
- [x] Known speaker flags map to paired names/reference data URLs or fail validation.
- [x] No streaming claims in help/docs.

## Risk Assessment

- Risk: model/format compatibility can change. Mitigation: central validators and docs links.
- Risk: video input may be large. Mitigation: rely on API errors in first pass; do not add ffmpeg pre-processing unless required.

## Security Considerations

- Do not log transcript content in verbose mode except intentional stdout for text format.
- Do not log file contents or API key.
