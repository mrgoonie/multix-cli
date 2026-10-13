# Code review: MCP OAuth + dashboard (issue #149)

Branch `feat/mcp-oauth-dashboard`, uncommitted worktree vs `main`. Isolated review; no source edits.

## Scope
- Worker: `src/index.ts`, `app-context.ts`, `http-responses.ts`, `mcp-api-handler.ts`, `config.ts`, `http-guards.ts`, `accounts/*`, `auth/*`, `pages/*`, `routes/*`, `wrangler.jsonc`, `.dev.vars.example`
- Tests: `test/oauth-flow.test.ts`, `oauth-harness.ts`, `fake-kv.ts`, `http.test.ts`, `helpers.ts`
- Docs: `README.md`, `docs-site/.../guides/mcp-server.md` (en + vi), `skill/SKILL.md`
- Library checked against source: `@cloudflare/workers-oauth-provider@1.2.1` `dist/oauth-provider.js` (consent txn, `handleApiRequest`, `withCorsHeaders`, `revokeGrant`, `listUserGrants`, `parseAuthRequest`)
- `npm test --prefix worker`: 164 passed, 3 skipped (re-run 2026-10-13)

## Overall
Library integration follows the library's own consent pattern correctly: per-txn `__Host-` binding cookies, server-side redirect URI, PKCE S256 enforced, token audience bound to `${origin}/mcp`, `revokeGrant` scoped by `grant:<userId>:` key, `userId` has no `:`. Cross-account key isolation holds: `props.userId` comes from the encrypted grant, keys are decrypted only for that id, AAD binds `userId:name`, operator env keys never enter `toolEnvFor`. Escaping is consistent; no XSS sink found. One blocking defect breaks every browser form POST in production.

## Critical / blocking

### 1. `Referrer-Policy: no-referrer` makes browsers send `Origin: null` on every form POST, so `sameOriginPost` rejects them all (High, functional, fail-closed)
- `worker/src/http-responses.ts:18` sets `referrer-policy: no-referrer` on every HTML page (dashboard, consent).
- `worker/src/app-context.ts:99-101` requires `Origin === ctx.origin`; used at `routes/dashboard-routes.ts:72` and `routes/oauth-authorize-routes.ts:56`.
- Fetch spec / MDN ("Effect on the Origin header"): for non-GET/HEAD requests not in `cors` mode (HTML form submissions), `no-referrer` serializes `Origin` as `null`.
- Failure: in a real browser, Save key, Remove, Disconnect, Sign out, and consent Allow/Deny all return `403 Forbidden`. No MCP client can complete authorization, and nobody can save a key. Tests pass only because `oauth-harness.ts` `Browser.post` sets `origin` by hand.
- Fix: use `Referrer-Policy: same-origin` (same-origin POST keeps its real Origin; the consent redirect to the client's redirect URI still carries no Referer). Optionally also accept `Sec-Fetch-Site: same-origin` when `Origin` is absent. Add a regression test that asserts the HTML referrer policy is not `no-referrer` (or a check that ties the page header to the POST guard), since a Node harness cannot reproduce the browser behaviour.

## High

### 2. One unreadable stored key 500s every `/mcp` call for that account; docs promise "save again" (Medium-High)
- `accounts/account-store.ts:117-125` decrypts all records with no per-record catch; `index.ts:66` awaits it with no handler. AES-GCM `OperationError` propagates out of the library's `apiHandler` → Workers 500/1101 (HTML), including for `multix_list_providers`.
- Triggers: `SECRETS_ENCRYPTION_KEY` replaced (documented at `docs-site/.../mcp-server.md:96-97`), or a corrupted record.
- Docs say keys become "unreadable" and must be saved again; in practice the account's MCP connection hard-fails until every old record is overwritten or removed, and nothing tells the user which.
- Fix: catch per record, treat as unset, `logEvent("warn", "provider_key_unreadable", { user, name })`; optionally show "Needs re-saving" on the dashboard. Add a test (copy a record to another account or name; expect `configured: false`, not 500).

### 3. Account document read-modify-write loses saved keys (Medium)
- `accounts/account-store.ts:78-107`: `setSecret`, `deleteSecret`, `upsertFromGithub` each `get` → mutate → `put` the whole `account:<id>` document.
- Failure: two key saves in flight (two tabs, or a double-submit) → last write wins, first key silently dropped. A sign-in served from another Cloudflare location within the KV propagation window (around 60 s) reads a stale copy and `upsertFromGithub` writes back the old `secrets`, deleting a key the dashboard just reported "Key saved."
- Fix: store each secret under its own key (`secret:<userId>:<NAME>`) and keep the identity in `account:<id>`; `upsertFromGithub` then never rewrites secrets. AAD already binds `userId+name`, so the crypto format does not change.

## Medium

### 4. `requiredScopes: ["mcp"]` is advertised, not enforced (Low-Medium)
- `index.ts:105-106`. Library docs (`oauth-provider.d.ts` on `requiredScopes`): "Advertised, not enforced: the handler decides whether a token is sufficient (`ctx.auth.scope`)". `handleAuthenticatedMcp` never reads `ctx.auth.scope`.
- `oauth-authorize-routes.ts:73-79` passes `approved.request.scope` through unchanged (the client can request no scope or any string), and `approveConsent` only validates scopes when `options.scope` is given.
- Impact today: low (there is a single capability), but grants carry arbitrary scope strings and any future scope split would be unenforced.
- Fix: `oauth.approveConsent(request, handle, { scope: ["mcp"] })`, and/or reject on `/mcp` with `insufficient_scope` when `ctx.auth.scope` lacks `mcp`.

### 5. Same-origin trust now covers the whole docs site (Low-Medium, informational; deployment kept as decided)
- `wrangler.jsonc` routes: dashboard and consent share the origin `https://multix.zuey.me` with the Starlight docs Worker. `sameOriginPost` and CSRF-token reads trust any script on that origin.
- Failure: any script running on a docs page (an injected `<script>` in a future docs change, a compromised dependency, or a future analytics/search embed) can `fetch('/dashboard')`, read the CSRF token, overwrite keys, or drive `/oauth/authorize` and POST Allow for an attacker-registered client, so the code goes to the attacker's redirect URI → token for the victim's account.
- Today: docs-site has only first-party inline scripts (`astro.config.mjs` head: JSON-LD and a search shortcut), so the risk is latent.
- Mitigation without changing the deployment: keep docs free of third-party scripts; add a strict CSP to docs-site responses; note this trust boundary in the security model section.

### 6. Dashboard sessions cannot be revoked server-side; the CSRF token never rotates (Low-Medium)
- `auth/signed-cookies.ts:96-118`: stateless 7-day HMAC session; `csrfToken = HMAC(secret, "csrf:"+userId)` is constant per account forever.
- Sign out (`dashboard-routes.ts:80-82`) only clears the cookie. A copied cookie stays valid for 7 days; the only kill switch is rotating `SESSION_SECRET` (everyone) or removing the user from the allowlist.
- Fix (cheap): add a per-account `sessionEpoch` (or `sid` list) to the account doc, include it in the session and CSRF HMAC, and bump it on sign-out. At minimum, bind the CSRF token to the session (`csrf:${userId}:${sessionExpiry}`).

### 7. Unauthenticated GET `/oauth/authorize` triggers CIMD fetches and is not rate limited (Low-Medium)
- `oauth-authorize-routes.ts:43` runs `parseAuthRequest` (with `clientIdMetadataDocumentEnabled: true`, `index.ts:108`, which fetches the URL `client_id`) before the sign-in check. `isAuthWrite` (`index.ts:118-125`) limits only POST under `/oauth/*`.
- Anyone can make the Worker fetch arbitrary public HTTPS URLs at no cost to themselves (`global_fetch_strictly_public` blocks private targets, so this is not full SSRF). It also adds load on OAUTH_KV and CPU.
- Fix: include GET `/oauth/authorize` in `isAuthWrite`.

## Low

8. **Single login-cookie slot**: `LOGIN_COOKIE` is one fixed name (`signed-cookies.ts:13`, set at `github-sign-in-routes.ts:63-66`). Two signed-out authorizations in parallel (two MCP clients) overwrite each other, and the first callback fails with "Sign-in expired". Name the cookie by the state hash, as the library does for consent transactions.
9. **Stale identity on `/mcp`**: `index.ts:59` and `app-context.ts:89` check the allowlist against the `login`/`emails` stored at the last sign-in. An email entry stays matched after the user loses that email on GitHub, for as long as refresh tokens keep being used. Login-based entries can be claimed by a new GitHub user after a rename (they only get their own empty account, so no key exposure). Consider allowing numeric GitHub ids (`gh:12345`) in `MULTIX_ALLOWED_USERS`.
10. **Unhandled throws produce 500s**: `request.formData()` on a malformed body (`dashboard-routes.ts:75`, `oauth-authorize-routes.ts:67`, where `authorizationFailure` rethrows), and a crafted `return_to` containing non-ByteString characters makes `redirect()` throw at `github-sign-in-routes.ts:133` after the session is minted. These are self-inflicted only, but they show up as 500 noise. Restrict `safeReturnTo` to `[\x21-\x7e]`.
11. **Missing negative tests**: revoking another account's `grant_id`; consent POST with a foreign or missing Origin, or while signed out; a ciphertext copied to another account or name (AAD); a decrypt failure on `/mcp`; `/mcp` with a valid token and a disallowed Origin.
12. **`connectedClients`** (`dashboard-routes.ts:33-46`) runs `lookupClient` per grant on every dashboard view, which can trigger CIMD fetches, and shows only the first `listUserGrants` page. Negligible at the current scale.

## Edge cases from scouting
- Library CORS (`withCorsHeaders`) reflects any Origin on 401s and on `OPTIONS`; the custom 403 sets `access-control-allow-origin: null` so the library will not overwrite it. Correct, and the docs (`mcp-server.md:181`) describe it accurately.
- The Origin check now runs after token validation (previously before). Docs reflect this.
- `apiRoute: "/mcp"` also matches `/mcp/*` (`matchApiRoute` prefix match); the wrangler route `/mcp/*` exposes it. Harmless.
- `redirect_uri` validation, the `access_denied` redirect, and `AuthorizationError.redirectTo` all come from library-validated state, so there is no open redirect. `safeReturnTo` only allows `/dashboard` or `/oauth/authorize?…` (relative, no `//`), so it is not an open redirect either.
- The GitHub callback checks `state` before `error`, and the state is bound to the HMAC-signed login cookie, so login CSRF is blocked.

## Docs vs code
- Accurate: allowlist re-check, 7-day `__Host-` cookies, CSRF + Origin, CORS/OPTIONS note, rate-limiter scope, 503 fail-closed list, operator keys ignored, tokens hashed, en/vi parity on the key facts, no stale `MCP_AUTH_TOKEN` references.
- Inaccurate or misleading: `mcp-server.md:96-97` (see finding 2). The "Every form needs ... a same-origin `Origin` header" claim (line 210) is what makes forms fail in browsers today (finding 1). The security model omits the shared-origin trust (finding 5).

## Recommended actions (priority order)
1. Change the HTML `Referrer-Policy` to `same-origin` and verify Allow/Save in a real browser against multix.zuey.me.
2. Make per-record decrypt failures non-fatal; align the docs.
3. Split secrets into per-key KV entries.
4. Pin the approved scope to `["mcp"]`, or enforce `ctx.auth.scope`.
5. Rate limit GET `/oauth/authorize`; add a session epoch for logout and revocation.
6. Add the missing negative tests.

## Metrics
- Typecheck/lint: reported passing by the caller (not re-run). Worker tests: 164 pass / 3 skipped (live).
- Lint issues introduced: 0 observed.

## Unresolved questions
- Has consent Allow or a dashboard save been exercised in a real browser on the deployed multix.zuey.me? If so and it worked, which browser? (Expected: 403 in Chrome and Firefox per spec.)
- Should `MULTIX_ALLOWED_USERS` accept numeric GitHub ids to remove the login-reuse and stale-email edge cases?
- Is the docs site guaranteed to stay free of third-party or user-supplied scripts, given it now shares the dashboard's origin?

## Resolution (implementer)

| Finding | Outcome |
|---|---|
| 1 Referrer-Policy `no-referrer` → `Origin: null` on form POSTs | Fixed: `same-origin` (`worker/src/http-responses.ts`). Regression test checks the header. |
| 2 One undecryptable key breaks the account | Fixed: per-key try/catch in `providerKeys`, logs `provider_secret_unreadable` (name only), key treated as not set. Test moves a record to another key name. |
| 3 Lost keys from read-modify-write of the account doc | Mitigated: keys moved to `secrets:<userId>`, profile stays at `account:<userId>`, so sign-in never rewrites keys. Two concurrent dashboard saves by the same user can still race (rare; same location read-your-writes). Test checks the split. |
| 4 `mcp` scope advertised but not enforced | Fixed: grants are issued with exactly `["mcp"]`; `/mcp` returns `insufficientScope` when the token lacks it. |
| 5 Docs site shares the dashboard origin | Follow-up issue (deployment decision; latent, first-party scripts only). |
| 6 Stateless 7-day sessions, sign-out not server-side | Follow-up issue. |
| 7 GET `/oauth/authorize` not rate limited | Fixed: included in `AUTH_RATE_LIMITER`. |
| Low: negative tests | Added: consent POST from another origin → 403; revoking another account's grant has no effect. |
| Low: one sign-in per browser, allowlist uses emails from last sign-in, few malformed-request 500s | Accepted, documented here. |

Verification after fixes: root lint, typecheck, build, tests; `check:mcp` (169 passed, 3 skipped; bundle clean); `verify:docs` pass. Redeployed version c9a4faa4.
