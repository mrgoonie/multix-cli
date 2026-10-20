# Code review: d24eb3c, Omni inline-body cap and --wait-timeout deadline (#256)

Reviewer: isolated code-reviewer (did not write the change). Scope: `git show HEAD`.

## Scope
- Source: src/core/fetch-json.ts, src/core/errors.ts, src/providers/gemini/client.ts,
  src/providers/gemini/omni-flow.ts, src/providers/gemini/commands/video-shared.ts
- Tests: tests/unit/core/worker-safe-http.test.ts, tests/unit/providers/gemini/omni-flow.test.ts
- Docs: docs-site gemini.md (en, vi), skill/SKILL.md, worker/src/cli-catalog.json
- Checked against: redirect-fetch.ts, fetch-error.ts, async-poll.ts, key-pool.ts (withGeminiKey),
  commands/video-status.ts, http-client.ts (maxDownloadBytes)

## Verification run
- `npm run typecheck`: clean. `npm run lint`: clean (456 files).
- `npx vitest run tests/unit/core/worker-safe-http.test.ts tests/unit/providers/gemini`: 13 files, 288 tests pass.
- `npm run check:mcp`: worker typecheck/tests pass, bundle check clean (no node:* in fetch-json/errors).
- Empirical: Node v22.22.0 `buffer.constants.MAX_STRING_LENGTH` = 536,870,888;
  `Array(9).fill("a".repeat(64MiB)).join("")` throws `RangeError: Invalid string length`.

## What is correct
- Other fetchJson callers: unchanged behaviour. Without `responseTimeoutMs` the signal is the same
  `AbortSignal.timeout(timeoutMs)`; without `maxBytes` the body is `response.text()` as before.
- Header timer is cleared in `finally` around `fetchFollowingRedirects` on success and on throw; the
  same signal spans every redirect hop, so the header limit is cumulative across hops (correct).
- Header-timeout abort reason is a `DOMException("TimeoutError")`; `toFetchError` maps it to
  `HttpError(0)` (transient), so a poll whose headers never arrive is retried. An overall abort during
  the body becomes `HttpError(0, "Failed to read response body")`, also transient, and only fires at
  the poll deadline, so no re-download loop on the happy path.
- `ResponseTooLargeError` is not an `HttpError`: `isTransientHttpError` and `isGeminiRateLimitError`
  both reject it, so it is neither polled again nor key-rotated on submit. Message and `url` are redacted.
- Submit: the "deadline expired" check runs after uploads and before `createInteraction`, so an expired
  deadline never sends the POST; the thrown ProviderError is not a 429 so `withGeminiKey` does not rotate.
- Runtime neutrality: fetch-json.ts/errors.ts use only `AbortController`, `AbortSignal.timeout`,
  `DOMException`, `TextDecoder`, `ReadableStream.getReader`, `setTimeout` (all present in Workers);
  streaming `TextDecoder.decode(..., {stream:true})` + final flush handles split UTF-8 (tested).

## Blocking

### B1. Stored submit gets a shrunken timeout, so an accepted (billed) submit can be aborted and its id lost
- File: src/providers/gemini/omni-flow.ts:325
  `timeoutMs: store ? Math.min(SUBMIT_TIMEOUT_MS, remainingMs) : remainingMs`
- Before this change a stored submit always had 120 s; `--wait-timeout` only bounded polling. Now the
  submit's whole-request timeout is whatever is left after uploads.
- Failure scenario: `multix gemini video --video ./clip.mp4 --wait-timeout 60000` on a slow uplink; the
  upload takes 57 s, `remainingMs` is 3 s, the POST reaches Google and is accepted, the 200 arrives at
  3.5 s, the client has already aborted. Result: `HttpError(0)` -> "submit failed before a response
  arrived ... may already be billed", no interaction id, no session record, no resume path. Same with a
  user who deliberately passes a small `--wait-timeout` (e.g. 5000) intending to resume later with
  `video-status`: previously the submit succeeded and the poll timed out with a resume hint; now the
  submit itself can be cut. This trades a bounded wait for the one outcome the billing-safety design
  exists to avoid (billed job with no id).
- Fix: the deadline should only gate *whether* the stored submit starts, not how long it may take.
  Keep `timeoutMs: store ? SUBMIT_TIMEOUT_MS : remainingMs` (polling already gets `max(1, deadline-now)`
  and fails with a resume hint). Alternatively refuse to submit when `remainingMs < SUBMIT_TIMEOUT_MS`
  for stored requests. Add a test: upload advances the clock to leave 1 s, submit resolves after 2 s of
  fake time, assert the interaction id is recorded. Document that the submit may overrun the deadline
  by up to 120 s. (For `--no-store` a deadline-bound submit is inherent; but consider the same
  minimum-remaining refusal there, since an aborted sync request is billed with nothing saved.)

### B2. With the default MULTIX_MAX_DOWNLOAD_MB the cap is above V8's max string length; an oversized body falls back into the retry loop the fix is meant to remove
- Files: src/providers/gemini/omni-flow.ts:76-78 (`interactionMaxBytes`), src/core/fetch-json.ts:196
  (`parts.join("")`) and :128-131 (catch maps everything except ResponseTooLargeError to `HttpError(0)`).
- Default `MULTIX_MAX_DOWNLOAD_MB` is 2048 (src/core/http-client.ts:41), so `interactionMaxBytes()` is
  ceil(2 GiB/3)*4 + 64 MiB ~= 2.93e9 bytes. A JS string tops out at 536,870,888 chars (verified on
  Node 22). Any inline body between ~512 MiB and ~2.7 GiB passes the byte cap, then `parts.join`
  throws `RangeError: Invalid string length` (or the process hits the heap limit holding ~GBs of
  part strings). The RangeError is wrapped as `HttpError(0, "Failed to read response body")`, which
  `isTransientHttpError` retries, so `waitForInteraction` downloads the same huge terminal body on
  every poll until PollTimeoutError: exactly the #256 symptom, and the docs claim ("fails at once")
  is false for the default config. `JSON.parse` + `Buffer.from(base64)` on a body near the limit also
  triples peak memory.
- Realism: current Omni clips (<= 40 s 720p) are far below 384 MB decoded, so this is latent today,
  but the cap is advertised as the guard and is effectively never the binding limit at defaults.
- Fix (either or both):
  1. Clamp in `interactionMaxBytes()`: `Math.min(computed, MAX_INTERACTION_TEXT_BYTES)` with a constant
     comfortably under the string limit (e.g. 384 MiB, leaving room for UTF-16 expansion is not needed
     since JSON/base64 is ASCII, but keep headroom for JSON.parse), and say in docs that inline videos
     are limited to min(MULTIX_MAX_DOWNLOAD_MB, ~288 MB decoded).
  2. In `readText`, treat a `RangeError` from decode/join as `ResponseTooLargeError` (non-retryable)
     rather than letting the generic catch turn it into a transient `HttpError(0)`.
  Add a unit test for the clamp (MULTIX_MAX_DOWNLOAD_MB=2048 -> cap <= string limit).

## Optional

### O1. A stalled small body on a non-terminal poll now blocks for the whole remaining wait
- File: src/providers/gemini/omni-flow.ts:84-90, :448
- `interactionReadLimits(remainingMs)` gives every poll a whole-request limit of `remainingMs` (up to
  15 min) and only a 60 s header limit. Previously each poll was capped at 60 s. A TCP stall after the
  headers of an ordinary `in_progress` poll (a few hundred bytes) now consumes the entire wait and ends
  in PollTimeoutError instead of retrying after 60 s.
- Fix: add an idle (inter-chunk) timeout in `readText` (reset a timer on every `reader.read()` chunk,
  e.g. 60 s), which still lets a large body stream for as long as it keeps moving. That is the property
  the change actually wants ("slow but progressing body is not cut off").

### O2. `overall` abort listener is never removed
- File: src/core/fetch-json.ts:160
- After a successful request the `onOverall` listener (closure over the controller) stays on the
  `AbortSignal.timeout` signal until it fires (up to 15 min). Not a correctness bug (the timer is
  unref'd in Node, GC-able in Workers), but every poll leaves one; remove it after the body has been
  read (return a `done()` that clears both the timer and the listener, call it in a `finally` around
  `readText`).

### O3. Parent lookup failures are reported as a possibly-billed submit, and now more often
- File: src/providers/gemini/omni-flow.ts:335-337, :350
- `findInteractionKey` for `--interaction-id` runs inside the submit `try`, so a read-only GET that
  times out becomes `submitError(HttpError(0))` -> "may already be generating and billed". Pre-existing,
  but the new `Math.max(1, deadline - Date.now())` timeout makes it likelier (small `--wait-timeout`).
  An oversized parent likewise yields "Raise MULTIX_MAX_DOWNLOAD_MB and resume with: video-status
  <parent> --download", which tells the user to download the parent instead of explaining the edit was
  not submitted. Also, the parent lookup downloads the parent's whole inline video just to read
  `status`.
- Fix: move the parent lookup out of the submit `try` (or wrap it with its own error mapping that says
  nothing was submitted); keep the cap but use a parent-specific message.

### O4. Oversized stored submit loses the id it may contain
- File: src/providers/gemini/omni-flow.ts:326, :350
- A stored submit capped by `maxBytes` that does contain an id is reported as "may be billed" with no
  id. Unlikely (stored submits return `in_progress`), so documenting is enough; dropping `maxBytes` on
  the stored submit is not advised either. No action required beyond awareness.

### O5. video-status / video-cancel lookups use a 10-minute body budget unrelated to --wait-timeout
- File: src/providers/gemini/omni-flow.ts:215
- Default `timeoutMs = DOWNLOAD_TIMEOUT_MS` (previously fetchJson's 120 s) applies to `video-cancel`
  too, where an inline body is irrelevant. Acceptable, but consider documenting it next to
  `video-status --wait-timeout` ("Polling timeout").

### O6. Non-2xx bodies are still read unbounded
- File: src/core/fetch-json.ts:120-122 (`httpErrorFromResponse` uses `response.text()`)
- With `maxBytes` set, an error body is still read whole and, after headers, may take the full
  `remainingMs`. Low risk; could reuse `readText` with a small cap (e.g. 64 KiB) since only 500 chars
  are kept.

### O7. Test gaps
- No test that a stored submit near the deadline keeps enough time (would catch B1).
- No test of the cap at the default MULTIX_MAX_DOWNLOAD_MB vs the string limit (B2).
- No omni-flow-level test that a slow-but-progressing terminal poll body is read once (the second half
  of #256); the fetchJson unit test ("lets the body take the rest of timeoutMs") covers the primitive
  only with fake streams.
- No test that an overall-timeout abort during the body read yields a transient `HttpError(0)` (the
  classification the poll loop relies on).
- Tests that exist are behavioural (counts polls, asserts no submit, checks cancel was called); none
  are phantom.

## Edge cases scouted
- Redirect hops share one signal/header timer: fine. Cross-origin refusal unchanged.
- gzip: Content-Length is the encoded size; the streamed count is decoded bytes, so the precheck can
  only under-reject, never false-reject. Fine.
- `maxDownloadBytes()` throws ConfigError on a bad env value: on submit it throws before any request
  (safe); in polls it throws synchronously inside `fetchStatus` and is non-transient (fails once).
- `--no-wait` path: deadline only gates the submit; OK.
- Expired deadline after submit: poll gets `max(1, ...)` -> immediate abort -> PollTimeoutError with
  resume hint and record written. OK.

## Recommended actions
1. B1: restore the full 120 s timeout for stored submits (deadline gates start only); add test.
2. B2: clamp `interactionMaxBytes()` below the JS string limit and/or map RangeError to
   ResponseTooLargeError; fix docs wording; add test.
3. O1: idle timeout per chunk instead of whole-remaining-wait body limit.
4. O3: separate parent-lookup error mapping from submit error mapping.

## Unresolved questions
- Does Google ever send the inline video on a stored interaction's terminal GET in practice, and how
  large can Omni inline bodies get? That decides whether B2 is latent or reachable.

## Resolution (author, follow-up commit)

- B1 fixed: a stored submit always gets SUBMIT_TIMEOUT_MS; the deadline only decides whether it is
  sent. Test: upload leaves 5 ms, submit answers later and its signal is still live; the id is recorded
  and the poll timeout carries the resume hint (fails with the previous `Math.min`).
- B2 fixed: `interactionMaxBytes()` is clamped to `INTERACTION_MAX_BYTES_CEILING` (384 MiB), and a
  `RangeError` while reading a capped body becomes `ResponseTooLargeError` (not retried). Docs updated.
- O1 fixed: `fetchJson` gains `idleTimeoutMs`; Interaction reads drop a body with no data for 60 s
  (retryable `HttpError(0)`), while a moving body keeps the rest of the wait.
- O2 fixed: `requestSignal` returns `done()`, called after the body read, which removes the listener.
- O3 fixed: the parent lookup runs before the submit `try`, so its failures are never reported as a
  possibly billed submit.
- O7: added tests for B1, B2 (default cap), idle timeout, and an overall-timeout abort mid-body.
- O4, O5, O6: left as is (O4 unlikely and documented here; O5 acceptable; O6 low risk, out of scope).
