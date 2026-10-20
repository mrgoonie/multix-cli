---
phase: 4
title: Verification
status: completed
priority: P1
effort: 45m
dependencies:
  - 3
---

# Phase 4: Verification

## Overview

Run the full local verification stack and optional live smoke for the new Gemini text-output default.

## Requirements

- Functional: static verification passes.
- Functional: help surfaces show updated defaults where applicable.
- Functional: optional live smoke confirms `gemini-3.5-flash` works with the existing REST wrapper.
- Non-functional: do not require live API credentials for CI pass.

## Architecture

Use deterministic tests as the required gate. Treat live Gemini calls as optional/manual because they require `GEMINI_API_KEY`, quota, billing/rate limits, and network availability.

## Related Code Files

- Read: `package.json`
- Read: `tests/**`
- Read: `README.md`
- Read: `skill/SKILL.md`

## Implementation Steps

1. Run focused tests first:
   - `npm test -- tests/unit/providers/gemini`
2. Run full verification:
   - `npm run typecheck`
   - `npm run lint`
   - `npm run build`
   - `npm test`
3. Run CLI help smoke after build:
   - `node dist/cli.js gemini analyze --help`
   - `node dist/cli.js doc convert --help`
   - Confirm help mentions updated doc default where expected.
4. Optional live smoke if `GEMINI_API_KEY` is available and user allows quota use:
   - Create a tiny local text/image fixture.
   - `node dist/cli.js gemini analyze --files <fixture> --model gemini-3.5-flash --prompt "Describe this in one sentence"`
   - `node dist/cli.js doc convert --input <fixture> --model gemini-3.5-flash --output <tmp.md>`
5. Record validation results in the implementation closeout. Do not edit plan statuses manually if `ck plan check` is available.

## Success Criteria

- [ ] Focused Gemini tests pass.
- [ ] Full typecheck/lint/test/build pass.
- [ ] CLI help smoke passes after build.
- [ ] If live smoke is skipped, reason is stated.
- [ ] No unplanned files changed outside source/docs/tests/skill.

## Risk Assessment

Risk: live Gemini smoke is flaky or quota-limited.
Mitigation: keep live smoke optional and rely on official docs plus mocked/unit contracts for required verification.
