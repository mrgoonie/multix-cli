# Code review: PR #175 `feat/mcp-dashboard-keys-r2` (phase 1 of plan 261013-1740-174)

Reviewer: isolated code-reviewer, 2026-10-13 17:53 (Asia/Saigon). Diff: `git diff origin/main...HEAD` (1 commit `7194c70`, 23 files, +1310/-99).

## Verification run
- `npm ci --prefix worker`: ok.
- `npm run check:mcp`: 1st run **1 failure** (`test/oauth-flow.test.ts` "ends every dashboard session…", got 303, expected 403); 2nd run full pass (worker typecheck, 210 tests, wrangler dry-run, `check-bundle: clean`). Isolated reruns of that file 3/3 pass, so it is flaky. The file is not touched by this PR (see L4).
- `npm run lint`: clean (361 files). `npm run typecheck`: clean.

## Checked and OK (evidence, not praise)
- **SSRF/host:** `ACCOUNT_ID_RE = /^[0-9a-f]{32}$/` is enforced in `parseR2Settings` (after lowercasing) and again in the `R2Client` constructor (`r2-client.ts:76`). Host is always `https://<32hex>.r2.cloudflarestorage.com`. Bucket is checked against `BUCKET_RE` before every URL build. `publicBaseUrl` is never fetched, only string-joined. Tests cover `<id>.evil.example`, `evil.example.com#`, `../other`.
- **CSRF/Origin/session:** `/dashboard/storage` goes through `handlePost`. That path checks `sameOriginPost`, then `signedInSession` (which honours `signed-out:`), then `csrfValid`, all before `handleR2SettingsPost`. It also inherits `AUTH_RATE_LIMITER` (all `/dashboard*` POSTs, `index.ts:141`). Tested: missing CSRF, forged CSRF, foreign Origin, and no R2 calls made.
- **Secret never echoed:** redirects carry only fixed notice codes. `NOTICES` lookup uses `Object.hasOwn`. `R2RequestError` carries status plus a `[A-Za-z]{1,64}` S3 code, never the URL or headers. Network errors are replaced with status 0. Logs carry user id and result code only. The card renders only bucket and public URL, both `escapeHtml`'d. Tests check the page and KV dump for secret, key id, account id and bucket.
- **Encryption:** same AES-256-GCM key, fresh IV. AAD is `multix-provider-secret:v1:<userId>:r2-settings`. It cannot collide with the upper-case env names, and userId has no `:`. The KV key `r2:<userId>` is distinct from `account:`, `secrets:`, `signed-out:`. An undecryptable record → `null` + warn log → "Not configured"; resaving overwrites it (tested).
- **SigV4:** aws4fetch 1.0.20 (exact pin, lockfile diff limited to that package). For s3 without signQuery it auto-sets `X-Amz-Content-Sha256: UNSIGNED-PAYLOAD` and signs it (test asserts this). For presign it uses UNSIGNED-PAYLOAD, `X-Amz-Expires` is preset and preserved, and the clamp is 1..604800 with NaN mapping to the max (tested).
- **CSP:** unchanged (`default-src 'none'; style-src 'unsafe-inline'`). The new markup adds only inline `style=` attributes and no script or `on*=` handlers (tested).
- **Drift test** `provider-secret-names.test.ts` dynamically imports the CLI table and asserts provider, link and env names in order. `secretValues` now scrubs every non-identifier name (tested).

## Critical
None.

## High
**H1. Object-key validation can be bypassed with dot segments, so requests can escape the bucket path.**
`worker/src/storage/r2-client.ts:62-68` (`encodeKey`). `encodeURIComponent` leaves `.` unencoded. Both `objectUrl` and the signer (`new URL`) then apply WHATWG dot-segment normalisation. I verified this with Node:
- `"../other-bucket/x"` → `/other-bucket/x`
- `"a/../../evil/y"` → `/evil/y`
- `"."` / `"x/.."` → `/mybucket/` (a bucket-level request)

How it fails: in phase 2 the plan uploads to `multix/<userIdHash>/<jobId>/<name>`, where `<name>` is a CLI output file name and can be influenced by prompts or options. A `<name>` of `../../../other-bucket/k` makes `putObject`/`deleteObject`/`presignGet` act on another bucket in the user's account if their token is account-scoped. A key of `.` turns `deleteObject` into `DELETE /<bucket>/`, which is the DeleteBucket verb. The same normalisation also affects `publicObjectUrl` on the client side. This module is the phase-1 deliverable and claims to validate keys (`"Invalid R2 object key"`), and the test "rejects … keys that could change the host or path" does not cover this.
Fix: reject any segment that is `""`, `.` or `..` (`key.split("/").some(s => s === "" || s === "." || s === "..")`). Optionally also encode `!'()*` (see L2). Add tests for `../x`, `a/./b`, `.`, `a//b`.

## Medium
None.

## Low
**L1. Fixed probe key can destroy a user object and leaves debris on partial failure.** `worker/src/storage/r2-access-check.ts:14,54`. `checkR2Access` PUTs a 0-byte `.multix-probe` and then DELETEs it. If the user's bucket already holds an object with that name, it gets overwritten and then deleted. On the `no-delete` outcome the probe stays in the bucket. Two concurrent saves (two tabs) also race on the same key. Fix: use `.multix-probe-<random>`.

**L2. Wire path differs from the canonical path for `!'()*`.** `r2-client.ts:67`. The request path keeps `!'()*` raw, while aws4fetch's canonical path encodes them (`%21`…). Whether R2 re-encodes before verifying is not proven by any test (no test uses these characters). Fix: encode them in `encodeKey` (`.replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase())`) so the wire path and the signed path are identical. Also note that `encodeURIComponent` throws `URIError` on a lone surrogate instead of the module's own error.

**L3. Malformed KV JSON breaks the dashboard for that account.** `worker/src/accounts/r2-settings.ts:131`. `kv.get(..., {type:"json"})` sits outside the `try`. A corrupt `r2:<id>` value makes `GET /dashboard` return 500. The Remove button only renders when the summary is non-null, so the user cannot recover from the UI. This needs operator KV corruption, and `secrets()` has the same pattern. Fix: move the read into the `try`. Optionally show Remove when a record exists but is unreadable.

**L4. Flaky existing test (not caused by this PR).** `worker/test/oauth-flow.test.ts:501`. A session is `{userId, iat: ms}` and is valid only if `iat > signedOutAt` (`app-context.ts:103`). If re-sign-in lands in the same millisecond as sign-out, the new session is invalid and the POST returns a 303 redirect instead of 403. This hit check:mcp once in 2 runs here. Open a separate issue: either use a fake clock in the test or compare `iat >= signedOutAt` with a strictly later sign-out stamp.

**L5. Docs and copy nits.** The docs failure list (EN and VI step 3) omits the "could not delete the probe" outcome. The R2 card lacks the "can take up to a minute to reach every region" caveat that the keys card has, so a stale read right after save can show "Configured"/"Not configured" inconsistently. The card says presigned links are "valid for 7 days" while the docs say "up to 7 days" (the docs are accurate).

**L6. No SigV4 known-answer test.** Tests check the shape of the signature (credential scope, 64-hex signature, header presence), not its value. A fixed-`datetime` vector (aws4fetch accepts `datetime`, but `R2Client` does not expose it) would catch a future signer-config regression such as a region or service change. Optional.

## Edge cases by scout
- KV collisions: none (prefixes distinct; AAD name lower-case vs upper-case env names).
- Tool env now spreads every saved key (`toolEnvFor`). Existing tools ignore the new names, and `secretValues` covers them all, so there is no new leak path.
- `REPLICATE_API_KEY` is now storable. The shared Replicate client already falls back to it, so this is a compatible change.
- An undecryptable record shows "Not configured", leaves the stale record in KV, logs a warn on every dashboard view, and is overwritten on the next save. Acceptable.

## Plan follow-up (phase 1)
All phase-1 items appear implemented: groups with links, every env name, the R2 form with validation and probe, encrypted `r2:<userId>`, `AccountStore.r2Settings/save/delete`, exact aws4fetch pin, tests, and README/EN/VI/SKILL docs. Contract for phase 2 matches the plan. Fix H1 before phase 2 consumes `R2Client`.

## Verdict
**Request changes (small).** H1 is a one-line validation fix plus tests, and it should land in this PR because `r2-client.ts` is the contract phase 2 builds on. L1 and L2 are cheap and worth folding in. Everything else can be a follow-up. Trust-boundary handling of the dashboard route (Origin, session, CSRF, no echo, host pinning, encryption) is sound.

## Unresolved questions
1. Does R2 accept a SigV4 request whose path has raw `!'()*` while the signature was computed over `%21%27%28%29%2A`? Not verified live. L2's fix makes the question moot.
2. Should the dashboard warn when the token is account-wide rather than bucket-scoped? It cannot be detected from the S3 API alone, so docs guidance may be enough.

## Resolution (controller)
- H1 fixed: `encodeKey` rejects empty, `.` and `..` segments (and leading/trailing `/`); tests cover put/delete with `../other-bucket/x`, `.`, `a/../b`, `a/./b`, `a//b`.
- L1 fixed: probe key is `.multix-probe-<uuid>`.
- L2 fixed: segments use RFC 3986 encoding (`!'()*` percent-encoded); test asserts the request path.
- L3 fixed: KV read/JSON parse moved inside the `try`; malformed record → not configured (test).
- L4 deferred: pre-existing flaky `oauth-flow` same-millisecond sign-out test; separate issue.
- L5 fixed: card says "up to 7 days"; EN/VI docs list the "probe could not be deleted" case and recommend bucket-scoped tokens. Propagation note not added (R2 settings are read at job start).
- L6 not done: aws4fetch is the signer under test; a known-answer test would test the library.
