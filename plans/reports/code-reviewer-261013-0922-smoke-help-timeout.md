# Code review: smoke --help timeout (#158, commit 6eac597)

Scope: tests/smoke/parse-args.test.ts (+10/-4). No other files touched.
Verification: `npx biome check tests/smoke/parse-args.test.ts` is clean. Vitest 4.1.11 runner source was read to confirm how timeouts are inherited. `npm test` was not run, because it was already running elsewhere.

## Verdict
Approve. The change is correct, minimal, and matches the sibling smoke files. No blocking findings.

## Findings

### Correctness
1. **Each `it` inside the describe gets the per-describe `{ timeout }`.** Confirmed in node_modules/@vitest/runner/dist/chunk-artifact.js:
   - :1804-1806: `test()` inside a collector runs `Object.assign({}, suiteOptions, options)`.
   - :1734: the effective timeout is `options.timeout ?? runner.config.testTimeout`.
   - The `it` calls pass no options of their own, so all generated cases get 15 000 ms.
   - The same `describe(name, { timeout: SPAWN_TIMEOUT }, fn)` form already works in tests/smoke/cli.test.ts:32 and tests/smoke/library-entry.test.ts:43.
2. **Unit test timeouts do not change.** vitest.config.ts has no `testTimeout`, so tests outside these two describes keep the 5 s default. The option applies only to suites in this file.
3. **The child is killed before vitest gives up.** The execa `timeout` is 14 000 ms, below the 15 000 ms test timeout. With `reject: false`, a hung child resolves with `timedOut: true` and an undefined `exitCode`. `toBe(0)` then fails with an assertion error instead of a vitest timeout, and the process does not leak. This is the same contract as `run` in cli.test.ts:23-27.

### Consistency
4. `SPAWN_TIMEOUT = 15_000`, the `run` helper shape, and `SPAWN_TIMEOUT - 1_000` all match cli.test.ts. The helper is a local copy of a 1-line function, so duplicating it across three files is acceptable. Pulling it into a shared module like `child-env.ts` is optional and out of scope.

### Low / informational
5. **This file does not use `isolatedEnv`.** cli.test.ts strips Gemini keys for commands that could call an API. `--help` exits in commander before any provider code runs, so no paid call is possible. This was also true before the change, so it is not a regression.
6. **The JSDoc names Windows CI.** cli.test.ts says "parallel full-suite run" instead. Both are accurate; this is wording only.
7. **A failure message could be clearer.** If a child is ever killed by the timeout, the failure reads `expected undefined to be 0`. `expect(result.timedOut).toBe(false)` would explain it better. This is optional, and cli.test.ts does not do it either.

## CI risk across Linux, macOS and Windows
- The code uses no platform-specific APIs. `node <abs path>` avoids shebang problems on Windows. execa's timeout kill works on Windows (TerminateProcess).
- If the cold start on Windows is longer than 14 s, the tests still fail, but by then the runner is overloaded rather than the test being wrong.
- The commit type `test(...)` does not trigger a release-please publish, which is correct for this change. The commit body contains `Closes #158`.

## Plan follow-up
The scope of issue #158 is complete. Next steps:
- Confirm on the next Windows CI matrix run (ubuntu-latest and windows-latest in ci.yml).
- Move the issue to `in review`, then to `done` once the PR is open.
