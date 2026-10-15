# Code review: 5015d20 fix(runway) hardening (#235)

Worktree: /workspace/wt-235. Reviewed: `git show 5015d20`, plus src/core/http-client.ts, src/core/fetch-json.ts, src/core/async-poll.ts, src/core/errors.ts.

## Scope
- Files: src/providers/runway/{client,node-inputs,node-outputs}.ts, tests/unit/providers/runway/{client,commands}.test.ts
- LOC: +59 / -9
- Checks: `npx vitest run tests/unit/providers/runway` 75 passed / 1 skipped; `npx tsc --noEmit -p .` clean; `npx biome check src tests` clean. client.ts has no `node:*` imports (only the header comment mentions them).

## Overall
Fixes 1 and 2 are correct. Fix 3 scrubs the message that `mapRunwayError` builds, but the secret still reaches stderr through another path (PollTimeoutError). It also still leaks partly when the secret crosses the truncation boundary.

## High

### H1. The secret leaks through the PollTimeoutError message (waitForTask)
`pollUntil` (src/core/async-poll.ts:113) builds the timeout message from the raw transient error: ` Last error: ${lastError.message}.`. `lastError` is the raw `HttpError`, and its message is `HTTP ${status} from ${url}: ${snippet}` (errors.ts:72). That snippet holds up to 500 characters of body and is not scrubbed. `waitForTask` rethrows `PollTimeoutError` unchanged (client.ts:379), so it never goes through `mapRunwayError`. A gateway that answers 502/503/504/429/408 and echoes `Authorization: Bearer <secret>` is the threat the issue names. Polling keeps going on those transient errors, and when the deadline passes, cli.ts prints the full secret.
Repro (esbuild bundle of the real client, fake fetch, no network):
```
fetch -> 502 "gateway: Bearer key_aaaa..."; waitForTask(..., {timeoutMs:10})
=> PollTimeoutError, message.includes(SECRET) === true
```
Fix: in `waitForTask`, catch `PollTimeoutError` and rebuild it with the secret scrubbed. Or pass `isTransientError`/`fetchStatus` so that errors are mapped (scrubbed) before pollUntil stores them. For example, wrap `fetchStatus` so it rethrows `HttpError` copies whose snippet is scrubbed. Add a test: poll with a 502 that echoes the secret until timeout, then assert that the message does not contain SECRET.

## Medium

### M1. Scrubbing runs after truncation, so a secret that crosses the boundary leaks partly
`errorDetail` cuts the text to `DETAIL_MAX` (300) before `split(secret)` runs. When the secret starts before character 300 and ends after it, the cut-off prefix no longer matches and is printed. Repro: body = 280 x's + " Bearer " + SECRET leads to a message ending in `Bearer key_aaaaaaaa` (a partial key). The JSON path (`body.error` sliced to 300) has the same problem. Fix: scrub `error.snippet` before `errorDetail(...)`. Note that `httpErrorFromResponse` already cut the snippet to 500, so a secret that crosses 500 can still leave a prefix. That is acceptable only if documented. Otherwise scrub in the client before HttpError is built, or also scrub every secret prefix of at least N characters at the end of the text.

### M2. `error.cause` keeps the unscrubbed HttpError
`new RunwayApiError(message, ..., { cause: error })` attaches the original HttpError. Its `message` and `snippet` hold the full secret (confirmed in the repro: `e.cause.message.includes(SECRET) === true`). Today cli.ts prints only `err.message`, so the CLI does not leak it. But `console.error(err)`, `util.inspect`, Node's default unhandled-rejection output, and any Worker or job wrapper that serializes the cause chain would leak it. Fix: when a secret is given and the snippet contains it, attach a scrubbed copy, for example `new HttpError(status, scrubbed, error.rawUrl, retryAfterMs)`, or drop the cause.

## Low

### L1. The credential test does not pin the new error
The regex in commands.test.ts, `/--image URL/`, matches every rejection in the loop. It does not assert "must not contain a username or password". It covers only `user:pass@`; the `user@` and `:pass@` forms are untested. The test fails without the fix only because the URL would otherwise be forwarded (`f.calls` would be non-empty, or the run would not reject). Suggest `toThrow(/username or password/)` plus a `user@` case.

### L2. The download test does not assert body cancel or the retry hint
The new test proves that nothing is saved (the out dir is never created, because `dest` throws before `mkdirSync`) and that the warning says "not media". It does not assert that the response body was cancelled, or that the aggregate error includes the `Retry while the output URLs are live ... --download` hint the issue requires. The code path is correct: http-client.ts:155-160 cancels the body and rethrows before any `.part` file exists, and task-flow.ts:108 supplies the hint. The test just does not lock that behaviour in.

### L3. The non-media list is narrow (matches the issue scope)
`application/problem+xml` and `application/vnd.*+json` error bodies are not refused. This is not a blocker, because the issue lists the exact types.

## Verified correct
- `application/octet-stream` and `binary/octet-stream` are not matched by `NON_MEDIA_TYPE_RE` (the `application/(...)$` group is anchored, and `binary/` is not `text/`). A missing content-type passes. Parameters and case are normalised (`split(";")[0].trim().toLowerCase()`).
- Refusal path: `dest` throws, then http-client.ts:158-160 runs `body.cancel()` and rethrows. No mkdir, no `.part` file. The error becomes the per-output `warn("Download failed for output N: output is text/html, not media ...")`, and the aggregate ProviderError carries the retryHint.
- Credential check: placed after the scheme check and before the host checks, so no request is made. The message does not echo the URL or its credentials.
- All 7 `mapRunwayError` call sites pass `this.apiKey`. An empty secret is guarded (`secret ?`). The apiKey is trimmed in `requireRunwaySecret`, matching the value in the `Bearer` header.
- Runtime neutrality is kept. `mapRunwayError` stays backwards compatible (optional third parameter).

## Edge cases from scouting
- The PollTimeoutError path (H1) and the truncation boundary (M1) were both confirmed with an executable repro (bundle in the session scratchpad, no network, no code changes).
- The 2xx "Invalid JSON response: <text>" HttpError goes through mapRunwayError, so it is scrubbed (subject to M1).

## Recommended actions
1. H1: scrub the secret in the waitForTask timeout path, and add a test.
2. M1: scrub before truncating.
3. M2: attach a scrubbed cause.
4. L1/L2: tighten the test assertions.

## Metrics
- Type errors: 0. Lint issues: 0. Runway tests: 75 pass.

## Unresolved questions
- Does the worker job container run `multix runway` and persist stderr or serialized errors to R2 or MCP output? If it does, H1 and M2 have a wider reach than the local terminal.

## Resolution

- **H1, M1, M2: fixed at the source.** `RunwayClient.raw()` now passes every failure through `scrubSecret()`. When the error body contains the secret, it rebuilds the `HttpError` with the secret replaced by `[redacted]` and no original cause, before anything truncates, maps, polls or prints it. The per-call-site `secret` parameter on `mapRunwayError` was dropped as redundant. Regression tests cover:
  - the poll-timeout "Last error" message;
  - a secret straddling the 300-character cut;
  - the `cause` chain.

  Both new tests fail against the earlier scrub.
- **L1: fixed.** A dedicated test asserts `/username or password/` for the `user:pass@` and `user@` forms.
- **L2: no change.** The behaviour was confirmed correct in this review.
- **L3: no change.** It is outside the issue's scope.
