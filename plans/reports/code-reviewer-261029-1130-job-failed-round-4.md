# Code review, round 4: JOB_FAILED classification (2169425)

Range: `origin/dev..HEAD` on `claude/relaxed-clarke-m00f02`. Focus: 2169425 (10 files, +260/-44).
Prior report: `plans/reports/code-reviewer-261029-1130-job-failed-round-3.md` (N1-N5 in scope, N6/N7 out).

## Verification run
- `npx biome check src tests`: clean. `npx tsc --noEmit -p .`: clean. `npm run build`: ok.
- `npx vitest run`: 149 files / 2812 tests pass (22 skipped).
- I wrote probes in the scratchpad (`probe.ts` run with tsx, `perf2.mjs` run with node). They import the real
  `classifyMessage`, `classifyError` and `ProviderJobFailedError`. `git status` is clean.
- Not run: `verify:docs` (only prose changed in the docs) and `check:mcp` (`minimax/client.ts` changed only the status comparison).

## Prior findings: status

| ID | Status | Evidence |
|---|---|---|
| N1 MiniMax `Fail` | Fixed | `minimax/client.ts:108` accepts `Fail`. The new `poll-async-task.test.ts` drives `pollAsyncTask` with mocked fetch. The generator stringifies the error (`generators/video.ts:80`), so production goes through the text path. `Task 3091846 failed: {..."status":"Fail"}` gives JOB_FAILED (probe) |
| N2 CONTENT_BLOCKED | Fixed for class-based providers; **regresses text-path providers** (R1) | `classifyError` returns JOB_FAILED for every terminal `ProviderJobFailedError`. `isJobFailure` checks only JOB_FAILED |
| N3 other-job completion | Fixed for the upload case | `otherJobOk` requires `e.job` (upload paths are excluded by `jobIdentity`). Residual weakness in L3 |
| N4 cancels | Fixed | BytePlus `Task failed: {"status":"cancelled"}` and `{"status": "Canceled"}` give UNKNOWN. Cloudflare canceled/cancelled/aborted give UNKNOWN and failed gives JOB_FAILED (probe on the real error class). EN/VI doc sentence now holds |
| N5 non-terminal HTTP | Fixed | `video v2: HTTP 503 from ...` gives PROVIDER_UNAVAILABLE with http_status 503 (test and probe) |

## Findings

### R1 (Medium) Text-path verdicts lose JOB_FAILED when the reason matches an earlier rule, and with CONTENT_BLOCKED dropped from `isJobFailure` a moderation-failed async job now counts as completed
BytePlus (`commands/{video,image-to-video,reference-to-video,generate-3d,status}.ts`), OpenRouter
(`image-to-video.ts:113`, `video-status.ts:114`) and Leonardo (`status.ts:91`, `video.ts:162`) do not throw.
They call `logger.error("Task|Job|Generation failed: " + JSON.stringify(payload))` and `process.exit(1)`, so
`finalizeRun` classifies the logged line with `classifyMessage`. In `TEXT_RULES`, MISSING_KEY, INVALID_KEY,
CONTENT_BLOCKED, QUOTA_EXCEEDED, RATE_LIMITED, TIMEOUT and MODEL_NOT_FOUND all come before JOB_FAILED. Probe:

| Logged line | Code |
|---|---|
| `Task failed: {"status":"failed","error":{..."message":"blocked by content moderation"}}` | CONTENT_BLOCKED |
| `Task failed: {"status":"failed","error":{"code":"QuotaExceeded",...}}` | QUOTA_EXCEEDED |
| `Task failed: {"status":"failed","error":{"message":"Internal timeout"}}` | TIMEOUT |

In 4dede24 the CONTENT_BLOCKED row still counted as a job failure (it has no `HTTP nnn`). After this commit, an
`--async` submit (ok) followed by `byteplus status <id>` (or `openrouter video-status`, or `leonardo status`) that reports
a moderation failure gives the operation **completed**. The other rows were already wrong on 4dede24. The commit message says
"a terminal job failure is JOB_FAILED even when its reason names moderation", but that holds only for providers that
throw `ProviderJobFailedError`. The single-run sync path is unaffected, because every run failed.
Fix: in those commands, throw `new ProviderJobFailedError(\`Task failed: ${JSON.stringify(e.value)}\`, "<provider>",
{ terminal: <status is the provider's failed state> })` instead of logging and exiting. This also moves BytePlus
cancels onto the class path, so the regex lookahead becomes unnecessary. A test should drive one status command with
mocked fetch that returns a failed payload whose reason names moderation, and assert JOB_FAILED in the ledger.

## Regex review (`error-classify.ts:182`)
`/^(?!.*"status"\s*:\s*"(?:cancell?ed|aborted)")(?:.*\b(task|job|...) (?:[\w.:-]*\d[\w.:-]* )?(failed|was canceled|errored)|.*status:? ?"?failed)/is`
- Correctness: the regex matches the intended cases (probe: `job 12 failed`, `prediction p-1 errored`,
  multiline `line1\njob 12 failed` with `s` give JOB_FAILED; `task polling failed`, `job abc failed` do not match).
  The new `\b` drops `subtask 12 failed`, which is intended. The lookahead is case-insensitive (`"Canceled"`). It
  matches only the JSON-quoted form, which is the one the text-path emitters use.
- Backtracking: no exponential blow-up, but the id group `[\w.:-]*\d[\w.:-]*` is **quadratic** in the length of an
  unbroken `[\w.:-]` run after a noun. This was already in 4dede24, and the greedy `.*` prefix added here creates a
  second trigger. The old unanchored form stopped at an early `Task failed`. The new form starts from the end of
  the string and backtracks, so it tries every later noun first. Measurements (node, ms):

  | Input | 4dede24 | 2169425 | `(?:(?=[\w.:-]*\d)[\w.:-]+ )?` |
  |---|---|---|---|
  | `"task " + "1"x50k` | 1164 | 1169 | 0 |
  | `"task " + "1"x100k` | 4723 | 4763 | 0 |
  | `"Task failed: job " + "a1"x50k` | 0 | 2404 | 0 |

  Real messages rarely contain a run of 50k id characters after `task `/`job `, so this is Low. The
  `(?=[\w.:-]*\d)[\w.:-]+` form matches the same strings and runs in linear time. Use it.
- False negatives from the lookahead: any `"status":"cancelled"` in the line disables the rule. For example,
  `Task failed: {"status":"failed","history":[{"status":"cancelled"}]}` gives UNKNOWN (probe). The BytePlus, OpenRouter
  and Leonardo payloads have one top-level status, and I found no emitter with a nested cancelled status. Low. R1's fix
  (class-based throw) removes the need for the lookahead.

## Low
- L1 Quadratic id group, see above.
- L2 The lookahead disables the rule for the whole line (nested `"status":"cancelled"`), see above.
- L3 `otherJobOk` trusts only `e.job.id`. `jobIdentity` (`run-state.ts:159-171`) also assigns `job` to an ok GET-only
  run, including the `x-request-id` header id (`usage-extract.ts:314`). An ok helper or read run of any kind under the same
  explicit operation id therefore completes a failed operation. It also needs the first id that a submit records to
  equal the id that the failing poll records. The 4dede24 check (`every` over all `provider_ids`) did not have that
  weakness. Combine the two: `e.ok && e.job !== undefined && jobIdsOf(e).every((j) => !failed.has(j))`.
  Optionally also require a submit (`e.cost?.role === "charge"`).
- L4 A non-terminal mixed HeyGen batch that contains `HTTP 403` now gives INVALID_KEY with a key hint, even
  when the 403 came from a signed download URL. This is the same as dev and acceptable.
- L5 EN `catalog.md:94` was not re-wrapped after the edit (one long line). Cosmetic.

## Recommended actions
1. R1: make the BytePlus, OpenRouter and Leonardo failed-poll paths throw `ProviderJobFailedError` with `terminal`,
   and add a mocked status-command test with a moderation reason.
2. L1: replace the id group with `(?:(?=[\w.:-]*\d)[\w.:-]+ )?`.
3. L3: add `jobIdsOf(e).every(...)` back to `otherJobOk`.

## Metrics
- Typecheck: 0 errors. Lint: 0 issues. Tests: 2812 passed / 22 skipped.

Status: DONE_WITH_CONCERNS
Summary: N1-N5 are fixed on their real paths. Dropping CONTENT_BLOCKED from the usage failure check regresses
text-path providers (BytePlus, OpenRouter, Leonardo): an async job whose status run reports a moderation failure now counts as completed.
Concerns/Blockers: R1 (Medium) should be fixed before merge. The regex is quadratic, not exponential (Low).
