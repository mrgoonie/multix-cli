## Code review: fal local upload, `--file`, `--detach` receipts and resume (HEAD 3929fef, issue #284)

**Report file not written.** You asked for `/workspace/multix-cli/plans/reports/code-reviewer-261025-1705-fal-upload-detach.md`. My operating rules for this run forbid writing report files, and the task also said not to modify any files. The full report is below; please save it to that path yourself.

### Scope
- **Files:** `src/providers/fal/{storage.ts, node-input-files.ts, receipt.ts, run-helpers.ts}`, `src/providers/fal/commands/{run,result,upload,index}.ts`, `src/core/error-classify.ts`, `worker/src/jobs/cli-command-policy.ts`, `worker/src/cli-catalog.json`, the tests, and the EN/VI docs. About 1,630 added lines.
- **Checks run (all passing):**
  - `npx vitest run tests/unit/providers/fal tests/unit/core/error-classify.test.ts`: 82/82 pass.
  - `npx vitest run tests/unit`: 1399 pass, 12 skipped.
  - `npm run typecheck`, `npm run lint`: clean.
  - `npm test --prefix worker`: 372/372 pass.
  - I rebuilt the CLI catalog in memory (scratch script, nothing written) and compared it with `worker/src/cli-catalog.json`: they match.
- **Upstream protocol check:** I read fal-js `libs/client/src/storage.ts` and `config.ts` on GitHub main. `getRestApiUrl()` returns `https://rest.fal.ai`. The initiate paths, `storage_type=fal-cdn-v3`, the `X-Fal-Object-Lifecycle` header, the 90 MiB / 10 MiB multipart sizes, the part and complete URLs, and the complete body all match the implementation. One difference is reported under M2.
- No paid API was called and no FAL key was used.

### Overall assessment
Nothing critical. The key-trust boundaries hold:
- The key goes only to `rest.fal.ai`, where a redirect to another origin is refused through `fetchJson`.
- Upload PUTs carry no key and use `redirect: "error"`.
- `assertTrustedFalUrl` is unchanged and is reused in `submitFalRequest`.
- Errors redact query strings through `HttpError`.

Default `fal run` keeps its behaviour: logs still go to stdout, `--no-download` keeps its meaning, and the download path is the same. Two intended differences: a submit with no response now fails with `UNKNOWN_REMOTE_STATE` (exit 6) instead of `NETWORK_ERROR` (exit 4), and a submit response without a `request_id` is now rejected. Worker policy is correct: `--file` and `--receipt` are refused remotely, and `--output-dir` is always set by the server.

The findings are robustness gaps in the upload path and a few misleading contracts.

### Critical
None.

### High
None.

### Medium

**M1. Upload PUTs have no timeout.** `src/providers/fal/storage.ts:865-884` (`sendUnkeyed`), used at lines 925, 940 and 967. Verified by reading.
- **Problem:** the initiate call goes through `fetchJson` with its default 120 s timeout, but the byte transfer (single PUT, each multipart part, and complete) passes no `signal`.
- **Failure scenario:** a half-open connection or a server that stops reading a large mp4 body leaves `fal upload` or `fal run --file` hanging until undici's internal defaults (around 300 s for headers and body, if they apply to a stalled request body at all), or longer. The 3-attempt retry multiplies that. An agent running many shots in parallel can sit blocked without ever getting the retryable `HttpError(0)` the retry loop expects.
- **Issue requirement:** #284 explicitly asks for "upload timeout/retry" tests, and none exist.
- **Fix:** give each attempt an `AbortSignal.timeout(...)`. For example, a stall budget plus size-scaled time per part (10 MB parts suit a fixed 120 s). Map an abort to `HttpError(0, "timed out")` so `withRetries` retries it. Add a test with a `fetch` that never resolves, using fake timers.

**M2. Multipart upload needs the etag in the response body.** `src/providers/fal/storage.ts:931-935`. Verified against upstream source.
- **Problem:** multix accepts only `res.etag` from the JSON body. The official client reads the body etag and falls back to the `ETag` response header.
- **Failure scenario:** if the CDN answers a part PUT with the etag only in a header, or with an empty or non-JSON body, every upload over 90 MB fails. A non-JSON body throws a `SyntaxError`, which is not retried. Small files work, so the tests miss it.
- **Fix:** `const etag = body?.etag ?? response.headers.get("etag")`. Parse the JSON body tolerantly. Add a test where the etag comes only in a header.

**M3. Test gaps against the issue's acceptance list.** Verified by reading the test list.
- **Missing tests:**
  - upload timeout or stall (see M1);
  - revoked or invalid auth (401/403 on initiate) giving a classified config error from `fal upload`;
  - an upload PUT redirect being refused;
  - a CLI-level check that `FAL_KEY` and the signed upload URL never appear in stdout or stderr from `fal upload` / `run --file` (the storage test checks request headers, not output);
  - the receipt-write-failure path in `run --detach`, which warns, still prints the receipt and exits 0;
  - a 5xx on submit;
  - a multipart etag only in the header (M2).
- **Fix:** add these as unit tests using the existing mock `fetch` pattern.

### Low

**L1. `--expires-in constructor` and `--expires-in __proto__` are silently accepted.** `src/providers/fal/storage.ts:795` (`value in EXPIRATION_SECONDS`). Verified by running `parseExpiresIn`.
- **Problem:** `in` also matches inherited properties. `"constructor"` returns a function, `"__proto__"` returns an object, and the lifecycle header becomes `{"expiration_duration_seconds":{}}`.
- **Result:** the user believes an expiry was set when none was. `toString` happens to be rejected only because `"tostring"` is lowercased.
- **Fix:** use `Object.hasOwn(EXPIRATION_SECONDS, value)` or a `Map`.

**L2. `input_hash` cannot spot duplicates in `--file` runs.** `src/providers/fal/commands/run.ts:280-285`, `receipt.ts:556`.
- **Problem:** the hash is taken after upload, so the input contains a fresh fal storage URL each time.
- **Result:** two identical `--file video_url=./shot.mp4` submissions get different hashes, even though the docs say the hash is "to spot a duplicate submission".
- **Fix:** hash the pre-upload input with local file identity (path + size + mtime, or a content sha256), or narrow the doc claim.

**L3. Repeating `--file` with the same key silently keeps only the last value.** `src/providers/fal/node-input-files.ts:508-520`.
- **Failure scenario:** `--file image_urls=a.png --file image_urls=b.png` uploads both files but sends only `b`. Array or nested fields (reference-image lists) cannot be expressed at all.
- **Fix:** reject duplicate keys with a `ValidationError`, or collect repeated keys into an array. Document that only top-level fields are supported.

**L4. `--content-type` is not validated.** `src/providers/fal/commands/upload.ts:389`, `storage.ts:970`.
- **Problem:** a value with CR/LF or other invalid header characters makes `fetch` throw. `sendUnkeyed` wraps that as `HttpError(0)`, which is retried 3 times with backoff and finally reported as a retryable `NETWORK_ERROR`.
- **Fix:** validate against a MIME token pattern and throw a `ValidationError` up front.

**L5. Flags that only make sense together are silently ignored.** `src/providers/fal/commands/run.ts:279-307`.
- **Problem:** `--receipt` without `--detach`, and `--output-dir`, `--no-download` or `--wait-timeout` with `--detach`, are all silently dropped.
- **Fix:** reject `--receipt` without `--detach`, or warn on the ignored flags.

**L6. Receipt durability.** `src/providers/fal/receipt.ts:615-629`.
- **Problem:** the write is atomic (`wx` temp file, then rename) but there is no `fsync` on the file or the directory. After a power loss right after submit, the receipt can be empty or missing. In `run --detach` that loss is printed only as a warning, and the exit code stays 0.
- **Also:** an existing `~/.multix/fal/requests` with mode 0755 is left as it is.
- **Fix:** call `fsync` on the temp file before the rename and on the directory after it (best effort). Optionally `chmod` the directory to 0700 when it is owned by the user.

**L7. Storage ignores `FAL_BASE_URL`.** `src/providers/fal/storage.ts:774`.
- **Problem:** uploads always go to `rest.fal.ai`. A user who routes fal through a proxy with a proxy key sends that key to `rest.fal.ai`.
- **Impact:** this matches the existing trust model, since `queue.fal.run` follow-up URLs already receive the key, and the docs disclose it. A proxied setup breaks for uploads, but nothing leaks to a non-fal host.
- **Fix:** none needed now. Optionally mention it in the `FAL_BASE_URL` docs.

**L8. `--dry-run` with `--file` shows the upload request, not the model submit.** `src/agent/fetch-telemetry.ts:91`.
- **Problem:** the first `fetch` is the storage initiate, so a dry run prints `POST https://rest.fal.ai/storage/upload/initiate…` and stops there. It is harmless (initiate is free and nothing is uploaded) but misleading.
- **Fix:** document it, or skip uploads in a dry run and use placeholder URLs.

**L9. Remote detached runs report a container-local receipt path.** `worker/src/jobs/cli-command-policy.ts:987`.
- **Problem:** remote `fal run --detach` is allowed. It writes the receipt into the ephemeral container home and returns `receipt_path` pointing at a container path.
- **Impact:** harmless, since `request_id` and the `next` commands are what matter.
- **Fix:** optionally mark `detach` in the policy comment, or omit `receipt_path` when running in the container.

### Edge cases checked and cleared
- **Path traversal in receipt names:** `defaultReceiptPath` replaces `[^\w.-]` with `_`. The worst case, `..` → `...json`, stays inside the directory, and there is a test for it. A user-supplied `--receipt` path is under user control and is blocked remotely.
- **Receipt contents:** only ids, a hash and the resume commands. No key, input or signed URL. The commands are shell-quoted with `shellQuote`.
- **Concurrency:** temp names include pid plus a timestamp and use the `wx` flag, so parallel detached runs cannot collide.
- **Resume never resubmits:** `result.ts` makes only GETs. The JOB_PENDING check triggers only on a 4xx followed by a status of `IN_QUEUE`/`IN_PROGRESS`, and auth errors fall through. A test asserts no POST.
- **UNKNOWN_REMOTE_STATE classification:** `submitFalRequest` maps `HttpError(0)` to this state unless the cause is DNS or a refused connection. Timeouts and truncated bodies are therefore treated as unknown, which is correct. `httpJson` does not retry POSTs internally.
- **Worker policy:** `fal upload` is limited to positional file input. The `fal run` options `file` and `receipt` are unsupported remotely. `--output-dir` on run and result is set by the server. The catalog matches a fresh build.
- **Provider client rule:** `storage.ts` has no `node:*` imports. The Node-only code lives in `node-input-files.ts`, `receipt.ts` and the commands.
- **Large files:** `fs.openAsBlob` streams them. The single PUT and the multipart slices stay lazy.

### Recommended actions
1. M1: add per-attempt timeouts to upload PUTs, part PUTs and complete, plus a stall test.
2. M2: fall back to the `ETag` header for multipart parts and parse part bodies tolerantly.
3. L1: use `Object.hasOwn` in `parseExpiresIn` (one line).
4. M3: add the missing tests (auth failure, output redaction, receipt-write failure, 5xx on submit).
5. L2 and L3: fix the `input_hash` doc claim or behaviour, and reject duplicate `--file` keys.
6. L4 to L9: optional cleanups.

### Plan follow-ups
- **Met:**
  - upload to fal storage;
  - `run --file` (generic, no model wrappers);
  - `--detach` with a JSON receipt (0600, atomic) and next commands;
  - `status`/`result` resume without resubmitting;
  - `JOB_PENDING` / `UNKNOWN_REMOTE_STATE`;
  - EN/VI docs, `skill/SKILL.md`, worker catalog and policy;
  - backward compatibility.
- **Partly met:**
  - the "upload timeout/retry" and "revoked/invalid auth" tests (M1, M3);
  - `--output <path>` for result: only `--output-dir` was added, which seems acceptable.
- **Not checked here:** `verify:docs`, `check:bundle` (the worker tests ran; the bundle check did not) and `npm run build` plus smoke tests.

### Unresolved questions
- Does fal's `fal-cdn-v3` multipart part response put the etag in the JSON body? Upstream reads the body first, but M2 matters if it does not.
- Does the `fal-cdn-v3` signed `upload_url` carry its token in the path rather than the query? If so, `redactUrl` would not hide it in `HttpError` messages, and the telemetry path would record it.

Status: DONE_WITH_CONCERNS
Summary: No critical or high findings: key handling, receipts, resume-without-resubmit and the worker policy are sound, and all tests, typecheck and lint pass. Two medium robustness gaps remain in uploads (no timeout on PUTs; multipart needs the etag in the response body), plus missing tests and several low issues, including `--expires-in constructor` being silently accepted (reproduced).