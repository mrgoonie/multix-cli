---
title: "BytePlus Provider (Seedream + Seedance 2.0)"
description: ""
status: completed
priority: P2
branch: "main"
tags: []
blockedBy: []
blocks: []
created: "2026-05-02T11:26:45.198Z"
createdBy: "ck:plan"
source: skill
---

# BytePlus Provider (Seedream + Seedance 2.0)

## Overview

Add `multix byteplus` provider exposing BytePlus ModelArk APIs:
- **Seedream 4.0** — image generation (text-to-image, multi-image input)
- **Seedance 2.0** — async video generation (t2v, i2v, reference-to-video, ≤12 refs)

Mirrors `src/providers/leonardo/` pattern (sync image + async video poll). Brainstorm: `plans/reports/brainstorm-260502-1809-byteplus-provider.md`.

**Key decisions:**
- ENV: `BYTEPLUS_API_KEY` primary, `ARK_API_KEY` fallback
- Base URL: `https://ark.ap-southeast.bytepluses.com/api/v3` (override via `BYTEPLUS_BASE_URL`)
- Default video flow: poll-and-download; `--async` returns taskId; separate `status` command
- Image input (i2v/refs): URL passthrough OR local path → base64

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Client & env scaffold](./phase-01-client-env-scaffold.md) | Completed |
| 2 | [Seedream image generate](./phase-02-seedream-image-generate.md) | Completed |
| 3 | [Seedance text-to-video](./phase-03-seedance-text-to-video.md) | Completed |
| 4 | [Image-to-video helper](./phase-04-image-to-video-helper.md) | Completed |
| 5 | [Reference-to-video](./phase-05-reference-to-video.md) | Completed |
| 6 | [Status command + README + tests](./phase-06-status-command-readme-tests.md) | Completed |

## Dependencies

<!-- Cross-plan dependencies -->

## Validation Log

### Verification Results (2026-05-02)
- Tier: Full (6 phases)
- Claims checked: 8 | Verified: 5 | Failed: 3
- Failures:
  - **Phase 1**: "Wire `cli.ts`: import `register` and call inside command setup, after leonardo block" — **WRONG**. Registration happens in `src/commands/index.ts` (`registerCommands` function), `cli.ts` only calls `registerCommands(program)` once. Fix: register inside `src/commands/index.ts` next to `registerLeonardoCommands`.
  - **Phase 1**: "Update `check.ts` keys list — extend struct" — **WRONG**. `check.ts` uses inline `resolveKey` calls; no struct/list exists. Also, `LEONARDO_API_KEY` is missing from check.ts entirely despite leonardo provider shipping. Fix per decision #3 below.
  - **All test paths**: `tests/byteplus/...` — **WRONG**. Actual layout: `tests/{unit,smoke,helpers}/`. Fix: `tests/unit/byteplus/...`.

### Validation Session 1 (2026-05-02)
1. **Polling strategy**: Reuse existing `src/providers/leonardo/poll.ts` (`poll()` + `PollTimeoutError`/`PollFailedError`). Default 4s × 120 attempts = 8 min. No new file `byteplus/poll.ts`.
2. **Video body shape**: Default to **flag-in-prompt** (e.g. `--rs 1080p --dur 8 --rt 16:9 --seed 42 --cf true`). Env override `BYTEPLUS_VIDEO_PARAMS_MODE=structured` switches to top-level `parameters` object.
3. **check.ts pattern**: Refactor to a provider-list array `[{name, envPrimary, envFallback?, optional, link}]` and iterate. Add BytePlus entry. Patch missing Leonardo entry as part of the same refactor.
4. **`--cancel` flag**: **Drop** for now. ARK DELETE endpoint not verified. Document in README that cancellation is unavailable.

### Whole-Plan Consistency Sweep (2026-05-02)
- Removed `byteplus/poll.ts` references → use `poll()` from `leonardo/poll.ts`.
- Removed `pollVideoTask` custom signature → wrap `poll()` with done/failed predicates.
- Renamed all test paths `tests/byteplus/*` → `tests/unit/byteplus/*`.
- Phase 1 wiring updated: `src/commands/index.ts` instead of `src/cli.ts`.
- Phase 1 check.ts task expanded to provider-list refactor + Leonardo backfill.
- Phase 6 status command: `--cancel` flag removed; README notes lack of cancellation.
- Status: zero unresolved contradictions.
