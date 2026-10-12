# Code review: PR #88, fix/replicate-hardening (closes #72)

Head `3337665`. Reviewed read-only from worktree `D:\www\oss\multix-cli\.claude\worktrees\agent-ae366a997a20732fc`.
The Bash tool was dead in this session, so I ran nothing locally. CI on `3337665` is green on Node 20/22 for ubuntu and windows, and the docs-site check also passes.

## Scope
- Files: 18 (src: `core/http-client.ts`, `replicate/{client,output,node-outputs}.ts`, `replicate/commands/prediction-flow.ts`; 6 test files; README, .env.example, SKILL.md, EN/VI docs)
- LOC: about +900 / -100
- Issue #72 coverage: items 1 to 5 are all addressed. Item 1's "consider the same policy in core `downloadFile`" was deliberately not done (the wrapper has no validation).

## Verdict
The change is mergeable with follow-ups. There are no Critical or High findings. The SSRF validator is correct for every literal form named in the brief, because the WHATWG parser normalises them before the check runs. The redirect loop and size cap are correct. The main gaps are about how well the helper will work as a shared base for #78 and #86, plus one missed orphan-hint path.

### SSRF bypass matrix (verified against `src/providers/replicate/output.ts:87-116`)
| Input | Parsed `hostname` | Result |
|---|---|---|
| `0x7f.1`, `2130706433`, `0177.0.0.1`, `127.1`, `127.0.0.1.` | `127.0.0.1` (WHATWG IPv4 parser) | refused |
| `[::ffff:127.0.0.1]` | `[::ffff:7f00:1]` | refused (mapped regex, line 57) |
| `[::]`, `[::1]`, `[::7f00:1]` | starts with `::` | refused (line 64) |
| `[fe80::1]`, `[febf::1]` / `[fc00::1]`, `[fdff::1]` | masks `0xffc0`/`0xfe00` correct | refused |
| `LOCALHOST.`, `x.localhost` | lowercased, single trailing dot stripped | refused |
| `https://replicate.delivery@evil.com/`, `evil.com#@replicate.delivery`, `replicate.delivery.evil.com` | `evil.com` / `replicate.delivery.evil.com` | allowed with an untrusted warning (correct) |
| `http://...` | | refused (https only) |

## Critical
None.

## High
None.

## Medium

**M1. The shared helper writes straight to the final path. A failed download truncates and then deletes a file the user already had.**
`src/core/http-client.ts:163-178`, called from `src/providers/replicate/node-outputs.ts:97-117`.
- Failure scenario: `multix replicate image "x" --output ./hero.png`, where `hero.png` already exists. `createWriteStream(dest)` truncates it, then the stream fails mid-body (timeout, connection reset, or the cap is hit). The `rmSync(dest)` at line 177 removes it.
- The same now happens through `downloadFile` for leonardo, byteplus and fal, which also write to user-chosen paths. Atlas already avoids this with `${planned}.part` plus a rename (`atlascloud/commands/prediction-runner.ts:288-297`).
- This is not a regression for Replicate, because the old copy also wrote directly. It does mean the new "shared base" is weaker than the Atlas pattern it is meant to replace in #78.
- Fix: inside `downloadToFile`, write to `${dest}.part` and `fs.renameSync(part, dest)` on success. Remove only the `.part` file on failure. Atlas can then drop its own rename logic.

**M2. The orphan hint is missing on the clearest orphan case: create returned 2xx but the body is unusable.**
`src/providers/replicate/client.ts:119-127, 248-257`, together with `src/core/fetch-json.ts:102-106`.
- A 201 with invalid JSON becomes `HttpError(201, "Invalid JSON response…")`. `mapReplicateError` then turns it into a `ReplicateApiError` with status 201, and `withOrphanHint` skips it because `201 < 500`.
- A 2xx body that fails `validatePrediction` throws a `ProviderError`, which also gets no hint.
- In both cases the prediction certainly exists and is being billed. A truncated or proxied response, or a captive portal, is exactly how this happens.
- Fix: add the hint when `status` is 0, 2xx or at least 500, and also for a `ProviderError` from `validatePrediction` on create. Add tests for both.

**M3. Placement and API shape limit reuse for #78 and #86.**
- `fetchForDownload` (`src/core/http-client.ts:89-123`) is private and GET-only. It also lives in a module that imports `node:fs`/`node:stream`, so runtime-neutral provider clients cannot import it under the AGENTS.md "no `node:*` in provider HTTP clients" rule.
  - #86 is about keyed JSON API calls (`fetchJson`). Those need the same origin-change header stripping, plus refusal of an `https` to `http` downgrade, and 303 / 307 / 308 method and body semantics. None of that is reusable from here.
  - Fix: move the redirect loop into `src/core/fetch-json.ts`, which is runtime-neutral, as an exported `fetchFollowingRedirects(url, init, { validateUrl, maxRedirects })`. Have both `downloadToFile` and `fetchJson` call it.
- `checkOutputUrl` and its IPv4/IPv6 classifiers (`src/providers/replicate/output.ts:34-116`) are Replicate-specific: they hardcode `"replicate"` in `ProviderError` and use `REPLICATE_DELIVERY_HOST`. #78 (Atlas) needs the same policy, so it would end up duplicating it.
  - Fix: move `isNonPublicHost(hostname)` plus an `httpsPublicUrlPolicy({ provider, trustedHosts })` factory into a runtime-neutral core module, for example `src/core/url-policy.ts`.
- `validateUrl` is synchronous (`http-client.ts:76, 99`). A later DNS-resolution check, which would close the hostname gap in L1, needs `(url) => void | Promise<void>` and an `await`. Making that change now is cheap and does not break anything.
- Core uses this PR as part of the plumbing. Note that the existing `node:*` placement is compliant: `http-client.ts` is core (Node), `output.ts` has no `node:*` imports, and `node-outputs.ts` is Node-only by name.

**M4. The `--prefer-wait` change breaks the CLI but ships as `fix:` with no `BREAKING CHANGE` footer.**
`src/providers/replicate/commands/prediction-flow.ts:33-39, 46-50`; commit `3337665`.
- `--prefer-wait` used to take an optional value, so a bare flag placed after the prompt meant "60s". It now fails with "argument missing".
- This matches what #72 asks for. However, 0.12.0, which shipped the old form, was released today. release-please will cut a patch release and the changelog will not mention that scripts using the bare flag now fail.
- Fix: add a `BREAKING CHANGE:` footer when squash-merging. Alternatively, keep the old behaviour with a separate boolean, for example `--prefer-wait-max`. At minimum, put a changelog note in the PR body.

## Low

**L1. Hostnames are checked as literals only; DNS is not resolved.** `output.ts:101-107`.
- `https://127.0.0.1.nip.io/` or an attacker domain with an A record for `10.x` passes the check.
- The real impact is small. The https-only rule plus certificate verification means an internal service cannot present a valid certificate for the attacker's hostname, so the TLS handshake fails. Cloud metadata endpoints are http-only.
- The docs (`docs-site/.../commands/replicate.md:104-108`, the VI equivalent, README:564, SKILL.md:183) say "IP address". Change this to "IP literal (hostnames are not resolved)" so nobody over-trusts it.

**L2. Some IPv4 and IPv6 special ranges are missing.** `output.ts:41-71`.
- Missing IPv4: 192.0.0.0/24, 192.0.2.0/24, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24.
- Missing IPv6: fec0::/10 (deprecated site-local), 64:ff9b::/96 NAT64 and 2002::/16 6to4 with an embedded private IPv4, 100::/64.
- None of these reach the local host in practice. Add them if the classifier moves to core (M3).

**L3. `rmSync` in the failure path can hide the original error.** `http-client.ts:177`.
- On Windows, AV or indexer locks cause EBUSY/EPERM. If `dest` is a directory, the result is ERR_FS_EISDIR, even with `force`.
- Either way the user sees the cleanup error instead of the download error.
- Fix: `try { fs.rmSync(dest, { force: true }) } catch {}`, then rethrow `err`.

**L4. The response body is not cancelled if `opts.dest(response)` or `mkdirSync` throws.** `http-client.ts:149-150`.
- The socket stays open until the 300s abort fires.
- Fix: wrap both in try/catch, call `response.body.cancel()`, then rethrow.

**L5. `MULTIX_MAX_DOWNLOAD_MB` values below 1 byte are accepted.** `http-client.ts:57-63`.
- `0.0000001` passes validation, `Math.floor` turns it into 0, and every download is then rejected.
- Fix: also reject a computed `bytes < 1`.

**L6. The untrusted-host warning repeats for every file.** `node-outputs.ts:95`.
- The `warned` set is created per file, so a model with 4 outputs on the same CDN warns 4 times.
- Fix: hoist the set into `saveMediaOutputs`.

**L7. Error URLs name the original URL, not the final hop.** `http-client.ts:117, 136`.
- After a redirect, the error still shows the original URL. It is redacted, so this is a debugging aid only.

**L8. `downloadFile` still follows redirects automatically and keeps custom headers.**
- Gemini Veo sends `x-goog-api-key` (`gemini/veo.ts:169`), and the API host redirects to storage. Undici strips only `Authorization` on a cross-origin hop.
- This predates the PR and is #86's scope. It is now a one-line fix: when `headers` is set, the wrapper can pass `validateUrl: () => {}` to get manual redirects with header dropping. Track it in #86 rather than widening this PR.

## Redirects, streams and the cap (verified)
- **Redirect handling:**
  - A relative `Location` resolves against the current hop (`new URL(location, current)`).
  - Any 3xx with a `Location` is followed as GET. There is no request body, so 303/307/308 cannot replay a body.
  - A 3xx without `Location` falls through to `!ok`, which raises an `HttpError`.
  - 5 redirects are followed and the 6th 3xx throws; the test asserts 6 calls.
  - Each hop's body is cancelled.
  - Headers are dropped permanently after the first origin change, and the origin includes the scheme, so a downgrade also strips them.
  - One timeout signal is shared across all hops.
- **Size cap:**
  - `Content-Length` is checked before the file is opened.
  - The streamed byte count is post-decompression, so gzip bombs are covered too.
  - When the generator throws, the pipeline destroys the `fromWeb` source, which cancels the web stream.
- **Windows cleanup:**
  - The code waits for `close` when `!fileStream.closed` before running `rmSync`.
  - The partial-file removal test passes on windows-latest CI.
- **Malformed `Location`:** `new URL(location)` can throw a bare `TypeError`, which is unclassified but has no URL in its message. This is a nit.

## Regression risk for other `downloadFile` callers
- These callers were checked: video-thumb, gemini (client, veo), fal, heygen, byteplus ×3, leonardo ×5, atlascloud.
- The contract is unchanged: it still returns the content type and still uses `globalThis.fetch` at call time.
- What changed:
  - `mkdir` now happens after a successful response.
  - The partial file is removed on failure. This is an improvement, and Atlas's own `rmSync(part, {force})` stays harmless.
  - A non-2xx body is now cancelled.
- No validation or cap was added for other providers, which matches the PR description.

## Tests
- All tests use injected or stubbed fetch, and there are no paid calls. `live.test.ts` is pre-existing and gated.
- The tests are behavioural, not phantom: they assert URLs per hop, `redirect: "manual"`, header presence per hop, that the file does not exist after a failure, and that the secret is absent from messages.
- Gaps:
  - No case for `0177.0.0.1`, `127.1`, `[fc00::1]`, or userinfo/fragment confusion.
  - No 303/307/308 cases.
  - No test that a pre-existing `--output` file survives a failed download. It would currently fail; see M1.
  - No test for the orphan hint on an invalid-JSON 2xx (M2).

## Recommended actions
1. M2: extend `withOrphanHint` to 2xx and malformed-create errors, and add tests.
2. M4: add a `BREAKING CHANGE` footer or changelog note for `--prefer-wait`.
3. M1 and M3: either do them in this PR or record them explicitly as prerequisites in #78 and #86. That means `.part`+rename in `downloadToFile`, the runtime-neutral redirect helper in `fetch-json.ts`, the URL policy moved to core, and an async `validateUrl`.
4. L1: change the docs wording to "IP literal".
5. L3 to L6 are cheap hardening.

## Metrics
- Typecheck, lint and tests: CI is green on 4 jobs (Node 20/22 × ubuntu/windows) plus docs. Nothing was run locally because Bash was unavailable.
- Test coverage: no coverage report is published. The new code paths have direct tests apart from the gaps listed above.

## Unresolved questions
- Should `downloadFile` adopt manual redirects with header stripping for keyed downloads in this PR, or in #86? I recommend #86.
- Is a breaking change acceptable in a patch release, given 0.12.0 shipped today?

Status: DONE_WITH_CONCERNS
Summary: Mergeable after M2 and M4 (or with them tracked); the SSRF literal checks, redirect loop and cap are sound. Critical 0, High 0, Medium 4, Low 8.
