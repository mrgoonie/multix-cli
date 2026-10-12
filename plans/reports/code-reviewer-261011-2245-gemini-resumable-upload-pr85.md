# Code Review (follow-up): PR #85, resumable streaming Gemini Files API upload (closes #73)

## Scope
- Branch `perf/gemini-stream-upload` @ `9fc5baf` (4 commits, 9 files, +405/-49), base `b0a9120`. The local worktree `agent-aad04315057622195` HEAD resolves to the same SHA (`.git/packed-refs`).
- Files: `src/providers/gemini/client.ts`, `src/providers/gemini/limits.ts` (new), `src/core/errors.ts`, `src/core/stdin-file.ts`, `tests/unit/providers/gemini/upload.test.ts`, `tests/unit/providers/gemini/key-pool.test.ts`, `tests/unit/commands/doc-convert.test.ts`, docs-site `commands/gemini.md` (EN + VI).
- Method: the Bash tool returned no output in this session, so nothing was run locally. Files were read directly from the worktree. The PR file list and CI results came from the GitHub API. Google's protocol was checked against https://ai.google.dev/gemini-api/docs/files, https://ai.google.dev/api/files, and the official JS SDK uploader (`googleapis/js-genai` `src/cross/_cross_uploader.ts`).
- CI at `9fc5baf`: all green (Node 20 and 22 on ubuntu-latest and windows-latest, plus the docs site).

## Overall Assessment
The resumable implementation matches Google's documented REST protocol, and every first-review finding is fixed or made moot. The key never goes to the session URL, and neither the key nor the session URL appears in errors or logs. Streaming and `redirect: "error"` still hold, and the tests are behavioural. No blocking defect in this PR. The main risk is a merge-order clash with PR #96, which edits the same upload `fetch` and gives transport errors the opposite classification.

## Protocol verification against Google docs

| Item | Google (REST sample / SDK) | PR (`client.ts`) | Verdict |
|---|---|---|---|
| Start URL | `POST ${BASE_URL}/upload/v1beta/files` | `FILES_BASE` = `.../upload/v1beta/files` (L21, L169) | OK |
| Start headers | `x-goog-api-key`, `X-Goog-Upload-Protocol: resumable`, `X-Goog-Upload-Command: start`, `X-Goog-Upload-Header-Content-Length`, `X-Goog-Upload-Header-Content-Type`, `Content-Type: application/json` | L173-178, identical set | OK |
| Start body | `{'file': {'display_name': ...}}` | `{ file: { display_name } }` (L180) | OK |
| Upload URL | read from the `x-goog-upload-url` response header | `start.headers.get("x-goog-upload-url")` (L184); missing value becomes a ProviderError (L186-188) | OK |
| Key on the upload request | REST sample sends **no** key and no `?key=` on the `upload, finalize` request | no key sent (L195-198); the test asserts this (test L146) | OK. Google's own sample works without the key; `upload_id` is the session credential. The JS SDK happens to add auth headers through its ApiClient, but the documented curl flow proves the key is not required. |
| Upload headers | `Content-Length: N`, `X-Goog-Upload-Offset: 0`, `X-Goog-Upload-Command: upload, finalize` | Offset and command set explicitly. Content-Length comes from the file-backed Blob, which undici sets; the SDK also leaves it to fetch. The test checks `content-length === size` on the wire (test L148). | OK |
| Finalize response | `{"file": File}` with `name`, `uri`, `state` in {`STATE_UNSPECIFIED`, `PROCESSING`, `ACTIVE`, `FAILED`} | `data.file` (L206) | OK, but the shape is not validated (see L1) |
| `X-Goog-Upload-Status` | The SDK throws unless it is `final` after the finalize chunk. Not mentioned in the REST docs. | not checked | see L1 |
| Redirects | The curl sample has no `-L`, so a redirect would break Google's own sample too. The SDK does not rely on redirects. | `redirect: "error"` on both requests (L132) | Safe. It stays load-bearing to avoid undici's body tee. |
| Per-file limit | "per-file maximum size of 2 GB" (decimal vs binary not stated) | `2_000_000_000` (`limits.ts:7`) | Conservative choice, documented |

## First-review findings: status

| ID | Finding | Status | Evidence |
|---|---|---|---|
| M1 | A 300 s timeout capped 2 GB uploads | **Fixed** | `uploadTimeoutMs` (client.ts:87-92) = max(timeoutMs, 60 s + size at 1 MB/s). It applies only to the byte upload (L201), while start and polling keep `timeoutMs`. Unit-tested (test L239-248). Docs EN and VI state the 1 MB/s floor and about 35 min for 2 GB (2,060 s, correct). |
| M2 | Multipart at large sizes unverified | **Mostly fixed** | Switched to resumable per Google's sample. A live run is still missing (see L3). |
| L1 | Opaque redirect or file-read errors | **Fixed** | `uploadFetch` (L125-150) wraps transport failures in `ProviderError("File upload failed: <reason>", { cause })`, names the timeout, and is not an `HttpError`, so it does not rotate keys. Tested (test L223-236). |
| L2 | 256 MB test relied on the 5 s default | **Fixed** | `30_000` timeout (test L149). Server start moved inside `try` (L102). |
| L3 | 429 rotation not exercised | **Fixed** | Two-key test (test L169-192) asserts `["key-a", "key-b"]` through the real `withGeminiKey`. |
| L4 | `node:fs` in the provider client (Worker rule) | Not addressed, unchanged debt | Same as before; no new module-level coupling. Keep it as a follow-up issue. |
| L5 | Duplicated 2 GiB constant | **Fixed** | `limits.ts` is the single source, used by both `client.ts:17` and `stdin-file.ts:16,24`. |
| L6 | Predictable multipart boundary | **Moot** | Multipart envelope removed. |

## Critical Issues
None.

## High Priority
None.

## Medium Priority

### M1. Merge clash with PR #96: same `fetch` block, opposite transport-error contract
- PR #96 (`fix/doc-no-retry-config-errors`, `57dfa96`) rewrites the old single `globalThis.fetch(FILES_BASE, …)` in `uploadFileWithKey` (its hunk `@@ -107,17 +107,24 @@`). It wraps network failures and timeouts as `HttpError(0, "File upload failed: …", FILES_BASE)`, so that `isTransientHttpError` (`src/core/async-poll.ts:52-55`, which accepts only `HttpError` with status 0, 429 or 5xx) lets `doc convert` retry them. PR #85 deletes that block and routes all upload fetches through `uploadFetch`, which throws **`ProviderError`** for the same failures (client.ts:135-143). Its test pins that type: `expect(err).not.toBeInstanceOf(HttpError)` (upload.test.ts:233).
- Failure scenarios after both merge:
  1. Textual conflict in `client.ts`, which is certain. Whoever resolves it by keeping #85's `uploadFetch` silently drops #96's retry of dropped uploads. `doc convert` would then fail on the first connection reset, which goes against #96's stated goal.
  2. Mocks out of date. #96 adds 153 lines to `tests/unit/commands/doc-convert.test.ts`, which #85 also edits (L173-230). Those mocks were written for the single multipart request. Under #85's flow the start response has no `x-goog-upload-url`, so every such test gets "no upload URL" instead of the status it expects. `tests/unit/providers/gemini/key-pool.test.ts` (also edited by #85) is affected in the same way if #96 touched upload mocks.
  3. If #96's `HttpError(0)` wins instead, a refused redirect (a permanent error) would be retried. A timed-out 2 GB upload would also be retried twice more by `doc convert` (up to about 3 × 34 min).
- Fix: merge #85 first, then rebase #96 onto it and change only `uploadFetch`. Throw `HttpError(0, …, FILES_BASE)` for `TypeError`/network causes, give `HttpError` an optional `ErrorOptions` so the cause is kept (`errors.ts:62-73` currently drops it), and keep `ProviderError` for `TimeoutError` on the byte-upload step and for refused redirects, so huge uploads are not retried blindly. Update upload.test.ts:233 and #96's doc-convert mocks to the two-request flow. Either order works, but the second PR must be reconciled deliberately, not by picking a conflict side. Rotation is not affected, because status 0 is not a rate-limit status in `isGeminiRateLimitError` (`key-pool.ts:53-59`).

## Low Priority

### L1. Finalize response is not validated (no `X-Goog-Upload-Status` or `file` check)
- `client.ts:204-206`: `data.file as FileRef` is used blindly. The official JS SDK throws unless `x-goog-upload-status` is `final` and reads `responseJson['file']`.
- Failure scenario: a 200 response whose status is `active`, or whose JSON body lacks `file`. For audio and video, `fileRef.state` throws `TypeError: Cannot read properties of undefined (reading 'state')`. For other types `undefined` is returned, and the caller later sends `fileUri: undefined` to generateContent, which produces a confusing 400. This was already true of the old code, but the new protocol makes the status header available.
- Fix: `const status = resp.headers.get("x-goog-upload-status"); if ((status && status !== "final") || typeof data?.file?.uri !== "string" || typeof data?.file?.name !== "string") throw new ProviderError("File upload failed: upload was not finalized", "gemini");`. Add `x-goog-upload-status: final` to the test server.

### L2. No live evidence for the resumable flow
- Every test runs against local stand-ins. The headers match Google's sample exactly, which greatly reduces the risk. Still, nobody has confirmed a real `upload, finalize` of 100 MB+ with header-only auth on the start request and no key on the session URL. The PR author had no valid key.
- Fix: before merging (or right after, before release-please publishes), have someone with a key run `multix gemini analyze --files <~300 MB mp4>` and attach the redacted output. Optionally add an env-gated live test (`MULTIX_LIVE_GEMINI=1`), as AGENTS.md allows.

### L3. The stdin cap message no longer matches the docs, and `core` now imports from a provider
- `stdin-file.ts:237` prints `Math.floor(maxBytes / 1024 ** 2)`, so the message now reads "Piped stdin exceeds **1907** MB" while the docs and README:155 say "2 GB". Its advice, "save it to a file instead", is wrong at this cap, because a file of the same size is rejected by `client.ts:106`.
- `src/core/stdin-file.ts:16` imports `../providers/gemini/limits.js`, reversing the core → provider dependency direction. It is harmless today, since `limits.ts` has no imports.
- Behaviour change: piped input between 2,000,000,000 bytes and 2 GiB, which used to be accepted, is now rejected. This is intended and consistent with the upload check. The only existing cap test uses `maxBytes: 15` (`stdin-file.test.ts:198`), so nothing breaks.
- Fix: word the message in decimal units (`(maxBytes / 1e9).toFixed(0)} GB`, the Files API limit) and drop "save it to a file". Optionally move the constant to `src/core/` (e.g. `core/limits.ts`), or have the command layer pass `maxBytes`.

### L4. The 1 MB/s floor cannot be overridden
- `MIN_UPLOAD_BYTES_PER_SEC = 1_000_000` (client.ts:78). No caller passes `timeoutMs` (analyze, transcribe, extract, doc convert), and there is no flag or env var.
- Failure scenario: a 1.5 GB video on a 5 Mbit/s uplink (0.625 MB/s) needs about 40 min but is aborted at about 26 min. That is wasted bandwidth with a clear "timed out after 1560 s" message. The limit is documented, so this is acceptable.
- Fix (optional): honour an env var such as `MULTIX_UPLOAD_TIMEOUT_MS`, or lower the floor to 0.5 MB/s. The docs could also add a hint for slow links.

## Trust boundary and leakage checks
- Key: sent only as the `x-goog-api-key` header on the start request (L173) and the poll (L215). It is never in a URL, a log line or an error. The test asserts that the upload request carries no key (L146).
- Session URL: never logged. `HttpError` is built with `FILES_BASE` rather than `uploadUrl` (L147), and the test checks that `rawUrl` and the message exclude `upload_id` and `session-secret` (test L194-211). `ProviderError` reasons use `err.message` and `cause.message` only. undici cause messages ("unexpected redirect", "other side closed", `getaddrinfo ENOTFOUND <host>`) contain no path or query. Command layers print only `e.message` (e.g. `analyze.ts:93`), so the `cause` chain is not printed.
- Upload URL host is not checked. Accepted: it comes over TLS from the fixed Google host, carries no key, and pinning the host would break the loopback test. Not a finding.
- `errors.ts`: `ErrorOptions` is available (`tsconfig.json` lib ES2022). Only `MultixError` and `ProviderError` accept options, and existing call sites are unchanged, so the change is backward compatible. `HttpError` still cannot carry a cause; that matters only for the #96 reconciliation (M1).

## Edge cases checked
- 429 or `RESOURCE_EXHAUSTED` on start or upload → `HttpError` → rotation re-runs the whole `fn`, re-opens the Blob, and starts a new session. Abandoned sessions from earlier attempts are harmless.
- File modified or truncated mid-upload: the file-backed Blob read fails → fetch rejects → `ProviderError` with cause (no rotation). The size is checked with `statSync` before `openAsBlob`. The TOCTOU window, if the file grows past 2e9 in between, ends in a server 400 at worst.
- Start response body: cancelled with `start.body?.cancel()` (L185), so no socket is left hanging.
- Timeouts: `AbortSignal.timeout` also covers reading the response body (`resp.json()` / `resp.text()`).
- Upload body Content-Type: `openAsBlob` without a `type` sends no Content-Type, and Google ignores it (curl sends form-urlencoded). The real type goes in `X-Goog-Upload-Header-Content-Type`.

## Test realism
- The streaming test runs real undici fetch against a loopback server that implements both steps. It asserts no `readFile*` calls, peak `arrayBuffers` growth below size/2, `redirect: "error"` on both requests, every start header, the JSON body, and on the session request the exact byte count, the `content-length` header, and that no key is present. These are behavioural, not phantom.
- The rotation, 503, no-upload-URL, and transport-wrap tests check types, messages and causes rather than just running the code.
- Gap: no test for `x-goog-upload-status`, a missing `file` (L1), or a non-OK start response other than 429.

## Recommended Actions
1. M1: agree a merge order with #96, then reconcile `uploadFetch` error typing and the doc-convert and key-pool mocks in the second PR. Do not pick a conflict side blindly.
2. L1: validate `x-goog-upload-status` and `data.file` (about 3 lines plus 1 test).
3. L2: attach a redacted live run with a real key (100 MB or more) before release.
4. L3, L4: optional polish or follow-up issues. Track the old L4 (Worker-reusable client without `node:fs`) as an issue if one does not exist yet.

## Metrics
- Type coverage: no new `any` beyond the existing `biome-ignore` for the response JSON (L204). The `catch` narrowing uses a typed cast.
- Tests: upload.test.ts covers 6 upload cases + 2 timeout cases; key-pool and doc-convert mocks were updated for the two-request flow. CI green on all 4 legs and the docs site.
- Lint: 0 (CI lint passed). Not run locally because Bash was unavailable.

## Unresolved Questions
- Which of #85 and #96 merges first, and who owns the reconciliation?
- Is a follow-up issue already open for the Worker-reusable Gemini client (previous L4)? It was not verified in this session.

Status: DONE_WITH_CONCERNS
Summary: Mergeable. The resumable protocol matches Google's documented REST flow, including the keyless session request, and all first-review findings are fixed or moot. The PR #96 overlap needs a deliberate reconciliation, not a blind conflict resolution. Critical 0, High 0, Medium 1, Low 4.
