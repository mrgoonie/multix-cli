# Code review: deterministic clock for server-side sign-out tests (issue #176)

Scope: uncommitted diff to `worker/test/oauth-flow.test.ts` (+11/-2). No source changes. The `iat <= signedOutAt` rule in `worker/src/app-context.ts` is unchanged.

## Verdict
Approve. The change is deterministic, contained, and the tests still check the behavior they are meant to check. Nothing blocking.

## Evidence
- `vitest run test/oauth-flow.test.ts` passed 5 times out of 5 (29/29). The full worker suite also passes (293 passed, 3 skipped). `biome check` and `tsc -p tsconfig.test.json` are clean.
- Mutation checks, run in a scratch copy (the repo was not modified):
  - Remove the 1 ms advance before the re-sign-in: the sign-out test now fails every run. Before the fix it failed only sometimes, so this confirms the advance is what makes the test pass, and the flake cause is pinned down.
  - Remove the 1 ms advance in the CSRF test: the test fails because both sessions get the same iat and so the same CSRF token. The advance is needed, not cosmetic.
  - Change `iat <= signedOutAt` to `<`: the copied-cookie test fails. The `<=` boundary is now covered by a test.
  - Stop binding the CSRF token to iat: both tests fail. The old CSRF token is rejected and the token is bound to one session.
  - Make `endSessions` a no-op: the copied-cookie test fails.

## Does faking Date break anything?
- Only `Date` is faked (`toFake: ["Date"]`). setTimeout, microtasks and `performance` stay real, so async code in the oauth library, the MCP SDK and WebCrypto runs as before.
- All time reads use the same fake clock: `sign`/`verify` (cookie expiry), `sessionCookie` and `endSessions`, the workers-oauth-provider token and grant expiry, and the `fakeKv` TTL (`Date.now()` on both put and read). The tests advance the clock by at most 2 ms. The shortest TTL involved is the 10-minute login cookie, so nothing can expire partway through a test.
- The third test (legacy cookie with no iat) calls `sign(..., 3600)` under the fake clock and `verify` reads the same clock, so its result is the same as before.
- No fake-timer leakage: setup and teardown are in `beforeEach`/`afterEach` inside the `describe`. `afterEach` runs even when a test fails, and vitest isolates test files by default. No other test file uses fake timers.
- Freezing at 2026-01-01 while the real date is later has no effect: nothing compares against real time.

## Findings
- Low (optional): with the clock frozen, the original session's iat equals the sign-out timestamp. So the copied-cookie assertion now covers only the equality case (`iat == signedOutAt`), not the more realistic case of a session issued strictly before sign-out (`iat < signedOutAt`). The `<=` rule covers both cases, and the equality case is the stricter one to pin, so this is acceptable. If you want both cases covered, add `vi.advanceTimersByTime(1)` after `authorizeAndGetToken` and keep a separate equality check. Not required for #176.
- Info: the new comments explain why the clock moves, without any plan or issue IDs, which matches the project's comment rules.

Status: DONE
Summary: The fix is deterministic and its scope is right. Faking only Date keeps every time-dependent path (cookie expiry, the oauth library, fake-KV TTL) consistent and does not leak into other tests. Mutation checks confirm the tests still catch regressions in sign-out, the `<=` boundary and CSRF binding.
Concerns/Blockers: none. One optional Low note: a frozen clock means the copied cookie is checked only at iat == signedOutAt.
