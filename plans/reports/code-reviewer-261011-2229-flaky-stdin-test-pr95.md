# Code review: PR #95 — make the stdin size-limit test deterministic (closes #92)

Head `ed14a2a5`, base `b0a91209` (main). Reviewed the worktree `D:\www\oss\multix-cli\.claude\worktrees\agent-a07359f080cb98ac3`, read only.

## Scope
- Files: `tests/unit/core/stdin-file.test.ts` (+46/−17), `tests/smoke/cli.test.ts` (+61/−33). Only test files change. `src/` is untouched.
- Code under test: `src/core/stdin-file.ts` (`stdinToTempFile`, `trackTempDir`), and the helper `tests/smoke/child-env.ts` (`isolatedEnv`), which already exists on main.
- **Verification limits:** the local Bash tool returned no output, so I ran nothing locally. CI on the head SHA is green on all four jobs: Node 20 and 22, each on ubuntu-latest and windows-latest. The docs-site job is also green.

## Root-cause check
The PR's root-cause claim holds.
- On main, the size-limit test asserted `count(multix-stdin-*) after <= before` against the shared `os.tmpdir()`. The read-failure test diffed snapshots of the same shared directory.
- On main, the smoke test `rejects an empty pipe` spawned the CLI without overriding TMP, TEMP or TMPDIR. Its child process calls `mkdtempSync(os.tmpdir()/multix-stdin-*)` before reading stdin (`src/core/stdin-file.ts:215`). So a directory could appear in the shared temp dir between the unit test's two snapshots, and the `<=` assertion would fail.
- The issue suspected stream timing or OS chunk sizes. That was not the cause: the old test already used a synthetic generator (`pipe()`).
- The new tests read only a private root, so other test files and processes cannot affect them. The race is removed, not just made less likely.

## Specific questions

**Does the private root redirect `os.tmpdir()` on Windows and POSIX?** Yes.
- Node does not cache `os.tmpdir()`. Every call reads the environment again.
- On Windows it reads `TEMP`, then `TMP`. On POSIX it reads `TMPDIR`, then `TMP`, then `TEMP`.
- The helper stubs all three (`stdin-file.test.ts:29-31`), so whichever variable the platform checks first points at the root.
- Vitest 2.1 (`^2.1.8`) runs each test file in its own forked process by default, so `vi.stubEnv` writes the real process environment that `os.tmpdir()` reads.
- For the smoke tests, `isolatedEnv(tmp)` with `extendEnv: false` sets all three variables in the child.
- Caveat: nothing in the tests proves the redirect actually happened. See M1.

**Is the environment restored after each test?** Yes.
- `afterEach` runs `vi.unstubAllEnvs()`, which restores original values and deletes variables that were not set before. It then removes the root (`:33-36`).
- The hooks are registered inside the `describe` blocks, so they apply only to `stdinToTempFile` and `resolveFileInputs > review hardening`.
- In the nested block, the outer `beforeEach` (`:118-121`, which creates `dir` in the real temp dir) runs before the inner one. Teardown runs in the reverse order. That ordering is correct.
- Stubs cannot leak into other files because each file runs in its own process.

**Are the assertions weaker than before?** No. They are stronger.
- The size-limit test now requires all of the following: the error is an instance of `ValidationError` and matches `/exceeds/`; exactly 2 chunks are pulled, so reading stops once the limit is crossed; the generator's `finally` ran, so the input was closed; and the private root is empty.
- The old test only checked `after <= before`, which was weak and racy.
- The read-failure test changes from a snapshot diff to an exact empty-root check. That is equivalent or stronger, apart from M1.
- I traced `pulled === 2` and `closed === true` against `stdin-file.ts:231-245`:
  1. The first chunk brings `size` to 10.
  2. On the second chunk, `10 + 10 > 15` throws.
  3. `for await` then awaits `iterator.return()`, which runs the generator's `finally`.
  4. The outer `catch` calls `cleanup()`.
  5. Only then does the promise reject.
  The result is deterministic.

**Are the timeouts reasonable for CI?** Yes.
- Each spawn gets 15 s instead of Vitest's 5 s default.
- The six-provider loop gets 6 × 15 s = 90 s.
- The doc-convert test gets 30 s, up from 15 s on main, because of the retry backoff of about 3 s.
- The limits are generous but bounded. Vitest 2.1 supports the `describe(name, { timeout }, fn)` and `it(name, { timeout }, fn)` forms.

**Do other open PRs conflict?** No text conflicts.
- Open PRs are #91, #88 and #85. #87 and #89 are not open.
- None of them touches `tests/smoke/cli.test.ts` or `tests/unit/core/stdin-file.test.ts`.
- #85 changes `MAX_STDIN_BYTES` in `src/core/stdin-file.ts` to `FILES_API_MAX_BYTES` (2e9). The size-limit test passes `maxBytes: 15` explicitly, so there is no semantic conflict either.
- #85 also edits `tests/unit/commands/doc-convert.test.ts`, which already stubs TMP, TEMP and TMPDIR. That is unaffected.
- The PR is `mergeable_state: clean`.

## Critical
None.

## High
None.

## Medium

**M1. The cleanup assertions pass even if the temp-dir redirect silently fails.**
- **Where:** `tests/unit/core/stdin-file.test.ts:112` and `:231`, and `tests/smoke/cli.test.ts:264` (also `:243` and `:294`, which predate this PR).
- **Failure scenario:** suppose `os.tmpdir()` stops following the stubbed variables. Possible causes: someone switches the Vitest pool to `threads` with a different env model, Node changes how it resolves `os.tmpdir()`, or a future refactor of `stdinToTempFile` takes the directory from somewhere else. The CLI then writes `multix-stdin-*` to the real temp dir. The private root stays empty, so `readdirSync(tmpRoot())` returns `[]` and the cleanup tests pass without checking anything. The same applies to the empty-pipe smoke test. Nothing in the file shows that the temp directory was ever created inside the root, so the cleanup-on-failure guarantee could break without any test failing.
- **Fix:** add a positive control in each generator before it fails or crosses the limit. For example, in the size-limit generator after the first `yield`, and in the read-failure generator before `throw`:
  ```ts
  expect(fs.readdirSync(tmpRoot()).filter((d) => d.startsWith("multix-stdin-"))).toHaveLength(1);
  ```
  Or assert once, in `writes all chunks…`, that `path.dirname(path.dirname(file.path)) === tmpRoot()`.

## Low

**L1. A Vitest timeout does not kill the spawned child process.**
- **Where:** `tests/smoke/cli.test.ts`, every `execa(...)` call (for example `:19`, `:230`, `:255`, `:281`).
- **Failure scenario:** if the CLI hangs, for example waiting on stdin, Vitest fails the test after 15 s or 30 s, but the `node dist/cli.js` child keeps running and can outlive the test worker. This was already true before the PR, but the PR now deliberately depends on timeouts.
- **Fix:** pass an execa `timeout` slightly below the test timeout, such as `timeout: SPAWN_TIMEOUT - 1_000`, ideally through a shared `run()` helper, so execa kills the child first.

**L2. The size-limit test uses a plain async generator, but production reads `process.stdin`, a `Readable` stream.**
- **Where:** `tests/unit/core/stdin-file.test.ts:213-225`.
- **Gap:** `closed === true` proves `return()` was called on a generator. With a `Readable`, ending a `for await` early destroys the stream instead, and that path is not tested. Coverage is no worse than before (the old test also used a generator).
- **Fix (optional):** add a variant built on `Readable.from([...])` that asserts `stream.destroyed === true`.

**L3. The change goes beyond the issue's stated scope.**
- **Where:** `tests/smoke/cli.test.ts`.
- **Detail:** issue #92 scoped the work to `stdin-file.test.ts`. The smoke-file edits are justified, though: the empty-pipe test was the process creating directories in the shared temp dir, and the issue also mentions an unnamed timeout. Moving the doc-convert test into its own `describe` is cosmetic churn but harmless.
- **Fix:** none required. Mention it in the PR body for traceability.

## Edge cases found by scouting
- Hook order between the outer `dir` and the inner private root is correct. Removing `""` with `force` cannot throw if `mkdtempSync` fails in `beforeEach`.
- The test `registers signal cleanup…` (`:234-246`) now runs under the private root and still cleans up its listeners.
- `labelError` uses a hard-coded `/tmp/...` string (`:249`). It is pure string handling and does not depend on the platform.

## Positive observations
- This fixes the cause instead of adding retries or loosening thresholds.
- The new size-limit test proves early stop and input closing, which the old one did not.

## Recommended actions
1. Optional, non-blocking: add the M1 positive control so the cleanup assertions cannot pass without checking anything.
2. Optional: give execa its own timeout (L1).
3. Merge as is if M1 is deferred. It is a test-robustness gap, not a correctness defect in this PR.

## Metrics
- Type coverage: no type changes; typecheck is green in CI.
- Test coverage: no `src` changes.
- Linting issues: 0 (CI is green; not run locally).

## Unresolved questions
- None blocking. I could not run the suite locally (Bash tool down), so I relied on the green CI on Windows and Ubuntu for the head SHA.

Status: DONE_WITH_CONCERNS
Summary: Approve. The root cause is confirmed, the fix is deterministic, the env stubs are restored, the assertions are stronger, and there are no conflicts with open PRs. Critical 0, High 0, Medium 1 (cleanup assertions lack a positive control), Low 3.
