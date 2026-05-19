---
phase: 5
title: "Docs Check Command and Skill Surface"
status: complete
priority: P2
effort: "2h"
dependencies: [2, 3, 4]
---

# Phase 5: Docs Check Command and Skill Surface

## Context Links

- README: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/README.md`
- Env example: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/.env.example`
- Check command: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/commands/check.ts`
- Skill: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/skill/SKILL.md`

## Overview

Document and expose OpenAI provider setup, check diagnostics, and Codex driver caveats.

## Requirements

- Functional: `multix check` reports `OPENAI_API_KEY` optional and Codex CLI auth status separately.
- Functional: if no provider API keys exist but Codex CLI is authenticated and the Codex image capability spike passes or is marked available, `multix check` exits 0 with an "experimental image driver only" summary.
- Functional: README documents OpenAI commands, env vars, and driver behavior.
- Functional: README documents that CLI `--format text` may be implemented by requesting JSON and extracting `text` where the API model does not support `response_format=text`.
- Functional: README documents known-speaker pairing for diarization, not a standalone speaker name.
- Non-functional: docs must not promise Codex is free or stable API.
- Non-functional: `.env.example` includes OpenAI defaults without secrets.

## Architecture

Keep setup visible in standard surfaces:
- env vars table
- command section
- `check` provider list
- skill command examples

`check` should not fail if Codex is absent. It should report Codex image driver as optional/experimental. If Codex is authenticated and no API keys are present, check should treat the CLI as partially ready for image generation only, not as a full API-backed setup.

## Related Code Files

- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/commands/check.ts`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/README.md`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/.env.example`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/skill/SKILL.md`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/package.json`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/CHANGELOG.md`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/unit/commands/check.test.ts`

## Implementation Steps

### Tests Before

1. Add failing `check` test for `OPENAI_API_KEY` display and redaction.
2. Add failing `check` test for Codex status helper:
   - absent binary -> info only
   - logged in -> success/info
   - not logged in -> info with `codex login`
   - no API keys + authenticated Codex image capability -> exit 0 with experimental-only summary
   - no API keys + no Codex capability -> exit 1 with setup hints
3. Add smoke tests that README examples map to valid command names.

### Refactor

4. Add OpenAI provider entry to `PROVIDERS`.
5. Add optional Codex CLI section in `check`, backed by helper function with injectable runner.
6. Update no-key handling:
   - `anyKey` remains API-key readiness.
   - `codexImageAvailable` separately marks experimental image readiness.
   - exit 0 if `anyKey || codexImageAvailable`; exit 1 only when neither exists.
7. Update README support list, env table, and command section.
8. Update `.env.example` with:
   - `OPENAI_API_KEY`
   - `OPENAI_IMAGE_MODEL`
   - `OPENAI_TTS_MODEL`
   - `OPENAI_STT_MODEL`
9. Update `skill/SKILL.md` with OpenAI examples.
10. Add package keywords: `openai`, `tts`, `stt`.
11. Add Codex caveat text:
   - requires manual `codex login`
   - experimental image-only fallback
   - disabled or errors clearly if capability spike fails
12. Add STT compatibility table:
   - API response formats by model
   - CLI output formats by post-processing behavior
   - known speaker name/reference pairing

### Tests After

13. Run docs/help grep for stale provider list omissions.
14. Run `npm run lint` to catch markdown/code formatting issues.

### Regression Gate

```bash
npm run build
npm run lint
npm test -- tests/unit/commands/check.test.ts tests/smoke
```

## Success Criteria

- [x] README documents direct API and experimental Codex driver honestly.
- [x] `multix check` handles OpenAI and Codex diagnostics without secrets, including Codex-only experimental readiness.
- [x] Skill examples include OpenAI image, TTS, STT.
- [x] README has model/format table preventing unsupported transcription requests.
- [x] Changelog includes feature entry.

## Risk Assessment

- Risk: docs overpromise Codex subscription behavior. Mitigation: say "uses existing Codex login if available"; do not call it unlimited/free.
- Risk: check command becomes noisy. Mitigation: Codex check stays concise and optional.

## Security Considerations

- Redact API key.
- Do not print Codex token paths or auth file contents.
