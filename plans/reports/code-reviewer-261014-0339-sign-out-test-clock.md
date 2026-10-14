# Code review: deterministic clock for server-side sign-out tests (#176)

Scope: `worker/test/oauth-flow.test.ts` (uncommitted diff, +15/-2). No production code is touched; `signedInSession` (`worker/src/app-context.ts`) still uses `iat <= signedOutAt`.

## Verdict
Approve. No blocking findings.

## Verification
- `npx vitest run test/oauth-flow.test.ts` x3: 29/29 passed each run.
- Full worker suite: 293 passed, 3 skipped.
- `biome check` on the file: clean. `tsc --noEmit -p worker`: clean.

## Correctness
- Only `Date` is faked (`toFake: ["Date"]`), so `setTimeout`, microtasks and WebCrypto are real. Nothing in the flow waits on a timer, so nothing hangs.
- Expiry checks under a frozen clock: `verify` rejects when `e <= floor(now/1000)` with `e = floor(now/1000) + ttl`; fake KV expires when `expiresAt <= Date.now()` with `expiresAt = now + ttl*1000`; the OAuth provider checks `expiresAt <= Date.now()/1e3`. Every TTL is positive, and the clock only moves forward by 1 s, so no cookie, KV entry or token expires during these tests.
- The fixed epoch `Date.UTC(2026, 0, 1)` is consistent for both signing and verifying, so it does not matter that it differs from wall-clock time.
- `afterEach(vi.useRealTimers)` sits inside the `describe`, so it runs after all three tests (including the one that never freezes, where it does nothing) and also when an assertion throws. Other describes are unaffected. This is the only use of fake timers in `worker/test`.

## Do the assertions still prove the behaviour?
- Test 1 now covers the boundary deterministically. The first sign-in and the logout both happen at the frozen T0, so the copied cookie has `iat == signedOutAt`. It is rejected only because the rule uses `<=`; if someone changed it to `<`, this test would fail. Before this change, that depended on timing.
- After `advanceClock(1000)`, the new session has `iat = T0+1000 > signedOutAt`, so the dashboard is reachable again. `oldCsrf` is an HMAC over `userId:iat(T0)` and the session's token is over `iat(T0+1000)`, so the 403 comes from the CSRF binding and not from a dead session (the bug in #176 was a 303 for that reason). The copied cookie is still rejected.
- Test 2: laptop `iat = T0` and phone `iat = T0+1000`. The CSRF tokens differ for certain, so cross-session 403 and same-session 303 are both meaningful. The 2 ms real sleep is gone.

## Non-blocking notes
1. The assertion "The new sign-in never rewrites the sign-out time" is weak: the copied cookie (`iat = T0`) would be rejected even if sign-in rewrote `signedOutAt`. In practice the `browser` dashboard check catches that regression only when the rewrite uses the same `now` as the new session. This was already true before the change and is outside #176. Leave it.
2. Style: `freezeClock()` is called by hand in two tests instead of in a `beforeEach`. That is acceptable because the third test does not need it, and the explicit call makes the dependency visible. Optional.
3. The comment explains the invariant (millisecond comparison) without issue IDs, which is consistent with the repo rules.

## Unresolved questions
None.

## Follow-up (author)

Non-blocking finding 1 was addressed in the same PR: the test now also checks that a
session issued after the sign-out but before the new sign-in stays valid. A mutation
that makes sign-in rewrite the sign-out time fails at that assertion.
