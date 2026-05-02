# Phase 08 — Check Command

## Context
- Plan: [plan.md](plan.md)
- Source: `check_setup.py` — see scout §1.
- Depends on: phase-02 (env resolver, http client).

## Overview
- Priority: P2
- Status: pending
- Goal: implement `multix check` — diagnostics command.

## Key Insights
- Replaces Python dep checks with binary-on-PATH checks (`ffmpeg`, `magick`).
- Provider key checks via `resolveKey()`.
- Live API ping for Gemini only (other providers no-cost ping endpoint TBD; skip for KISS).
- Exit non-zero only when zero provider keys configured (Python source semantics).

## Requirements
Functional:
- `multix check [--verbose]` prints sections:
  1. Tooling: ffmpeg, magick presence
  2. API keys: GEMINI / OPENROUTER / MINIMAX (masked previews)
  3. Live ping (Gemini only): list models endpoint
  4. Setup hints if any key missing
- Exit 0 if at least one provider key configured and (if Gemini key present) Gemini ping succeeds.
- Exit 1 if no provider keys configured.

## Architecture
```
src/commands/check.ts                 # registers `check` subcommand on program
src/commands/check-helpers/
  binary-check.ts                     # which("ffmpeg") via execa
  gemini-ping.ts                      # GET /v1beta/models with key
  setup-hints.ts                      # printable instructions
```

## Related Code Files
Create: `src/commands/check.ts`, `src/commands/check-helpers/*.ts`.
Modify: `src/commands/index.ts` — register.

## Implementation Steps
1. `binary-check.ts`: try `execa(bin, ["--version"])`; return `{available, version?}`.
2. `gemini-ping.ts`: `httpJson({url:".../models", headers:{x-goog-api-key:key}})` with 10s timeout; return count.
3. `setup-hints.ts`: docstring constants for setup instructions (Gemini Studio, OpenRouter, MiniMax URLs from Python source).
4. `check.ts`: orchestrates sections via `logger`; sets exit code.

## Todo List
- [ ] binary-check.ts
- [ ] gemini-ping.ts
- [ ] setup-hints.ts
- [ ] check.ts
- [ ] register

## Success Criteria
- `multix check` with no env keys exits 1, prints setup hints.
- With one key configured, exits 0.
- With Gemini key + bad value, prints API error, exits 1.

## Risk Assessment
| Risk | L | I | Mitigation |
|------|---|---|-----------|
| `which` semantics differ on Windows | M | L | Try-execute `--version`; treat ENOENT as not-found |
| Network timeout blocks check | M | M | 10s hard timeout on Gemini ping |
| False negative if Gemini API down | L | M | Distinguish "auth failed" vs "network error" in output |

## Security Considerations
- Mask keys: `AIzaSy*****abcd` (first 6 + last 4).
- Never echo full key even in `--verbose`.

## Next Steps
phase-09 mocks `httpJson` to assert exit codes; phase-10 docs flag matrix.
