# Code review: server-side dashboard sign-out (#150, commit 073d4a4)

Scope: worker/src/{accounts/account-store,auth/signed-cookies,app-context}.ts, routes/{dashboard,github-sign-in}-routes.ts, pages/dashboard-page.ts, worker/test/oauth-flow.test.ts, docs-site guides EN/VI.
Verification: `npm test --prefix worker`: 170 passed, 3 skipped.

## Verdict
The design is sound for a single location, and every CSRF call site is updated: `csrfToken` is called only at dashboard-routes.ts:68 and `csrfValid` only at :82. The consent POST (oauth-authorize-routes.ts:59) uses `signedInAccount`, so a revoked session also cannot approve an MCP grant. One real gap: a read-modify-write race on eventually consistent KV can undo a revocation.

## High

1. **A stale KV read during sign-in can undo a sign-out.** account-store.ts:109 (`sessionVersion: existing?.sessionVersion ?? 0`).
   - Sequence: sign-out at location A writes v=1. Within the ~60 s KV propagation window, someone signs in at location B, which still has v=0 cached. `upsertFromGithub` writes v=0 back.
   - Every pre-sign-out cookie (v=0) is valid again for the rest of its 7-day TTL. This includes the copied or stolen cookie the feature exists to kill. The user saw "signed out" and has no signal that it failed.
   - Triggering this needs a GitHub sign-in at a different PoP inside the window. An attacker holding a stolen cookie cannot cause it alone, but it does happen with normal multi-device use (sign out on a laptop, sign in on a phone).

2. **A stale read in `endSessions` makes sign-out a no-op.** account-store.ts:116-120.
   - Sequence: sign out at A (v becomes 1), sign in at A (cookie v=1), then sign out at B while B still reads v=0. B writes 1, and the v=1 sessions survive.
   - Concurrent sign-outs also collapse into a single increment. That case is harmless.
   - Fix for both items: stop deriving the revocation marker from a read.
     - Keep it under its own KV key (for example `sessions-epoch:${userId}`). Only logout writes it, with `Date.now()`.
     - The session cookie carries `iat` (issued-at, in ms). A session is valid only when `iat > epoch`.
     - Sign-in never writes the key, so a stale read cannot regress it. Logout writes an absolute time, so a stale read at logout cannot under-increment.
     - CSRF can bind to `iat` or to the epoch value.
   - A lighter alternative: keep the counter but drop `sessionVersion` from the upsert write, and merge with `max()`. This still has the stale-read problem for #2.

## Medium

3. **No test for the race behaviour or for legacy cookies.** oauth-flow.test.ts:478+ covers single-location revocation and the rejection of an old CSRF token. It does not cover:
   - a cookie with no `v` (pre-deploy sessions);
   - `upsertFromGithub` keeping a version above 0 (only indirectly, via the 403 after re-sign-in).

   Add a focused unit test on `AccountStore` for both, plus a test for whichever fix item #1 gets.

## Low

4. **Legacy cookies without `v` are rejected.** app-context.ts:91: `undefined !== 0` treats them as signed out, so every existing user signs in once after the deploy. This fails closed and is acceptable. Mention it in the PR or add a code comment so nobody "fixes" it with `?? 0`. Defaulting to 0 would keep cookies alive that were issued before this change and can never be revoked by their version.
5. **The CSRF token is shared across devices.** It is deterministic per (user, version), not per session, and the existing design was the same. A leaked token stays valid until the next sign-out. Informational only.
6. **The docs wording is now slightly stale.** EN guide :214 and VI guide :214 still say "per-account CSRF token"; it is now per account and session version. "About a minute" matches KV's ~60 s propagation, but the docs do not mention the race in #1. The VI text leaves "location" untranslated.

## Checks passed
- Old cookies without `v`: fail closed (see item 4).
- Sign-in preserves the version (account-store.ts:109), apart from the stale-read case in item 1.
- Session cookie `v` is set from the freshly upserted account (github-sign-in-routes.ts:133-138).
- Logout checks CSRF against the pre-increment version, then increments and clears the cookie (dashboard-routes.ts:80-89).
- MCP grants are independent of the session version. The test asserts this, and it matches the docs.
- Comparing a non-numeric `v` with `!==` fails closed.

## Unresolved questions
- Is the ~60 s window, plus the possibility that a sign-in in another location re-enables old cookies, acceptable for the threat model, or should revocation be strictly monotonic (fix in #1)?
- Should sign-out also offer "disconnect all MCP clients", or is keeping grants separate final?

## Resolution (implementer)

- Findings 1 and 2 (stale KV read can undo or skip a sign-out): fixed by replacing the account `sessionVersion` with a `signed-out:<userId>` timestamp written only by sign-out (blind write, no read-modify-write). Sessions carry an issue time (`iat`) and are void when `iat <= signedOutAt`. Sign-in never writes that key, so a stale read can only delay a sign-out (~60 s) in another location, never undo it.
- Finding 3: tests added for a cookie without an issue time, old cookies staying void after a new sign-in, and per-session CSRF.
- Finding 4: CSRF token is now bound to the session (`userId` + `iat`), not shared across devices.
- Finding 5: docs say "per-session CSRF token". "location" is kept as the term used throughout the VI guide.
- MCP grants stay independent of dashboard sign-out by design; clients are disconnected individually on the dashboard.
