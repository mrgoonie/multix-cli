# Code review: JOB_FAILED decides a job's usage outcome (#471)

Isolated review (code-reviewer agent that did not write the change) of commit
`21af27f` on `claude/relaxed-clarke-vkhivm`: `src/catalog/usage-aggregate.ts`,
its unit tests, and `docs-site` catalog pages (EN and VI).

Status: DONE_WITH_CONCERNS. The fix counts an ok submit followed by a
JOB_FAILED status run as failed, and no existing test or consumer regresses
(`catalog-command.ts` reads the counts; `recommend.ts:103` ranks by
`success_rate`, so the fix improves recommendations).

## Findings and resolution

1. **High — a later ok run flipped a provider-failed job back to completed.**
   The first version let the latest of {ok runs, JOB_FAILED runs} decide.
   `byteplus status <id>` without `--wait` prints the failed task and exits 0
   (`src/providers/byteplus/commands/status.ts:44-51`; same in
   `src/providers/openrouter/commands/video-status.ts`), so reading the error
   made the job completed again. Provider job ids are not resubmitted and a
   failed job does not later succeed. **Fixed:** JOB_FAILED is now terminal;
   test "keeps a job the provider failed as failed when a later status read of
   it exits ok" covers it; docs updated.
2. **Medium — provider terminal failures that are not classified JOB_FAILED
   still count as completed.** JOB_FAILED comes from regex text
   classification in `src/core/error-classify.ts`: `Replicate prediction
   abc123 failed: ...` gives UNKNOWN, and a task payload saying "timed out"
   gives TIMEOUT because that rule wins first. **Follow-up issue** (structured
   job-failure signal at the throw site), out of this PR's scope.
3. **Low — some transient errors classify as JOB_FAILED by text**
   (`Generation failed: fetch failed`). Harmless today: those are synchronous
   runs with no ok submit in the same operation. Covered by the same
   follow-up.
4. **Low — tests.** Added the cancel-after-JOB_FAILED case. The same-timestamp
   tie test no longer applies: JOB_FAILED no longer depends on order.
5. **Docs** matched the first rule; updated with finding 1.

## Verification

- New tests fail on the old code (2 failures reproduce the issue) and pass now.
- `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`: 2801 passed,
  22 skipped.
