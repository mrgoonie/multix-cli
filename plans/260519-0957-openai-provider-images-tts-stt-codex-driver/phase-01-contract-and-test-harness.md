---
phase: 1
title: "Contract and Test Harness"
status: complete
priority: P1
effort: "2h"
dependencies: []
---

# Phase 1: Contract and Test Harness

## Context Links

- Plan: `plans/260519-0957-openai-provider-images-tts-stt-codex-driver/plan.md`
- Research: `research/researcher-01-openai-api-surface.md`
- Scout: `reports/scout-openai-provider-patterns.md`

## Overview

Define OpenAI provider contract and tests before implementation. Lock CLI names, model defaults, output formats, driver selection, and error behavior.

## Requirements

- Functional: `multix openai --help` must expose `generate`, `image-to-image`, `i2i`, `generate-speech`, `transcribe`.
- Functional: driver resolver must select API before Codex when `OPENAI_API_KEY` exists.
- Non-functional: no live API or Codex process calls in unit/smoke tests.
- Non-functional: keep command code small; move payload and save logic into helpers.

## Architecture

Create the provider skeleton and test-first contracts:

```text
src/providers/openai/
  models.ts
  client.ts
  commands/index.ts
```

Unit tests first protect model lists, driver selection, output extension mapping, and command help surface. These tests should fail until later phases implement the files.

## Related Code Files

- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/models.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/commands/index.ts`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/commands/index.ts`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/smoke/cli.test.ts`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/smoke/parse-args.test.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/unit/providers/openai/models.test.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/unit/providers/openai/driver-selection.test.ts`

## Implementation Steps

### Tests Before

1. Add failing smoke assertions for top-level `openai` and subcommands.
2. Add failing unit tests for:
   - default model constants
   - output format to extension mapping
   - driver resolver precedence: API key > Codex auth > error
   - diarization format validation rules
3. Run `npm run build` and `npm test -- tests/smoke tests/unit/providers/openai`; record failures expected from missing implementation.

### Refactor

4. Create `models.ts` with OpenAI model constants and validators:
   - `DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2"`
   - `DEFAULT_OPENAI_TTS_MODEL = "gpt-4o-mini-tts"`
   - `DEFAULT_OPENAI_STT_MODEL = "gpt-4o-transcribe"`
   - `OPENAI_TTS_VOICES` includes official 13 voices; recommend `marin`, `cedar`.
5. Create `commands/index.ts` with `registerOpenAICommands(parent)` and empty command registrations only if needed to unblock smoke tests.
6. Wire provider in `src/commands/index.ts`.

### Tests After

7. Add minimal command help tests for each OpenAI subcommand.
8. Ensure tests fail only where later phase implementation is intentionally missing.

### Regression Gate

```bash
npm run build
npm test -- tests/smoke tests/unit/providers/openai
```

## Success Criteria

- [x] OpenAI provider skeleton compiles.
- [x] Help surface tests include `openai`.
- [x] Driver and model tests exist before image/audio implementation.
- [x] No OpenAI API key required for tests.

## Risk Assessment

- Risk: placeholder command implementation can hide missing behavior. Mitigation: phase tests must assert payload/output helpers in later phases, not help text only.
- Risk: stale model defaults. Mitigation: model list is centralized and docs links are recorded in research.

## Security Considerations

- Never read Codex auth files. Use `codex login status` only.
- Do not log `OPENAI_API_KEY`; reuse `redact` if key appears in `check`.
