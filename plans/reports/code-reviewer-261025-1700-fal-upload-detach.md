# Code review: fal upload, `--file`, `--detach` receipts (HEAD 9d20998, issue #284)

Scope: `git show HEAD` against origin/main, 16 files, +1252/-65. Reviewer did not write the code.
Checks run: `npm run lint` (clean), `npm run typecheck` (clean), `npx vitest run tests/unit/providers/fal` (4 files, 71 tests pass). No network calls.

## Overall

The core requirements are met. Upload follows the fal-js initiate and signed-PUT flow. The key goes only to `https://rest.fal.ai` (the initiate request follows same-origin redirects only; PUTs use `redirect: "error"` and send Content-Type only). The submit POST is never retried. A transport failure or timeout on submit becomes HttpError 0, which maps to UNKNOWN_REMOTE_STATE: not retryable, exit 6. The receipt is written to a temp file with `wx` and mode 0600, then renamed, and holds no URLs, keys or input. `storage.ts` imports nothing from `node:*`. No critical or secret-leak defects were found. Five issues need attention before merge: one High, two Medium and two Medium/Low.

## High

### H1. A 5xx or 504 response to submit is reported as retryable, which invites a duplicate paid job
- File: `src/providers/fal/run-helpers.ts:177-188`. Classification happens in `src/core/error-classify.ts` (`codeFromHttp`: 504 maps to TIMEOUT, other 5xx to PROVIDER_UNAVAILABLE, and both are in `RETRYABLE`).
- Failure scenario: fal's load balancer or gateway returns 502, 503 or 504 after the queue has already accepted the POST. This is the classic ambiguous gateway timeout. The envelope says `retryable: true` with the hint "retry". An agent resubmits, and the user pays twice. There is no request_id, so the TIMEOUT hint "use the status/resume command" cannot be followed.
- Fix: in `submitFalRequest`, also map `HttpError` with status 502, 503 (when there is no Retry-After), 504, and arguably any other 5xx except 501/505 to UNKNOWN_REMOTE_STATE. At minimum do this for 502 and 504. Add a test with a 504 submit reply that checks `retryable === false` and a single POST.

## Medium

### M1. Conflicting `--file` targets are detected only after files are already uploaded publicly
- File: `src/providers/fal/local-files.ts:367-385` (`applyFileFlags`), with the conflicts raised in `setField` at lines 339-361.
- Failure scenario 1: `--input '{"image_url":"x"}' --file image_url.url=./a.png`. `inspectLocalMedia` passes, `a.png` is uploaded to a public CDN URL, and then `setField` throws "crosses a non-object value".
- Failure scenario 2: `--file a=x.png --file a[]=y.png` (the `seen` set skips append flags), or `--file a=x.png --file a.b=y.png`. Both upload at least one file and then fail.
- This contradicts the doc comment "nothing is uploaded when one is invalid" and the issue's validate-first intent. The file is now public with no deletion guarantee.
- Fix: before any upload, run every `setField` on `structuredClone(input)` with a placeholder URL. Alternatively, reject a field that is both set and appended, or a prefix of another field, in `parseFileFlags`. Add tests for both scenarios that assert zero storage calls.

### M2. A successful submit is followed by a non-transport error, the job is queued, and no receipt is saved
- File: `src/providers/fal/run-helpers.ts:189-201` and `src/providers/fal/commands/run.ts:85-90`.
- Failure scenario: fal answers 200 with a valid `request_id`, but `status_url` fails `assertTrustedUrl`, for example after fal adds a new queue host or when `FAL_BASE_URL` points to a proxy that rewrites the URLs. Other triggers are a 200 response with an unparsable body (HttpError 200 classifies as PROVIDER_REJECTED, not retryable, and is not reported as unknown state), or a missing `response_url`. The job is queued and billed, but the command throws before `persistReceipt`. The user gets no request_id and no receipt. `fal status` and `fal result` derive their URLs from the model id, so they do not need the returned URLs and would still work.
- Fix: save the receipt (and print the request_id) as soon as a well-formed `request_id` is parsed, before the URL trust checks. Then refuse to poll the untrusted URL. For `--detach`, the untrusted URLs are never used, so detach could succeed. Treat an unparsable 200 submit body as UNKNOWN_REMOTE_STATE.

### M3. Symlinked "media" files can publish arbitrary file contents
- File: `src/providers/fal/local-files.ts:248-276`.
- Failure scenario: the extension allowlist checks the name of the link, but `fs.stat` and `openAsBlob` follow symlinks. In an untrusted repo, `assets/logo.png -> ~/.ssh/id_ed25519` or `-> ../.env` is uploaded to a public CDN when an agent runs `fal run --file image_url=assets/logo.png`. The comment at line 250 says this guard exists to keep `.env` from becoming a public URL, and it does not hold for symlinks.
- Fix: resolve the path with `fs.realpath` and apply `uploadMimeTypeFor` to the real basename, or refuse symlinks using `lstat`. Add a test.

## Medium/Low

### ML1. The receipt is called "durable" but is never fsynced
- File: `src/providers/fal/request-receipt.ts:96-98`.
- Failure scenario: power loss or a kernel crash right after `--detach` returns. On ext4/xfs, a renamed file whose data was never synced can come back zero-length. The detach output promised a resumable receipt.
- Fix: open the temp file, write it, call `fsyncSync(fd)`, close it, rename it, then fsync the directory (best effort, skipped on Windows).

### ML2. Every default `fal run` now writes receipts to `~/.multix/fal/requests` that are never cleaned up
- File: `src/providers/fal/commands/run.ts:86-90`.
- The issue asks for receipts on `--detach`. Writing them on every blocking run is a new side effect of the "backward compatible" default: files accumulate without bound, and a warning is printed when HOME is read-only (for example in CI containers). This is scope beyond the request. Check whether this is intended. If it is, document it, add a cap or pruning, or write receipts only for `--detach` and `--receipt`.

## Low

- L1. `src/providers/fal/storage.ts:126`: each PUT has a fixed 10-minute timeout. A single-part upload of up to 90 MB needs at least about 150 KB/s to finish in time. On a slow link it fails, is retried with the full body three times, and up to 30 minutes are wasted. Consider a size-scaled timeout (the Gemini uploader already has `UPLOAD_MIN_KBPS_ENV`).
- L2. `src/providers/fal/storage.ts:182-189`: the multipart `complete` POST is retried. If the first attempt succeeded but its response was lost, the retry may get a 4xx and the whole upload fails even though the file exists. This is minor, and fal-js does not retry it either.
- L3. `src/providers/fal/storage.ts:129,131` and `src/agent/fetch-telemetry.ts`: `redactUrl` strips only the query and fragment. If fal's `upload_url` carries its token in the path, it appears in error messages and in the history `path` field. Confirm the real format of `fal-cdn-v3` upload URLs. If tokens are path-based, pass `target: "fal storage"` to `toFetchError` and redact the path in `httpErrorFromResponse`.
- L4. `src/providers/fal/local-files.ts:259-261`: any `stat` failure, EACCES included, is reported as "File not found". `EACCES`/`ELOOP` should be distinguished from `ENOENT`.
- L5. `src/providers/fal/run-helpers.ts:133-135`: the new `SubmitAndWaitOptions.client` and `onSubmitted` have no callers (image and video do not use them). This is dead API surface, so remove it or use it.
- L6. When `--detach` fails to save the receipt, the command still exits 0 with no `receipt_path`, and the receipt goes to stdout only. This is acceptable because the job is queued, but the envelope could flag it, for example `receipt_saved: false`, so agents notice.
- L7. Under the global `--dry-run`, `fal run --file ...` stops at the storage initiate request, so the submit body is never previewed. Consider documenting this, or checking the dry-run flag before uploading.
- L8. Behaviour change: `fal status` and `fal result` logger output moved from stdout to stderr. This helps scripts, but it is user-visible, so mention it in the changelog or PR.

## Test gaps
1. A 5xx or 504 reply to submit (H1).
2. A timeout or AbortError on submit becomes UNKNOWN_REMOTE_STATE. Only `TypeError("fetch failed")` is tested.
3. A field conflict after upload (M1) asserting zero storage calls.
4. A 200 submit with an untrusted URL still leaves a receipt (M2, once fixed).
5. A symlink to a non-media file is refused (M3).
6. Multipart: a missing etag, a retried part, and a retried `complete`. Only the happy path is covered.
7. `FAL_MAX_UPLOAD_MB` set to an invalid value raises ConfigError.
8. `--receipt` pointing to a directory or an unwritable path warns, and the receipt is still printed.

## Requirement checklist (#284)
- `fal upload` prints clean JSON `{url,mime_type,size_bytes,file_name}` on stdout: met.
- `--file field=path` mapping: met, apart from the M1 ordering defect.
- `--detach` submit-only with an atomic 0600 receipt containing no keys, URLs or input: met (ML1 covers durability).
- Resumable through `fal status` and `fal result --download`: met and tested.
- Never resubmits: met for transport errors. 5xx is still classified retryable (H1).
- `unknown_remote_state` when the connection drops: met.
- FAL_KEY kept away from upload and CDN hosts: met and tested.
- Backward-compatible default `fal run`: met, with a new receipt side effect (ML2) and stricter `request_id` validation.
