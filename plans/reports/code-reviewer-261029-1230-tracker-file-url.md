# Code review: record `file:` URL writes in the output-file tracker (#521)

Reviewer: isolated code-reviewer subagent (did not write the fix). Report written by the implementing session from the reviewer's returned findings.

## Scope

- `src/agent/output-file-tracker.ts`
- `tests/unit/agent/output-file-tracker.test.ts`

## Verification by the reviewer

- `vitest run tests/unit/agent`: 79/79 passed. `tsc --noEmit` and `biome check` clean.
- The new URL test fails against the `origin/dev` tracker (it stored `/…/a%20b.png`, so `statSync` missed the file) and passes with the fix.
- `fileURLToPath` errors (`ERR_INVALID_FILE_URL_HOST` on POSIX, `ERR_INVALID_FILE_URL_PATH` for `%2F`) are swallowed by `wrap()`; the real fs call still runs and raises the same error to the caller.
- `worker/` does not import `src/agent`, so `check:mcp` is not affected.
- `fileURLToPath` yields the same absolute OS form as `path.resolve(string)` (drive letters and UNC on Windows), so one file has one entry in `run.written`.

## Findings

Critical, High, Medium: none.

Low:

1. Rename removed the source from the tracked set before resolving the destination, so an invalid destination URL dropped the still-existing source from `producedFiles()`. **Fixed:** `trackRename` resolves both paths before changing the set; a POSIX test covers it and fails on the previous code. A rename that fails for other reasons (ENOENT, EXDEV) still untracks the source; this predates the change.
2. The test installs the fs wrapper without removing it. Safe because vitest isolates each test file (default `isolate: true`); **a comment now records that dependency.**
3. Out of scope: Buffer, fd and `FileHandle` targets are not tracked (pre-existing).

## Result

Approved after the Low 1 fix and the Low 2 comment.
