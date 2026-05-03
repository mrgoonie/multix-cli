---
phase: 6
title: "Status command + README + tests"
status: completed
priority: P1
effort: "3h"
dependencies: [3, 4, 5]
---

# Phase 6: Status command + README + tests

## Overview
Polish phase: `status` subcommand for async tasks, README docs, integration tests with mocked HTTP. Wraps everything for shipping.

## Requirements
- `multix byteplus status <taskId>` — single poll or wait+download
- README provider section + env table entries
- Tests for client, image-input, reference-input, video body builder
- `multix check` integration verified
- All previous phase tests still pass

## Architecture
<!-- Updated: Validation Session 1 - --cancel dropped; tests path tests/unit/byteplus -->
**Status command:**
- Default: single GET → print status JSON (status, progress hints, video_url if done)
- `--wait`: reuse `waitForVideoTask` (Phase 3) until terminal
- `--download [path]`: on `succeeded`, download MP4 (reuse `downloadVideo`); implies `--wait`
- **No `--cancel` flag** — ARK DELETE endpoint not verified; document in README that cancellation is unavailable

**Tests:** mock `httpJson` (or `fetch`) at the boundary. Don't hit real ARK in CI. Snapshot the request body shape; assert URL/method/headers.

## Related Code Files
**Create:**
- `src/providers/byteplus/commands/status.ts` — status/wait/download/cancel
- `tests/unit/byteplus/client.test.ts` — auth header, URL construction, key fallback
- `tests/unit/byteplus/video-body.test.ts` — body builder snapshot
- `tests/unit/byteplus/image-input.test.ts` (Phase 4 may have stubbed)
- `tests/unit/byteplus/reference-input.test.ts` (Phase 5 may have stubbed)

**Modify:**
- `src/providers/byteplus/commands/index.ts` — register `status`
- `README.md` — new BytePlus section, env table rows for `BYTEPLUS_API_KEY`/`ARK_API_KEY`/`BYTEPLUS_BASE_URL`/`BYTEPLUS_IMAGE_MODEL`/`BYTEPLUS_VIDEO_MODEL`, model list, command examples
- `src/commands/check.ts` — confirm BytePlus row works end-to-end
- `package.json` — bump version (e.g. `0.0.3`) if releasing

## Implementation Steps
1. Implement `status.ts`:
   - `multix byteplus status <id> [--wait] [--wait-timeout <ms>] [--download] [--output <path>] -v`
   - Single GET path: pretty-print response
   - `--wait` path: reuse `waitForVideoTask` (Phase 3); on success print video_url
   - `--download` implies `--wait`; reuse `downloadVideo`; default path `byteplus-video-{id}.mp4`
2. Add `tests/unit/byteplus/client.test.ts`:
   - Mock `httpJson`, assert `Authorization: Bearer ...`
   - Assert `BYTEPLUS_API_KEY` wins over `ARK_API_KEY`
   - Assert `ARK_API_KEY` used when only it is set
   - Assert error when neither set
3. Add `tests/unit/byteplus/video-body.test.ts`:
   - Snapshot body for t2v
   - Snapshot body for i2v with URL ref
   - Snapshot body for refs (image+video+audio mix)
   - Assert flag-in-prompt encoding (`--rs 1080p --dur 8`)
4. Update README.md:
   - Add BytePlus to top blurb (`Gemini, MiniMax, OpenRouter, Leonardo.Ai, BytePlus`)
   - New `### multix byteplus` section with all 5 subcommands + flags + examples
   - Env table rows
   - Model list (Seedream, Seedance variants)
5. Smoke test: run `npm run build && npm test && multix check -v` locally.
6. Manual verification (if API key available): each command end-to-end.

## Success Criteria
- [ ] `multix byteplus status <id>` prints status
- [ ] `multix byteplus status <id> --wait --download` produces MP4
- [ ] README documents that task cancellation is unavailable
- [ ] All new tests pass; coverage for new modules ≥80%
- [ ] `npm run build` clean
- [ ] README sections render properly (preview if possible)
- [ ] `multix check -v` shows BytePlus row
- [ ] Existing leonardo/minimax/gemini/openrouter tests untouched and passing

## Risk Assessment
- **Test brittleness**: snapshot-style tests on body shape may break when ARK API params evolve. Mitigate by isolating snapshots to small focused tests, easy to update.
- **Cancel endpoint** dropped per validation decision — README note "not supported".
- **README bloat**: BytePlus section adds significant length. Use concise tables/examples to match existing provider sections.

## Unresolved Questions
- Exact `parameters` vs flag-in-prompt convention for ARK video API — confirm at first integration test
- Cancel/delete task endpoint — confirm support
- Last-frame role naming for i2v — confirm or drop the flag
