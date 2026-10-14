# Code review: REST API + account API keys (#192)

Scope: `git diff origin/main..HEAD` (ad53fc5 feat, e72cc68 docs; rebased onto c5ad73b; `git range-diff` shows both patches identical to the originally reviewed e48a1a0/a6d78fa) on `feat/mcp-rest-api-keys`. ~2.3k LOC, 27 files. Isolated reviewer; no source edits.

## Checks run

| Command | Result |
|---|---|
| `npm run lint` | pass (397 files, 0 issues) |
| `npm run check:mcp` | pass: 14 files / 173 tests; wrangler dry-run ok; check-bundle clean (no `node:*`, commander, execa, CLI code) |
| `npm run verify:docs` | pass: 45 pages, 7/7 docs tests, CSP hashes ok |

Sourcemap warnings in check:mcp come from the symlinked `@cloudflare/containers` (environment only).

## Verdict

Auth, CSRF, key leakage and allowlist handling are sound. Two problems block the merge: committed `node_modules` symlinks, and API-key list updates that can be lost, leaving a live key that does not appear in the list and cannot be revoked. Everything else is Medium or Low.

## Critical

**C1. `node_modules` symlinks are committed.** The files are `node_modules` (link to `../multix-rest-api/node_modules`) and `worker/node_modules` (link to `../../multix-rest-api/worker/node_modules`), both added in ad53fc5 (still present after the rebase). `.gitignore` has `node_modules/` with a trailing slash. That pattern matches only directories, so the symlinks (stored as blobs) slip through. After merge, every clone and CI checkout gets dangling links into another developer's worktree path. This breaks `npm ci` / `npm ci --prefix worker`, or at best behaves unpredictably. It is also scope drift.
Fix: `git rm --cached node_modules worker/node_modules`, then amend or fix up ad53fc5. Optionally change `.gitignore` to `node_modules` (no slash) so symlinks are ignored too.

## High

**H1. Read-modify-write on `apikeys:<userId>` can leave a live key that is missing from the list and cannot be revoked.** See `worker/src/accounts/api-key-store.ts:85-114`.
- `create` writes the `apikey:<hash>` lookup first (l.101), then rewrites the whole list (l.102). `revoke` rewrites the whole list from its own read (l.108-112).
- Concurrent updates or stale KV reads lose entries. Examples:
  - Two tabs create a key at the same time. Both users see a key, but the last list write wins.
  - The user creates key A, then revokes B while the list read is stale and does not include A. The new list drops A.
  - In both cases the lookup entry for the lost key stays valid. That key authenticates but does not appear in the dashboard or `GET /api-keys`, so `revoke` can never find its hash. Signing out does not touch API keys, so the user's only remedy is removal from the allowlist.
- If the list `put` fails (for example the KV 1 write/sec/key limit returns 429), the lookup entry has already been written. That orphan is harmless only because the key was never shown.
- The same race lets concurrent creates exceed `MAX_API_KEYS_PER_ACCOUNT` (l.91).
- The project already fixed this class of bug for sessions (546d6f9 "stale KV reads").

Fix options, in order of preference:
- (a) One KV entry per key, `apikeys:<userId>:<id>`, with the record as value or metadata. List with `kv.list({prefix})`. Revoke deletes the record and the lookup. There is no shared array, so no update can be lost.
- (b) Keep the array but put an authoritative copy behind a Durable Object (the per-account `AccountJobQuota` DO pattern already exists).
- In either case, reverse the write order in `create`: write the record first and the lookup last. A partial failure then leaves a visible, revocable record, never a live hidden key.

## Medium

**M1. Refreshing after "Create API key" creates another key.** `worker/src/routes/dashboard-routes.ts:144` renders the key in the 200 response to the POST (deliberately, to keep it out of URLs). A browser refresh re-POSTs the form (the browser asks first), which uses up the 10-key cap and creates unseen keys. The keys stay listed and revocable, so this is acceptable. Mention it in the notice ("do not refresh this page"), or accept it as a known limitation.

**M2. Dashboard revoke always reports success.** At `dashboard-routes.ts:134-136` the return value of `store.revoke` is ignored. The code logs `api_key_revoked` and shows "API key revoked" even when no key matched. Combined with H1 (a stale list), the user is told a key was revoked when nothing happened. Branch on the boolean and show a "not found" notice.

**M3. OpenAPI responses are incomplete.** `worker/src/api/openapi-document.ts:25-29`: every operation lists only 400/401/429. The router also returns:
- 403 `forbidden` (allowlist), on every route
- 405 (with `Allow`)
- 413 / 415 on body routes
- 503 `unavailable` on `/jobs*`

The Errors table in `rest-api.md` (l.219-230) lists 403/413/415 correctly, so the spec and the guide disagree. Add `403` to `ERRORS` and add 413/415 to the operations that take a body. Generated clients need these.

**M4. Doc examples put secrets on the curl command line.** `docs-site/.../guides/rest-api.md:90,100,162` (and the VI copy) use `-d "{... \"$GEMINI_API_KEY\" ...}"`. The shell expands the values into argv, where `ps` and process accounting on shared CI runners can see them. Prefer `--data @-` with a heredoc or `jq -n --arg ... | curl --data @-`. The Node sync script already avoids this.

## Low

- **L1.** `rest-api.md:192` says a 202 means status `running`. It can also be `starting` (`job-protocol.ts:31`).
- **L2.** The `.env` sync script (`rest-api.md` ~l.129-133) keeps trailing inline comments (`KEY=abc # note`). The value then contains spaces, and the server rejects the whole PATCH with 400. That fails safe, but the error is confusing. Strip ` #...` from unquoted values.
- **L3.** `api-router.ts:80-83`: a valid key whose account was removed from the allowlist gets 403 and is never rate limited (it is neither an auth failure nor a per-account limiter hit). This is minor KV and decrypt load only. Consider running the per-account limiter before the allowlist check.
- **L4.** `api-router.ts:191` decrypts every provider key on every request, including `/me` and `/api-keys`. If decryption fails, every endpoint returns 500, including API-key revoke. Consider decrypting lazily, only for `catalog`/`jobs` and error scrubbing.
- **L5.** `HEAD` is accepted for `openapi.json` (l.172) but returns 405 on authenticated GET routes. This is inconsistent and harmless.
- **L6.** Commit types `feat(mcp)` / `docs(mcp)` publish a new npm CLI version (per AGENTS.md release rules), even though `worker/` is not published. This matches earlier MCP commits, so confirm it is intended.

## Verified OK (risk calibration)

- **Auth:** the bearer regex is checked, then `looksLikeApiKey` runs before any KV read. Lookup is by SHA-256 of a 256-bit random key, so an unsalted hash is fine. The unauthenticated surface is only `/api/v1/openapi.json` and `/api/docs`.
- **Allowlist:** `isAllowed` is checked on every API request. It fails closed when `MULTIX_ALLOWED_USERS` is empty (`allowlist.ts:18`). A test covers removal from the allowlist.
- **CSRF:** the `/dashboard/api-keys` POST goes through `handlePost`, which checks Origin (`sameOriginPost`), the signed session and the CSRF token, and is rate limited per IP via `isAuthRequest` (`index.ts:153-164`). The REST API uses bearer auth only (no cookies) and sends no CORS headers except on `openapi.json`, so it has no CSRF surface.
- **Key leakage:**
  - The page that shows a new key is served by `html()` with `cache-control: no-store`, CSP without scripts, `frame-ancestors 'none'` and `referrer-policy: same-origin`.
  - The key is HTML-escaped and never put in a URL or a log.
  - The list API and the dashboard expose only `publicApiKey`, never the hash.
  - Logs carry the user id and key names only.
  - Error messages: `secretName` echoes only env-style names. `MultixError` text is scrubbed with `sanitizeText` and the caller's key values. Unknown errors become a generic 500 that logs only `error.name`.
- **Routing:** `/api/v1foo` does not match the API prefix. Segments are restricted to `[A-Za-z0-9_-]{1,128}`, so encoded characters, empty segments and `..` are rejected. Job ownership reuses `JobRunner` (cross-account access returns 404; a test covers it). `JobCapacityError` is a `ValidationError`, so MCP behaviour is unchanged and REST maps it to 429 `busy` before the generic `MultixError` branch.
- **PATCH /provider-keys:** the whole body is validated before the single `updateSecrets` write. `__proto__` is rejected by `isProviderSecretName`. Size is bounded by `MAX_BODY_BYTES`. (`updateSecrets` read-modify-write races with a concurrent PUT the same way the existing `setSecret` does; this is a pre-existing pattern and not part of this change.)
- **Docs vs code:** these match `config.ts` / `job-runner.ts` / `wrangler.jsonc`: 64 KiB bodies, wait 0-40 (default 25), 10 keys, 60/min per account, 30/min per IP. The test "documents only routes the router answers" guards path drift.
- **AGENTS.md:** no `node:*` in the worker bundle (check-bundle clean); EN and VI guides, README and `skill/SKILL.md` updated; `redact`-style rules respected.

## Recommended actions

1. Remove the committed `node_modules` symlinks (C1).
2. Restructure API-key storage so no update can be lost, and write the record before the lookup (H1). Add a test for create-then-revoke from a stale list.
3. Fix the dashboard revoke notice (M2), complete the OpenAPI error responses (M3), and stop putting secrets in curl argv in the EN/VI docs (M4).
4. Low items at the author's discretion.

## Metrics

- Type check: pass (worker typecheck inside check:mcp)
- Tests: 173 pass. The new `rest-api.test.ts` has 11 cases. Concurrency and stale KV are not covered.
- Lint issues: 0

## Unresolved questions

1. Should API keys survive "Sign out on every device"? Today they do. Users may expect that action to also kill keys after a compromise. This is a product decision.
2. Is a revocation delay of up to 60 s (KV cache) acceptable for a credential that can rewrite provider keys? If not, `verify` needs a strongly consistent store (a DO) or `cacheTtl` tuning.
3. Is an npm release for worker-only `feat`/`docs` commits intended (L6)?

Status: DONE_WITH_CONCERNS
Summary: The auth, CSRF, allowlist and leakage paths are correct and all three checks pass. Committed node_modules symlinks and lost-update races in API-key storage block the merge.
Concerns/Blockers: C1 (symlinks committed), H1 (a live API key can be lost from the list and become unrevocable).
