# Code review: d8ada35 fix(replicate): trust R2 output host, retry transient downloads

Branch `fix/replicate-output-downloads`, closes #278. Reviewer did not write the code.

## Scope
- Files: src/core/http-client.ts, src/providers/replicate/{output.ts,node-outputs.ts,commands/prediction-flow.ts}, tests (models-output, node-flow), README, skill/SKILL.md, docs-site EN/VI.
- LOC: +182 / -18.
- Checks run: `npx vitest run tests/unit/providers/replicate`: 108 passed, 1 skipped. `npm run typecheck`: clean. `check:mcp` not run. output.ts adds only a string constant and no imports, so the worker bundle is unaffected.

## Overall
The change is small and correct for the failure reported in the issue: a connect timeout becomes `HttpError(0)` via `toFetchError`, and that error is now retried. Nothing blocks merge. The main gap is that the docs and code comments say "network errors are retried", but a connection dropped while the body is streaming is not retried.

## Verified (no issue)
- **What is retried.** Only `HttpError` with status 0, 408, 429, or 5xx (excluding 501 and 505), via `isTransientHttpError`. These are not retried: URL-policy refusals (`ProviderError` from `checkUrlSafety`), `DownloadTooLargeError` (a `MultixError`, not an `HttpError`), redirect-loop and malformed-Location errors (3xx status), and 404/410 (rewrapped as `HttpError(404/410)`, which is not transient). The test covers 404.
- **.part cleanup.** Each attempt is a fresh `downloadToFile` call. Non-2xx and fetch-rejection failures happen before a `.part` file is created. Stream failures remove the unique `<dest>.<pid>-<ts>-<rand>.part` in the catch block. Nothing is left over between attempts.
- **Delay math.** `min(max(backoff, Retry-After), 30s)` is correct. The tests check 5s and 600s→30s. HTTP-date Retry-After is handled by `parseRetryAfter`.
- **Untrusted-host warning.** `warnedHosts` is shared across retries and outputs, so it fires at most once per host.
- **Secret leakage.** The status-0 path shows the hostname plus `detailOf()` output, which is scrubbed by `scrub()`. Other statuses show `HttpError.message`, which uses `redactUrl` (query and fragment removed), so presigned R2 `X-Amz-*` parameters never reach info or warn level. No keys are involved: downloads send no auth headers.
- **Trusted host.** R2 hostnames follow `<bucket>.<account-id>.r2.cloudflarestorage.com`. Only the owner of account `0d37909e…` can create names under that label, so pinning the account id is sound, and the test confirms that a different account id, `evil.r2…`, and bare `r2…` stay untrusted. `checkUrlSafety` matches subdomains too (`host.endsWith('.'+t)`). That is still safe because subdomains stay inside the same account's namespace. "Trusted" only suppresses a warning and does not bypass any check, so the impact of a mistake is low. The reviewer cannot independently confirm that the account belongs to Replicate (the claim comes from the live smoke test).
- **http-client change and other providers.** The other `downloadToFile` callers (atlascloud `downloadClaimed`, runway `saveTaskOutputs`, gemini `saveOmniVideo`, heygen `node-helpers`) do not run downloads inside `pollUntil` or any loop that reads `retryAfterMs`. The one behaviour change: a Gemini Files API download that returns 429 inside `withGeminiKey` now cools down that key for the server's Retry-After instead of `DEFAULT_COOLDOWN_MS` (`key-pool.ts:64`). That is more accurate, not a regression. HTTP 429 already triggered a key rotation before this commit.
- **AGENTS.md.** output.ts stays runtime-neutral (only a constant was added). The retry import of `async-poll.js` sits in the Node-only `node-outputs.ts`.

## Findings

### Medium
1. **node-outputs.ts:8-10 and 152-177, plus README, SKILL.md, docs-site EN/VI: a connection dropped mid-body is not retried, although the docs say network errors are.** `downloadToFile` (`http-client.ts:181-196`) rethrows `pipeline()` errors unchanged. Examples: undici `TypeError: terminated` / `ECONNRESET` while streaming, or the 300s `AbortSignal.timeout` firing during the body (`DOMException TimeoutError`). None of these is an `HttpError`, so `isTransientHttpError` returns false and there is no retry. For multi-GB video outputs this is probably the most common transient failure after connect timeouts, and the user also gets an unlabelled message ("terminated"). Fix: wrap stream errors in `downloadToFile`'s catch as `HttpError(0, detail, finalUrl, undefined, { cause })`, but not `DownloadTooLargeError` or fs errors (ENOSPC/EACCES). Alternatively, classify them in `saveWithRetry` (retry when `err.name === "TimeoutError"`, or when it is a `TypeError` whose cause has a `code` such as `UND_ERR_SOCKET`/`ECONNRESET`). Add a test that uses a `ReadableStream` which errors after the first chunk, and assert that no `.part` file remains and the second attempt saves the file. If this is deliberately out of scope, narrow the docs wording to "connection failures, 408, 429 and 5xx".

### Low
2. **node-outputs.ts:144-150: "Response body is null" is reported as a network error.** `downloadToFile` throws `HttpError(0, "Response body is null")` for a 2xx response with no body, and `describeDownloadError` renders it as "network error reaching <host>: Response body is null". The retry is harmless, but the label is wrong. Fix: give it a non-zero status or a separate error class in http-client, or match on the snippet. Optional.
3. **node-outputs.ts:171-173: the info-level retry line includes the URL path for non-zero statuses.** For 5xx/429 the line is `HTTP 503 from https://replicate.delivery/<token-path>/out.png?[redacted]`. Replicate delivery paths are unguessable capability tokens. This matches the existing warn line and the `redactUrl` convention (query string only), so it is not a new leak, but it is inconsistent with the status-0 branch, which shows the host only. Fix: build the retry line as `HTTP ${status} from ${host}` for all statuses, and keep the full redacted URL at debug level.
4. **node-outputs.ts:118-122: the warning text is now slightly inaccurate.** It reads "served from X, not replicate.delivery", although the R2 host is now trusted as well. Fix: "…, not one of Replicate's output hosts".
5. **docs-site/.../commands/replicate.md (EN and VI): ambiguous sentence.** After the edit, "for example a proxy behind `REPLICATE_BASE_URL`" reads as if it describes the R2 bucket. Fix: "Hosts other than `replicate.delivery` and Replicate's R2 output bucket (`…`) are downloaded with a warning that names only the host (for example a proxy behind `REPLICATE_BASE_URL`)."
6. **Worst-case wall time.** A host that accepts the connection and then stalls before sending headers trips the 300s timeout on each attempt: about 15 minutes per output, run one after another for multi-output predictions. Acceptable, but it could be worth documenting, or using a shorter per-attempt header timeout. No change required.

### Test gaps (informational)
- No unit test for `downloadToFile` setting `retryAfterMs` (http-client is shared code). It is covered only indirectly through the Replicate 429 test.
- No assertion that a presigned query string (`X-Amz-Signature=...`) is absent from the retry or failure log lines. The existing test URL has no query string, so redaction is never exercised on this path.
- No test for a subdomain of the pinned R2 host (documents the suffix-match behaviour).
- No mid-stream failure test (see finding 1).

## Recommended actions
1. Decide on finding 1: either wrap stream errors and add a test, or narrow the docs wording.
2. Optionally fix findings 3-5 (one-line text changes).
3. Add the `retryAfterMs` unit test for `downloadToFile` and the redaction assertion.

## Unresolved questions
- Is the R2 account id `0d37909e38d3e99c29fa2cd343ac421a` confirmed as Replicate's from anything beyond observed API responses? This is low impact either way, since "trusted" only suppresses a warning.
