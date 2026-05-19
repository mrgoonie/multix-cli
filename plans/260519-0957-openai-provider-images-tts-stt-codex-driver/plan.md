---
title: "OpenAI Provider Images TTS STT and Codex Image Driver"
description: "Add a first-class OpenAI provider for image generation/editing, TTS, STT, plus an experimental Codex CLI image driver fallback."
status: complete
priority: P1
effort: 16h
issue:
branch: "HEAD (detached)"
tags: [feature, api, experimental, tdd]
blockedBy: []
blocks: []
created: "2026-05-19T02:58:00.299Z"
createdBy: "ck:plan"
source: skill
---

# OpenAI Provider Images TTS STT and Codex Image Driver

## Overview

Add `multix openai` with direct OpenAI API support for:
- Image generation via Image API.
- Image editing / image-to-image via Image API edits.
- Text-to-speech via Audio Speech API.
- Speech-to-text via Audio Transcriptions API, with diarization as explicit opt-in.
- Experimental Codex CLI image driver when `OPENAI_API_KEY` is absent but `codex login status` confirms ChatGPT auth.

Scope is HOLD. User approved Approach A: raw HTTP provider, image-to-image included, diarization recommended as opt-in, and minor release after implementation. Do not add OpenAI SDK in first pass. Do not make Codex the primary provider contract.

## Scope Challenge

- Existing code: provider shape already exists under `src/providers/{provider}/`; env resolution, HTTP JSON, multipart patterns, output dir, `image-input.ts`, smoke tests, release workflow already exist.
- Minimum changes: add OpenAI provider files, register command, update `check`, README, `.env.example`, smoke/unit tests. No Realtime API. No streaming audio/image. No multi-turn Responses image flow.
- Complexity: expected >8 files because this is a full provider plus docs/tests. Justified by matching existing provider boundaries, not one large file.
- Selected mode: HOLD with `--hard --tdd`.

## Research Inputs

- [OpenAI API research](./research/researcher-01-openai-api-surface.md)
- [Codex CLI driver research](./research/researcher-02-codex-cli-driver.md)
- [Codebase scout report](./reports/scout-openai-provider-patterns.md)

## Key Decisions

- Use raw HTTP via Node 20 `fetch`, consistent with existing providers.
- Default driver: `auto`.
  - If `OPENAI_API_KEY` is present, use OpenAI API.
  - Else if `codex login status` says `Logged in using ChatGPT`, use Codex CLI image driver for image commands only.
  - Else fail with clear setup guidance.
- Codex driver is experimental, image-only, and never handles auth. User must run `codex login` manually.
- Diarization is opt-in through `--model gpt-4o-transcribe-diarize` and `--format diarized_json`; default remains non-diarized `gpt-4o-transcribe`.
- `image-to-image` ships in first pass as `multix openai image-to-image` and alias `i2i`.

## Target CLI

```bash
multix openai generate --prompt "..." [--driver api|codex|auto] [--model gpt-image-2] [--size 1024x1024] [--quality low|medium|high] [--format png|jpeg|webp] [--output <path>] [-v]
multix openai image-to-image --prompt "..." --ref ./photo.png [--ref ./style.png] [--driver api|codex|auto] [--model gpt-image-2] [--size 1024x1024] [--quality low|medium|high] [--format png|jpeg|webp] [--output <path>] [-v]
multix openai generate-speech --text "..." [--model gpt-4o-mini-tts] [--voice marin|cedar|...] [--instructions "..."] [--output-format mp3|wav|opus|aac|flac|pcm] [--output <path>] [-v]
multix openai transcribe --input ./audio.mp3 [--model gpt-4o-transcribe] [--format json|text|diarized_json] [--language vi] [--chunking-strategy auto] [--known-speaker-name <name> --known-speaker-reference <path>] [--output <path>] [-v]
```

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Contract and Test Harness](./phase-01-contract-and-test-harness.md) | Complete |
| 2 | [OpenAI Image API Generate and Edit](./phase-02-openai-image-api-generate-and-edit.md) | Complete |
| 3 | [Codex CLI Image Driver](./phase-03-codex-cli-image-driver.md) | Complete |
| 4 | [OpenAI Audio TTS and STT](./phase-04-openai-audio-tts-and-stt.md) | Complete |
| 5 | [Docs Check Command and Skill Surface](./phase-05-docs-check-command-and-skill-surface.md) | Complete |
| 6 | [Release Validation and Publish Prep](./phase-06-release-validation-and-publish-prep.md) | Complete |

## Dependencies

- Existing stale/complete plans overlap provider patterns and image-to-image helpers, but no blocking dependency detected. This plan uses current code as source of truth.
- Requires `codex` executable for experimental Codex driver tests that are not mocked. Unit tests must mock process spawning.
- Requires `OPENAI_API_KEY` only for real live smoke, not for CI/unit tests.

## File Ownership

- Phase 1 owns test contracts and shared OpenAI model/driver type files.
- Phase 2 owns OpenAI image API client/generator/commands.
- Phase 3 owns Codex CLI driver and command integration points specific to `--driver`.
- Phase 4 owns OpenAI audio commands/client helpers.
- Phase 5 owns docs, `check`, env examples, skill text.
- Phase 6 owns release validation commands, changelog/version prep notes.

## Validation Log

### Implementation Completed
- Added `multix openai` with image generation/editing, OpenAI TTS, OpenAI STT, and experimental Codex image driver.
- Added unit coverage for OpenAI model contracts, driver selection, image payload/save behavior, audio payloads, transcription validation, Codex runner validation, and check readiness.
- Added smoke coverage for top-level `openai` and OpenAI subcommands.
- Updated README, `.env.example`, `skill/SKILL.md`, `CHANGELOG.md`, and package metadata for `0.1.0`.

### Validation Commands
- `npm run typecheck` — pass.
- `npm run lint` — pass.
- `npm test` — pass, 26 files / 198 tests.
- `npm run build` — pass.
- `npm pack --dry-run` — pass, package `@mrgoonie/multix@0.1.0`.
- Codex spike: `codex exec --ephemeral --skip-git-repo-check --cd <tmp> --output-schema <schema> --output-last-message <result>` produced a non-empty PNG.

### User Decisions Recorded
- Image-to-image included in first pass.
- Diarization recommended as opt-in, not default.
- Minor release after implementation.
- Codex CLI auth is user-managed; `multix` only detects status and uses Codex programmatically when available.

## Red Team Review

### Findings Applied

1. High: OpenAI API image edit path initially planned to reject URL refs. This would regress `multix` i2i UX, where refs commonly accept path or URL. Fix: phase 2 now requires URL refs to be downloaded to multipart bytes before upload.
2. Medium: Codex driver could falsely succeed if final agent text claims success. Fix: phase 3 requires filesystem validation as the only success signal.
3. Medium: Diarization defaults could surprise users if auto-enabled. Fix: phase 4 keeps diarization opt-in by model/format and documents compatibility.
4. High: STT plan risked sending unsupported `response_format=text` to `gpt-4o-transcribe`/mini. OpenAI reference says those models only support API `response_format=json`; CLI `--format text` must request JSON and extract `.text`.
5. High: Codex CLI image driver lacked a go/no-go spike and schema enforcement. `codex exec` can write final text without producing an image. Phase 3 now requires a manual capability spike, `--output-schema`, filesystem validation, and sanitized env.
6. Medium: `--known-speaker <name>` was underspecified. OpenAI diarization expects `known_speaker_names[]` paired with `known_speaker_references[]` data URLs. CLI now plans explicit name/reference flags.
7. Medium: `multix check` could still exit 1 with no API keys even when Codex image driver is authenticated. Phase 5 now requires authenticated Codex driver to count as an experimental image capability in check summary.

### Whole-Plan Consistency Sweep

- Searched plan files for stale claims: `URL refs error`, `free`, `unlimited`, `streaming`, `OpenAI SDK`, `response_format=text`, `known-speaker <name>`, placeholders, and `UNVERIFIED`.
- Reconciled phase 2 with existing provider UX: image refs are path or URL; API mode downloads URLs into multipart image files.
- Reconciled phase 3 with Codex CLI reality: add capability spike, `--output-schema`, sanitized env, and no success without output file validation.
- Reconciled phase 4 with current OpenAI transcription reference: CLI text output for non-diarize GPT transcription models derives from JSON response, not API `response_format=text`.
- Reconciled phase 5 with Codex-only setup: `multix check` can report ready for experimental image generation when Codex auth is available, while still warning that API features require keys.
- Reconfirmed no streaming, Realtime, Responses multi-turn, or SDK implementation is in scope.
- Status: zero unresolved contradictions.

## Boundary Reminder

Implementation command after review:

```bash
/ck:cook /Users/duynguyen/.codex/worktrees/fffd/multix-cli/plans/260519-0957-openai-provider-images-tts-stt-codex-driver/plan.md --tdd
```
