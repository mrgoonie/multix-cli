# Code review: fal local upload + detached submit (issue #284)

Branch `claude/gracious-heisenberg-reo5hn`, commit 8f959b9 (`git diff origin/main...HEAD`, 32 files, +1898/-86).
Reviewer: isolated code-reviewer agent. No files modified other than this report. No paid APIs called.

## Verification run

- `npm run lint`: clean (488 files).
- `npm run typecheck`: clean.
- `npm run build` then `npx vitest run`: 90 files passed, 4 skipped; 1506 tests passed, 12 skipped.
- `npm run check:mcp`: worker typecheck/tests passed; bundle check clean (no `node:*`, commander, execa, or CLI code).
- `npm run verify:docs`: 0 failures.
- Protocol compared against `@fal-ai/client` 1.10.1 `src/storage.js` (unpkg). Initiate URL, `storage_type=fal-cdn-v3`, body, `X-Fal-Object-Lifecycle` header, 90 MB threshold, 10 MB parts, `<path>/<n>?<query>` part URLs, `<path>/complete?<query>`, and part bodies sent without Content-Type all match. fal-js also has an `immediate` (60 s) preset, which this CLI does not offer.
- Probe (a scratch vitest file, nothing written to the repo) confirmed findings M2 and M3 below.

## Findings

### High

**H1. A submit that gets a gateway 5xx is reported as retryable, so an agent may pay for the same job twice.**
`src/providers/fal/run-helpers.ts:246-250`, `src/core/error-classify.ts` (`codeFromHttp`)
- `submitJob` only turns `HttpError` status 0 into `UnknownRemoteStateError`. Any other failure from the POST is rethrown as is: a 502 or 500 becomes `PROVIDER_UNAVAILABLE` (retryable, exit 4, hint "retry later"), and a 504 or 408 becomes `TIMEOUT` (retryable, exit 6). The TIMEOUT hint says "use the status/resume command", but there is no request id to resume with.
- Scenario: `queue.fal.run` is behind an edge proxy. The origin accepts the job, but the edge returns 502/504 because the origin answered slowly. An agent in `--json` mode sees `retryable: true` and runs `fal submit` again, which bills a second job. This is exactly the kind of unknown outcome the issue meant `UNKNOWN_REMOTE_STATE` to cover.
- A related case: a 2xx answer whose body is not valid JSON (`fetchJson` throws HttpError with the 2xx status, "Invalid JSON response"). fal accepted the job, but the error is classified `PROVIDER_REJECTED`, with no unknown-state warning.
- Fix: in `submitJob`, wrap status 0, 408, 500, 502 and 504, and any 2xx that failed to parse, in `UnknownRemoteStateError`. Leave 429, 503 with Retry-After, and 4xx as they are. Add tests for 502, 504 and a 200 with an unparseable body, each asserting that exactly one POST was sent and the code is `UNKNOWN_REMOTE_STATE`.

### Medium

**M1. If fal accepts and bills a job but its submit response fails validation, the request id is lost.**
`src/providers/fal/run-helpers.ts:252-264`, `src/providers/fal/commands/submit.ts:30-35`
- After a successful POST, `submitJob` throws a `ProviderError` when `status_url` or `response_url` is missing, or when it points to an untrusted host. This can happen with a `FAL_BASE_URL` proxy that rewrites responses, or if fal changes its queue host. By then the job is accepted and billed. The `request_id` was written only by `logger.debug`, and `fal submit` saves no receipt, so without `-v` the user cannot recover the id.
- Resuming does not need those URLs: `fal status` and `fal result` rebuild the path with `statusPath(model, requestId)` and `resultPath(model, requestId)` against `FAL_BASE_URL`, and never read the receipt's `status_url` or `response_url`.
- Fix: put `request_id` (and the model) in the ProviderError message. In `submit`, write the receipt as soon as a `request_id` exists, and make `status_url`/`response_url` optional in `isReceipt`, or drop them, since nothing reads them.

**M2. An invalid `--file` field path is only rejected after that file is already uploaded and public.**
`src/providers/fal/local-files.ts:409-419`
- `applyFileFields` checks every file path before uploading. The field path is only checked by `setInputField`, which runs after `uploadLocalFile`. Probe: input `{"prompt":"x"}` with `--file prompt.video_url=./a.mp4` made 2 network calls (initiate + PUT) and then threw `"prompt" is not an object`. The file now sits at a public bearer URL that nothing records.
- The docs claim "Every path is checked before the first upload, so a typo fails before any file leaves the machine". A typo in the field part breaks that promise. The same happens with an out-of-range array index (`refs.5.url`).
- Fix: before any upload, run every spec through `setInputField(structuredClone(input), spec.field, "placeholder")`. Add a test asserting zero fetch calls for a bad field path.

**M3. A numeric path segment under a missing parent creates an object, not an array, despite the documented example.**
`src/providers/fal/local-files.ts:390`, docs `docs-site/.../commands/fal.md` ("`refs.0.image_url`"), `skill/SKILL.md`
- Probe: `setInputField({}, "refs.0.image_url", "u")` produces `{"refs":{"0":{"image_url":"u"}}}`. A model expecting a list rejects that input, but only after the file was uploaded and, on `run`, possibly after a paid submit that fails validation on fal's side.
- Fix: when the parent is missing and the next segment is numeric, create `[]` and allow index 0. Otherwise reject the numeric segment. Alternatively, state in the docs that the array must already exist in `--input`.

### Low

**L1. `fal run` receipts are never marked COMPLETED, and receipts are never pruned.**
`src/providers/fal/commands/run.ts:37-43`, `src/providers/fal/job-receipts.ts:145-163`
- Every successful `fal run` leaves a receipt with status `IN_QUEUE` forever, so `fal jobs` shows completed runs as still queued.
- `listReceipts` parses every file on each call, with no age or count cap.
- Fix: call `updateReceiptStatus(requestId, "COMPLETED")` after `submitAndWait` returns. Optionally prune receipts older than N days, or sort by file mtime before parsing.

**L2. When `fal run` fails to save its receipt, it says so only at debug level.**
`src/providers/fal/commands/run.ts:41`
- The user is not told that `fal status <requestId>` (without a model) will not work for this run. Use `warn`, as `submit` does.

**L3. Uploads always send `FAL_KEY` to `https://rest.fal.ai`, even when `FAL_BASE_URL` routes fal traffic elsewhere.**
`src/providers/fal/storage.ts:23,156`
- If a user points `FAL_BASE_URL` at a gateway because direct egress is blocked, or because `FAL_KEY` holds a gateway token, uploads either fail or send that credential to fal. This is documented behaviour, but it is the first fal path that ignores `FAL_BASE_URL`.
- Fix: when `FAL_BASE_URL` is not the default, warn before an upload, or refuse it unless an explicit opt-in is set.

**L4. Upload retries duplicate an existing core helper, and the upload timeout is fixed.**
`src/providers/fal/storage.ts:98-102,193`
- `isRetryable` re-implements `isRetryableServerStatus` from `src/core/async-poll.ts`, adding 408/429.
- The 30-minute per-request PUT timeout ignores `MULTIX_UPLOAD_MIN_KBPS`, which the Gemini and Runway uploads honour.
- Fix: reuse the core helper, and derive the timeout from the part size and `MULTIX_UPLOAD_MIN_KBPS`.

**L5. `sendUnkeyed` treats every fetch rejection as a transient network error.**
`src/providers/fal/storage.ts:143-146`
- A refused redirect (`redirect: "error"` gives "unexpected redirect") or a TLS certificate failure is retried 3 times with backoff, although retrying cannot help.
- On the single-PUT path the response body is never read or cancelled.
- Fix: route rejections through `toFetchError` (`src/core/fetch-error.ts`), which separates deterministic failures from transient ones, and call `response.body?.cancel()`.

**L6. The multipart `complete` POST is retried even if the first attempt may have succeeded.**
`src/providers/fal/storage.ts:228-235`
- If the first `complete` succeeded but its response was lost, the retry may get a 4xx, and the command fails although the file exists at `file_url`. fal-js does not retry `complete`.
- Fix: send `complete` once, or treat a 4xx after an earlier attempt that ended in a network error as success only if `file_url` can be fetched.

**L7. In the worker, `fal status <requestId>` and `fal result <requestId>` without a model can never work.**
`worker/src/jobs/cli-command-policy.ts`
- Each job container gets its own `HOME` (`worker/container/job-runner.mjs:144`), so no receipt from an earlier job is ever there. Remote callers see the CLI description "model optional when a receipt was saved".
- The policy itself is correct: `fal jobs` is excluded, `fal upload` takes its file from inputs, `--file` and `--receipt` are unsupported, and `--output-dir` is forced to the job output directory.
- Fix (docs only): note in the worker catalog or tool docs that remote callers must always pass the model.

**L8. Minor usability gaps.**
- `--expires-in` is silently ignored on `run`/`submit` when no local `--file` is given. Warn, or reject it.
- `--file video_url=~/x.mp4` is not tilde-expanded by shells (the `~` is mid-word), so it fails with "File not found". Mention this in the docs, or expand a leading `~/` in the value.

## Checked and found sound

- **Key handling:** the key is sent only to `rest.fal.ai` on initiate. `fetchJson` refuses a cross-origin redirect when the request carries an `authorization` header. The signed `upload_url` is sent without the key, with `redirect: "error"`, and errors name only its host (`safeUrl`). Debug lines do not include URLs.
- **Prototype pollution:** `__proto__`, `prototype` and `constructor` segments are refused. Walking through an inherited member such as `hasOwnProperty` or `toString` throws, because the value is a function, not an object. Array segments must be digits.
- **Receipts:** written atomically (temp file + rename) with mode 0600, directory created 0700. They hold no key and no input, only a sha256 of the input. Request ids that are not plain tokens are hashed before being used as file names, so a crafted id cannot traverse paths. `MULTIX_FAL_JOBS_DIR` is refused in a project `.env`.
- **No duplicate submits:** the POST is sent once. `httpJson` has no retry wrapper, and the tests assert exactly one POST.
- **Backward compatibility:** `fal status <model> <requestId>` and `fal result <model> <requestId>` keep the same argument order, and the test exercises the two-argument form. `fal run --input` behaves as before. The `fal status` logger moved to stderr, which is an improvement.
- **Runtime neutrality:** `storage.ts` imports only core errors, `fetch-json` and a logger type, with no `node:*` modules. Moving `upload-mime.ts` to `src/core/` keeps it runtime-neutral. The worker does not import the new modules.

## Test gaps

- Submit failing with 502, 504, 500, or a 2xx with an unparseable body (H1).
- Submit response with an untrusted or missing `status_url`: the request id must still reach the user (M1).
- A bad field path or array index must make zero network calls (M2); a numeric segment under a missing parent (M3).
- A redirect from the signed PUT URL must be refused and must not leak the URL; retry of a multipart part; `complete` failure.
- A request id that is not a plain token (hashed file name, no path traversal); mode 0700 on the receipts directory.
- `MULTIX_FAL_JOBS_DIR` in a project `.env` is refused. Confirm whether `tests/unit/project-env*` covers the new name.

## Resolution (author follow-up)

- H1 fixed: `submitJob` maps status 0, 408, any 5xx and a 2xx with an unreadable body or no `request_id` to `UNKNOWN_REMOTE_STATE` (not retryable). Tests: 502 and bad-JSON submits give one POST and `UNKNOWN_REMOTE_STATE`.
- M1 fixed: a missing or untrusted `status_url`/`response_url` error now names the queued request id and the `fal status` command; nothing is sent to the untrusted host (test added).
- M2 fixed: every `--file` field path is applied to a copy of the input before any upload (test: no network call on a bad field).
- M3 fixed: a numeric segment under a missing parent creates an array (test added; docs describe it).
- L1/L2 fixed: `fal run` marks its receipt `COMPLETED` and warns when the receipt cannot be saved.
- L6 fixed: the multipart `complete` step is sent once, as in fal-js.
- L7 documented: the request-id-only form needs a receipt on the same machine; pass the model in the remote MCP runner.
- L8 partly fixed: `--expires-in` without a local `--file` now warns. `~` in `--file field=~/x` is left to the shell, as with other path flags.
- L3, L4, L5 kept as is: uploads must go to fal's storage host whatever `FAL_BASE_URL` says (documented); the 30-minute upload timeout and the shared retry predicate are cosmetic; a refused redirect on the signed upload URL is rare and costs at most two extra unkeyed attempts.
