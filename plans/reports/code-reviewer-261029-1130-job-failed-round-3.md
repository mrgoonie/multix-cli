# Code review, round 3: JOB_FAILED classification (4dede24)

Range: `origin/dev..HEAD` on `claude/relaxed-clarke-m00f02`. Focus: 4dede24 (17 files, +334/-41).
Prior report: `plans/reports/code-reviewer-261029-1130-job-failed-classification.md`.
Decisions in force: provider cancels are not JOB_FAILED; L2 and L3 accepted.

## Verification run
- `npx biome check src tests`: clean. `npx tsc --noEmit -p .`: clean. `npm run build`: ok.
- `npx vitest run`: 148 files / 2808 tests pass (8 files skipped).
- `npm run check:mcp`: pass ("1 file(s) clean").
- Probe: a temporary vitest file was copied into `tests/unit/`, run, and deleted. `git status` is clean. It drives
  real throw sites where it can (`assertJobSucceeded(agentState(...))`, `modelVideoState`,
  `mapReplicateError(new HttpError(...))`), the real error classes, `classifyMessage` for logged text,
  and `aggregateUsage` for ledger outcomes.

| Case | Result |
|---|---|
| MiniMax logged `Task 3091846 failed: {"status":"Failed",...}` | JOB_FAILED |
| MiniMax `Task 3091846 timed out after 600s` | TIMEOUT |
| Replicate `canceled` / `aborted` | UNKNOWN / UNKNOWN |
| HeyGen agent `waiting_for_input` (via `assertJobSucceeded`) | UNKNOWN |
| HeyGen model-video `cancelled` / `failed` | UNKNOWN / JOB_FAILED |
| TopView prediction `failed` / `payment_required` | JOB_FAILED / INVALID_INPUT |
| TopView task `success` + "no replaced image has a face" | UNKNOWN |
| HeyGen non-terminal `video v2: HTTP 503 from <url>: Service Unavailable` | **UNKNOWN** (dev and 159b87f: PROVIDER_UNAVAILABLE) |
| Replicate poll 403 WAF page via `mapReplicateError` | CONTENT_BLOCKED; ledger message has no `HTTP 403` |
| Aggregator: explicit op, ok upload run `[asset-1]` + ok submit `[J1]` + JOB_FAILED `[J1]` | **completed** |
| Aggregator: Replicate WAF poll row (CONTENT_BLOCKED, "...(403): ...blocked") after ok submit | **failed** |

## Prior findings: status

| ID | Status | Evidence |
|---|---|---|
| H1 MiniMax | **Not fixed in production** | The text now classifies, but the throw is unreachable (see N1) |
| M1 cancels | Fixed for class-based providers | Replicate, Atlas, Runway, Sume, Gemini and HeyGen give UNKNOWN on cancel. BytePlus and Cloudflare do not (N4) |
| M2 HeyGen waiting_for_input | Fixed | `jobs.ts:325` gives `terminal = status === "failed"`. Probe: UNKNOWN. `completeJobs` counts only terminal failures |
| M3 TopviewPredictionError | Fixed | `failed` gives JOB_FAILED. `payment_required` gives INVALID_INPUT, not QUOTA_EXCEEDED as the prior report predicted (N5) |
| M4 TopviewTaskError on success | Fixed | `terminal: task.status === "fail"`. Probe: UNKNOWN |
| M5 explicit op resubmit | Fixed, but too broad | Any ok run with disjoint ids completes the operation (N3) |
| L1 WAF 403 on poll | **Partly fixed** | Covers only messages that contain `HTTP nnn`. Provider ApiError messages do not (N2) |

## Findings

### N1 (High) MiniMax: the JOB_FAILED throw never fires for a real failed task, so H1 is still open
`src/providers/minimax/client.ts:107` checks `status === "Failed" || status === "Error"`. The MiniMax
query API documents `Preparing | Queueing | Processing | Success | Fail`
(https://platform.minimax.io/docs/api-reference/video-generation-query). A failed task returns
`"Fail"`, so `pollAsyncTask` keeps polling until the 600 s deadline. It then throws
`Task <id> timed out after 600s`, which classifies as TIMEOUT (probe), and the hint says to resume
a dead job. The text-rule widening only helps a status string that is never returned. The
commit's own test (`error-classify.test.ts:177`) uses `{"status":"Fail"}` in the message, but the
client would never produce it. This is a pre-existing bug, but it is the H1 path and the commit claims H1 is fixed.
Fix: `if (status === "Fail" || status === "Failed" || status === "Error")`. Add a `pollAsyncTask` test
with mocked fetch that returns `status: "Fail"` and asserts a throw (not a timeout). With fake
timers, also run it through `generateMinimaxVideo` and `classifyMessage` of the logged line.

### N2 (Medium) L1 fix keys on the text `HTTP nnn`, which provider HTTP errors do not contain
`usage-aggregate.ts:107-109` excludes CONTENT_BLOCKED only when the stored message matches
`/\bHTTP \d{3}\b/`. Replicate, Runway, TopView and Sume map HTTP failures to `ProviderError`
subclasses with messages like `Replicate denied access to prediction p1 (403): ...`
(`replicate/client.ts:96`, `runway/client.ts:111`). `HeygenApiError` rewrites its message to
`HeyGen API error 403: ...` (`heygen-errors.ts:111`). Probe: a Replicate status poll that gets a
WAF page "Sorry, you have been blocked" classifies as CONTENT_BLOCKED with no `HTTP 403` in the message,
and the operation is **failed** although the job's submit run was ok. The ledger stores
only `{ code, message }` (`history-store.ts:35`), so the aggregator cannot tell the two cases apart.
Fix: record the verdict's origin in the ledger, for example `error.http_status` (already on `ErrorInfo`, and dropped
at `agent-runtime.ts:333`) or a `job_verdict: true` flag set when the error is a terminal
`ProviderJobFailedError`. Key `isJobFailure` on that field instead of on message text. The same field fixes the
reverse case: a terminal job failure whose provider reason quotes `HTTP 4xx` and a moderation word
is currently not counted as a failure.

### N3 (Medium) M5 fix: any ok run with disjoint ids completes a failed operation, not only a resubmit
`usage-aggregate.ts:136-140` treats an ok run whose ids are all outside the failed set as "another job
succeeded". `provider_ids` holds every id the run saw: upload or asset ids, `request-id` headers
and file ids (`fetch-telemetry.ts:303-307`, `usage` id keys `id`, `request_id`, `file_id`...).
SKILL.md says `MULTIX_OPERATION_ID` "groups submit/poll/download runs into one operation", so an
explicit operation commonly includes an upload or helper run. Probe: an ok upload run `[asset-1]`, an ok
submit `[J1]` and a JOB_FAILED poll `[J1]` give **completed**. The real job failed.
Fix: count only an ok run that names a job (`e.job?.id`, which `jobIdentity` already restricts to
non-upload submits). The run must be a submit (`cost.role === "charge"`, or a non-GET job call), and its
`job.id` must not be in the failed set. Add the upload case to the test.

### N4 (Medium) Docs now promise "canceled is not a failed job", but text-path providers still report cancels as JOB_FAILED
EN/VI `commands/catalog.md` now say "A job that was canceled, paused for input or waits for payment
is not a failed job." BytePlus treats `cancelled` as failed (`byteplus/generators/video.ts:134`,
`three-d.ts:92`), and the commands log `Task failed: {...}` (`byteplus/commands/*.ts`), which gives JOB_FAILED (probe:
`Task failed: {"status":"cancelled"}` is JOB_FAILED). Cloudflare maps `canceled`/`cancelled`/`aborted` to
`ProviderError("Cloudflare video generation failed")` (`cloudflare/commands/video-helpers.ts:44,50-54`), which also gives
JOB_FAILED. The classification is pre-existing, but this branch makes JOB_FAILED a sticky operation
failure, and the doc claim is now false for these providers. This also contradicts the decision that provider cancels are not
JOB_FAILED.
Fix: keep the text-path messages away from the rule on cancel. For example, BytePlus could log `Task cancelled: ...`
when `status === "cancelled"`, and Cloudflare could include the status (`... generation ${status}`). Otherwise, narrow the doc
sentence to the providers that honor it.

### N5 (Medium) Non-terminal path drops HTTP-status classification, a regression for HeyGen download and poll failures
`error-classify.ts:285-286` classifies a non-terminal `ProviderJobFailedError` with
`codeFromText(message)` only. In 159b87f and on dev the same error went through `classifyMessage`,
which honors `HTTP nnn` (code, `http_status`, retryable). `completeJobs` passes `terminal=false` whenever any
failure is a poll rejection or a download error (`node-helpers.ts:543-547`). For a single job whose render
succeeded, the download errors come from `http-client.ts:141` as `HTTP 503 from <url>: ...`. Probe:
`video v2: HTTP 503 from ...` gives **UNKNOWN**, where dev gave PROVIDER_UNAVAILABLE (retryable). A 404 or 403 on the
signed URL loses NOT_FOUND / INVALID_KEY in the same way. A mixed batch (provider fail plus `fetch failed`)
gives UNKNOWN because JOB_FAILED precedes NETWORK_ERROR in `TEXT_RULES`, and that match is then mapped to UNKNOWN.
Fix: `const info = classifyMessage(message); return info.code === "JOB_FAILED" ? build("UNKNOWN", message, ...) : info;`.
Better, strip the provider-verdict lines before classifying the batch text. Add a `completeJobs` test with
a mocked download returning 503.

### N6 (Low) TopView `payment_required` classifies as INVALID_INPUT
The message contains `payment_required` with an underscore, so the QUOTA rule (`payment required` with a space) does not match.
The INVALID_INPUT rule matches `required` and wins (probe). The result is the same on dev, so this is not a regression, but the
hint "fix inputs" is wrong for a top-up-and-resume state. Fix: make the QUOTA regex accept `payment[ _]required`, or
use the words "payment required" in `predictionFailureMessage`.

### N7 (Low) Replicate `aborted` gives UNKNOWN
`terminal: prediction.status === "failed"` also demotes `aborted`. Replicate uses `aborted` for a
prediction that its deadline terminated before it ran. TIMEOUT or JOB_FAILED would guide the caller better than UNKNOWN. This is a product
call. If UNKNOWN is intended, document it in the class comment.

## JOB_FAILED regex: false-positive scan
New regex: `(task|job|prediction|generation|interaction) (?:[\w.:-]*\d[\w.:-]* )?(failed|was canceled|errored)|status:? ?"?failed`.
- Grep of `src/**/*.ts` for throw and log texts: the only sites that use the new noun-id-verb form are Atlas
  (`atlascloud/client.ts:62`, class-based anyway) and MiniMax (`minimax/client.ts:109`).
  `status "failed"` appears only in HeyGen `assertJobSucceeded` output (class-based) and the Atlas reason.
  `interaction` appears in no text-classified message. Gemini uses the class, and ids without a digit do not match.
  JSON `"status":"failed"` does not match (the quote before the colon breaks it). The `status: ${x}` lines
  in Leonardo and OpenRouter go to `console.error` without a `✗/Error:` prefix, so they never reach `lastErrorLine`.
- I found no new false positive in real messages. The widening is still loose on hypothetical text: probe
  `frame 12 of job v2 failed to encode`, `ffmpeg job 2 errored: ...` and `status failed to load` all give JOB_FAILED.
  Consider anchoring the verb to `failed\b(?! to)`. No current site emits these.
- Pre-existing and not widened by this change: `Generation failed: ${msg}` in
  `gemini/commands/generate.ts:124` wraps any error. `Generation failed: fetch failed` and
  `... ENOENT ...` give JOB_FAILED because the JOB_FAILED rule precedes NETWORK_ERROR and NOT_FOUND. A sync run is a single-run
  operation, so the usage outcome is unchanged, but the code and hint are wrong. Open a separate issue.

## Test adequacy
- The new classify tests again construct errors directly. No test drives `pollAsyncTask` (the test would have caught N1),
  `completeJobs` (N5), or the aggregator with realistic `provider_ids` (N3) or a provider-mapped 403 (N2).
- `usage-aggregate.test.ts` covers the WAF case only with a message that contains `HTTP 403`. This is the one form
  the fix handles.

## Recommended actions
1. N1: accept `"Fail"` in `pollAsyncTask` and add a mocked-fetch test (H1 is not closed without it).
2. N5: classify non-terminal errors with `classifyMessage` and demote only JOB_FAILED.
3. N2: persist `http_status` (or a verdict flag) in the ledger error and key `isJobFailure` on it.
4. N3: limit "another job succeeded" to ok runs whose `job.id` names a different submitted job.
5. N4: keep BytePlus and Cloudflare cancels out of JOB_FAILED, or correct the EN/VI doc sentence.
6. N6/N7: optional.

## Metrics
- Typecheck: 0 errors. Lint: 0 issues. Tests: 2808 passed / 22 skipped.

Status: DONE_WITH_CONCERNS
Summary: M2, M3 and M4 are fixed, and M1 is fixed for class-based providers. H1 is not fixed in production because MiniMax returns "Fail", which the client never matches. L1 and M5 are fixed only partially (text-keyed check, ids too broad). The non-terminal path regresses HTTP-status classification for HeyGen download and poll failures.
Concerns/Blockers: N1 (High) and N2, N3, N4, N5 (Medium) should be fixed before merge. The pre-existing Gemini "Generation failed: <any error>" misclassification needs its own issue.
