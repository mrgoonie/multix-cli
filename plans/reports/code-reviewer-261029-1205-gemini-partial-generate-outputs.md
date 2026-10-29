# Code review: gemini generate partial outputs (#493)

Commit 7b6f5e9 on `claude/relaxed-clarke-vrgd89`, diffed with `git diff origin/dev...HEAD`. Isolated reviewer; I did not write this code.

## Scope

- `src/agent/output-file-tracker.ts`: tmp/outdir filter, `realDir`, `isInside`
- `src/core/output-dir.ts`: `resolveOutputDir()`
- `src/agent/run-state.ts`: `partial`, `recordPartialRun()`
- `src/agent/agent-runtime.ts`: hint append and `next` rerun rewrite in `finalizeRun`
- `src/providers/gemini/commands/generate.ts`: catch, warn, record, rethrow
- Tests: `tests/unit/agent/output-file-tracker.test.ts`, `tests/unit/agent/finalize-run-partial.test.ts`, `tests/unit/providers/gemini/generate-errors.test.ts`
- Docs: `docs-site/.../reference/for-ai-agents.md` (en and vi), `skill/SKILL.md`
- About 245 added and 25 removed lines across 11 files. There is no REVIEW.md in the repo.

## Verification performed

- `npx vitest run` on the 3 changed test files: 9/9 pass.
- `npx vitest run tests/unit/agent tests/unit/providers/gemini tests/unit/core`: 698 pass, 6 skipped.
- `npm run typecheck`: clean. `npx biome check` on the 8 changed TS files: clean. `npm run verify:docs`: pass (8/8).
- Mutation checks, run on a `git archive` copy in the scratchpad (since deleted):
  - Revert `output-file-tracker.ts` to origin/dev: the "keeps files in an output directory under tmp" test fails. Good.
  - Revert `agent-runtime.ts` to origin/dev: the finalize-partial test fails. Good.
  - Change `isInside` to a bare `dir.startsWith(parent)`: **all tests still pass** (see M2).
- Probe test: request 1 returns no image, request 2 saves one, request 3 returns 503, with `--num-images 3`. Result: `rerun with --num-images 1`, even though only 1 of the 3 images was saved (see H1).

## Critical

None.

## High

### H1. The remaining count uses the request index, not the number of saved images

At `src/providers/gemini/commands/generate.ts:111`, `rest = numImages - i`. The loop `continue`s on an empty response (lines 124-129), so a request that returned no image is counted as done.

**Failure scenario (reproduced):** `--num-images 3`. Request 1 is safety-blocked or text-only and returns no image. Request 2 saves an image. Request 3 gets a 503. The hint says "ask only for the remaining 1", and `next` is `multix rerun <id> --num-images 1`. An agent that follows it ends with 2 images, not 3, and believes the job is complete.

The opposite case also exists: one response can carry more than one image (the inner `for (const img of images)` loop). Then `savedFiles.length > i`, and the rerun buys more images than needed.

**Fix:** compute the shortfall from what was actually saved, for example `const rest = Math.max(numImages - savedFiles.length, 0)`, and record no partial rerun when `rest === 0`. Add a test for the empty-response-then-failure sequence.

## Medium

### M1. MULTIX_OUTPUT_DIR set to the tmp root, or an ancestor of it, exempts every tmp file

At `src/agent/output-file-tracker.ts:85-88`: when `outDir` equals `realpath(os.tmpdir())`, or contains it (for example `MULTIX_OUTPUT_DIR=/var` on macOS), `isInside(dir, outDir)` is true for every tracked tmp file. That removes the scratch filter completely.

- **Tracked scratch files that survive until finalize:** `src/core/stdin-file.ts` renames stdin into `$TMPDIR/multix-stdin-XXXX/stdin.<ext>`. The rename is tracked through `renameSync`. Cleanup happens only through an explicit `cleanup()` or the `exit` handler. Callers call `cleanup()` at the end of the happy path, not in `finally` (`gemini analyze.ts:96`, `extract.ts:93`, `transcribe.ts:97`, `doc/convert.ts:87`).
- **Failure scenario:** `MULTIX_OUTPUT_DIR=$TMPDIR multix gemini analyze --files - --json < img.png`, and the run throws before `cleanup()`. The piped input `stdin.png` is reported in `outputs[]` as if the run produced it.
- **What I checked:** codex-image, topview and media-rule remove their mkdtemp dirs in `finally`, so they are not affected today. No command writes untracked-name scratch files directly into `getOutputDir()`. `media-frames` stages in `.frames-*` under its own `--output-dir`, and ffmpeg (a child process, not tracked) writes those files.
- **Fix:** apply the outdir exemption only when `outDir` is strictly inside tmp and is neither tmp nor an ancestor of it. Alternatively, when `outDir` is tmp or contains it, keep only files whose dir equals `outDir`, because every multix scratch file lives in a `multix-*` mkdtemp subdir.

### M2. The sibling-directory test is vacuous

`tests/unit/agent/output-file-tracker.test.ts:43-48` ("still drops scratch files elsewhere") never creates `root/out`. So `realDir(resolveOutputDir())` returns `undefined`, and the `out-sibling` file is dropped no matter how `isInside` is written. Replacing `isInside` with a bare `startsWith(parent)`, the exact prefix bug it claims to guard against, still passes.

**Fix:** create `root/out` (or write a file in it) in that test so the outdir branch actually runs.

## Low

### L1. Partial images skip `--output` and WebP finalization

The throw happens before lines 148-154, so saved partial files stay as the provider's PNG/JPG in `multix-output/`. `--output` is not created, and the default WebP conversion does not run. The rerun's images will be WebP, and its first image is copied to `--output`.

This is acceptable: no data is lost, and the files are listed in `outputs[]`. But the mixed formats and the missing `--output` should be stated in the hint or the docs. An agent that expects its `--output` path after a partial failure will not find it. Optionally, run `finalizeGeneratedImages` on `savedFiles` in the catch, best-effort, before rethrowing.

### L2. Failures after a successful request are not covered

`fs.writeFileSync` failure (ENOSPC) and `extractImages` errors happen outside the new `try`, so a partial save there produces no hint or rewrite. This is minor; widening the `try` to the whole loop body would cover it.

### L3. Docs wording is incomplete

The docs say "Files in the output directory count even when it is under the OS temp dir; other temp files do not." An explicit `--output` under tmp also counts (`extras`). A command's own `--output-dir` under tmp (for example `media frames`) still does not count. This is pre-existing behaviour, but the new sentence implies more than is true.

### L4. Branch name and base

The branch is `claude/relaxed-clarke-vrgd89`, not `fix/gemini-<slug>`, and it was reviewed against `origin/dev`, while AGENTS.md says to branch from `main`. The harness may have chosen the name. Confirm the target branch before opening the PR, and make sure the PR body has `Closes #493` and a `Documentation impact` section.

## Checked and fine

- **Symlinks:** tmp, the file dir and outDir all go through `fs.realpathSync`, so macOS `/var` vs `/private/var` matches consistently. A missing outDir gives `undefined`, so there is no exemption.
- **Path-prefix siblings:** `isInside` uses `parent + path.sep`, which is correct. Only the test is weak (M2).
- **Rerun rewrite:**
  - It matches only the exact `multix rerun ${historyId}` step.
  - `historyId` is always set once `actionStarted`, and the `historyId &&` guard covers the undefined case.
  - Args go through `shellQuote`.
  - `history-command.ts` appends the extra args after the recorded argv, and commander lets the later `--num-images` win.
  - A rerun that is partial again narrows correctly relative to its own argv.
- **inFlight / interrupted:** CANCELLED produces no rerun step, so there is nothing to rewrite. The inFlight hint is not overwritten, only extended. `notSent` is excluded.
- **Error code:** the error code is unchanged (asserted in both tests). For non-retryable codes (401, 429 quota), only the hint is extended, and the extended hint stays accurate.
- **`resolveOutputDir()`:** has no side effects. `getOutputDir()` behaviour is unchanged.

## Overall verdict

**Changes requested (non-blocking for security).** The root-cause analysis is correct, and the envelope and next-step plumbing is sound and tested. H1 gives agents a wrong remaining count, which is the exact failure the issue targets: under-delivery that looks like success. Fix H1 and M2 before merging. M1 is a narrow configuration but a real regression of the scratch filter, and should be fixed or explicitly scoped. L1-L3 are documentation or polish items.
