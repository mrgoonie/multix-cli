# Code review: OpenRouter cancelled/expired video jobs (#509)

- Branch: `claude/relaxed-clarke-va1705`, diff `origin/dev..HEAD` (4 files, +39/-6)
- Files: `src/providers/openrouter/commands/video-status.ts`, `src/providers/openrouter/commands/image-to-video.ts`, `src/providers/openrouter/video-client.ts`, `tests/unit/providers/poll-job-errors.test.ts`
- Reviewer: isolated code-reviewer (did not write the code)

## Verdict: changes required

The runtime logic is correct and matches OpenRouter's documented poll status enum
(`pending | in_progress | completed | failed | cancelled | expired`, verified at
https://openrouter.ai/docs/api/api-reference/video-generation/poll-video-generation-status.md).
However, the `--help` string change makes the committed worker CLI catalog stale, so
`npm run check:mcp` fails and the `ci.yml` worker job (`npm test --prefix worker`) will fail.

## Verification run

| Check | Result |
|---|---|
| `npx vitest run tests/unit/providers/poll-job-errors.test.ts` | 39/39 passed |
| `npm run typecheck` | passed |
| `npm run check:mcp` (after `npm ci --prefix worker`) | **FAILED**: 1 failure in `worker/test/cli-catalog.test.ts` |

`grep -rn video-client worker/src`: no direct import, so no bundle risk; the coupling is through the generated `worker/src/cli-catalog.json`.

## Critical

None.

## High

1. **Worker CLI catalog not regenerated; CI breaks.**
   `worker/test/cli-catalog.test.ts` checks `CLI_CATALOG` against `buildCliCatalog(program)`. The new `video-status --wait` description (`"Poll until the job completes, fails, is cancelled or expires"`) does not match `worker/src/cli-catalog.json:2506` (`"Poll until status is 'completed' or 'failed'"`). `ci.yml` runs `npm test --prefix worker` on every PR, so this PR goes red.
   Fix: run `npm run catalog` in `worker/` and commit `worker/src/cli-catalog.json` (after fixing Medium 1, so both entries are regenerated together).

## Medium

1. **`image-to-video --wait` help text is now wrong.** `src/providers/openrouter/commands/image-to-video.ts:32` still says `"Poll until status is 'completed' or 'failed'"`, but that command's `failed` predicate now also stops on `cancelled`/`expired`. AGENTS.md requires updating `--help` when a command's behavior changes. Use the same wording as `video-status`, then regenerate the catalog (it's also at `cli-catalog.json:2430`).
2. **Stale module header.** `video-status.ts:5` still says `--wait: polls until status is completed / failed.`

## Low

1. **Orphaned JSDoc.** The new `STOPPED_STATUSES` block was inserted between the existing `toVideoJobError` doc comment ("Map a failed or timed-out video job wait...") and the function. As a result, `toVideoJobError` loses its doc, and two stacked doc blocks sit above the const. Move the new const and function above the old comment, or below `toVideoJobError`.
2. **Test only shows "stops at once" indirectly.** The new case uses the default 600 s timeout, so a missed stop would end in TIMEOUT and fail the message assertion. That is enough to catch a regression. Asserting the fetch GET count (1) and `(error as ProviderJobFailedError).terminal === false`, as the BytePlus cancelled test does, would make the contract explicit. This is optional.
3. **Documentation impact.** README/docs-site do not describe the `--wait` end states, so no public doc edit is strictly required beyond the help text and catalog. The PR body still needs a `Documentation impact` section that names the help-string and catalog change.

## Checked, no issue

- **Non-wait `video-status`**: unchanged single GET; prints `status: cancelled|expired`, exit 0. Backward compatible.
- **Download paths**: `image-to-video` downloads only after `poll` resolves, which now happens only on `completed`. `video-status --download` still guards on `res.status === "completed"`.
- **Classification**: `failed` keeps `terminal: true` (JOB_FAILED, reason redacted via `redactUrlsInText`). `cancelled`/`expired` give `terminal: false`, so `toPollJobError` omits the reason entirely. The message is `Job <id> <status>`, with no prompt or URL leak. `error-classify.ts:281-286` maps non-terminal JOB_FAILED to UNKNOWN; the test confirms `expired` is not misread as AUTH or similar.
- **`statusWord`** whitelists `^[A-Za-z_-]{1,32}$`, so a hostile status string cannot inject text.
- **Type widening** in `OpenRouterVideoPollResponse.status` is documentation-only (`| string` remains). There is no exported-contract break.
- **Pre-existing, out of scope**: the non-terminal message is regex-classified and includes the user-supplied `jobId`, so an odd id could shift classification. This is not introduced by this diff.

## Recommended actions

1. Update the `image-to-video --wait` help string and the `video-status.ts` header comment.
2. `cd worker && npm run catalog`, then commit `worker/src/cli-catalog.json`, and re-run `npm run check:mcp`.
3. Fix the JSDoc ordering.
4. Optional: add a fetch-count / `terminal === false` assertion.

## Unresolved questions

None.
