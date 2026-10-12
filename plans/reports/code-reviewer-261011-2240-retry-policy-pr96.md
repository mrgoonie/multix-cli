# Code review: PR #96, doc convert retries only transient errors (closes #89)

- Branch: `fix/doc-no-retry-config-errors`, head `57dfa96`, base `b0a9120`
- Worktree read: `D:\www\oss\multix-cli\.claude\worktrees\agent-a5781405a0d54b0eb`
- Compared with: PR #85 (`perf/gemini-stream-upload`, head `9fc5baf`, worktree `agent-aad04315057622195`) and PR #95 (smoke test timeouts)
- CI on the head: all 5 checks pass (Node 20 and 22 on ubuntu and windows, plus the docs site).
- Local run: not done. Bash returned no output in this session, so findings come from reading the source and the GitHub API.

## Scope

| File | Change |
|---|---|
| `src/commands/doc/convert.ts` | +3: `if (!isTransientHttpError(e)) break;` |
| `src/core/async-poll.ts` | +8/-3: 408 is now transient; doc comment |
| `src/providers/gemini/client.ts` | +18/-11: upload `fetch` rejection becomes `HttpError(0)` |
| `tests/unit/commands/doc-convert.test.ts` | +153 |
| `tests/unit/core/worker-safe-http.test.ts` | +7/-2 |
| `tests/smoke/cli.test.ts` | +1/-2: per-test 15 s timeout removed |
| `docs-site/.../reference/environment.md` (EN and VI) | +3/-2 each |

## Verdict

The change for #89 is correct on its own branch. The retry loop in `convert.ts:145-147` now stops on:

- `ConfigError` (missing key)
- `ValidationError`
- plain `Error`
- `ProviderError` (file processing FAILED or processing timeout)
- every 4xx except 408 and 429

It still retries:

- `HttpError(0)` from `fetchJson`: network failures, `TimeoutError` and body-read failures
- `HttpError(0)` from the newly wrapped upload `fetch`
- 408
- 5xx

The 429 handling and the 400/403 `RESOURCE_EXHAUSTED` handling are unchanged: `isGeminiRateLimitError` is checked first and breaks after key rotation. The PR has no Critical defects.

The main risk is a semantic conflict with PR #85, which needs explicit resolution instructions (see High). The other findings are a few classification edge cases and stale comments and docs about 408.

## Critical

None.

## High

### H1. Semantic and textual conflict with PR #85: upload network failures would silently stop being retried

**Where:**
- PR #96 `src/providers/gemini/client.ts:109-127`: wraps the single upload `fetch` and throws `new HttpError(0, "File upload failed: …", FILES_BASE)`.
- PR #85 `src/providers/gemini/client.ts:125-150`: replaces that block with a new helper, `uploadFetch()`, used for both resumable steps (`start`, then `upload, finalize`). On a transport failure it throws `new ProviderError("File upload failed: <reason>", "gemini", { cause: err })`.
- PR #85 `tests/unit/providers/gemini/upload.test.ts:223-235` asserts `toBeInstanceOf(ProviderError)` and that `cause` is kept.

**Failure scenario:** `isTransientHttpError` returns false for `ProviderError`. Suppose the second PR to merge resolves the `client.ts` conflict by keeping #85's `uploadFetch` unchanged, which is the natural choice because #85 rewrites the whole function. Then a dropped connection or timeout during a >20 MB upload in `doc convert` fails on the first attempt.

Before #96, the blanket retry covered this case, so the result is a regression in exactly the area #96 meant to preserve. #96's test `doc-convert.test.ts:333` ("retries an upload that fails at the network layer") would catch it. However, that test must be rewritten for the resumable protocol anyway, because its mock returns no `x-goog-upload-url` header. A resolver who "just fixes the mock" could easily drop the retry assertion.

**Expected conflicts:**
- **`client.ts` (certain):** both PRs edit the same `fetch` block in `uploadFileWithKey`.
- **`tests/unit/commands/doc-convert.test.ts` (likely):** #85 edits the `stdin larger than 20 MB` describe block (lines 173-224 on #85), and #96 inserts a new test into the same block (lines 333-366).
- **No overlap:** `errors.ts`, `limits.ts`, `stdin-file.ts`, `key-pool.test.ts`, `upload.test.ts` and `gemini.md` are touched only by #85. `async-poll.ts`, `convert.ts` and `environment.md` are touched only by #96.

**What the second PR to merge must do** (the work is the same whichever PR lands first):

1. **Keep #85's `uploadFetch` as the only wrapper.** Do not keep #96's separate try/catch around `globalThis.fetch` as well, and do not add a second try/catch around the `uploadFetch` call sites. Either one would double-wrap the error (`HttpError(0, "File upload failed: File upload failed: …")`) or lose `redirect: "error"` and #85's reason formatting.
2. **In the `uploadFetch` catch, throw `HttpError` with status 0 instead of `ProviderError`.** Keep #85's `reason` string and keep `FILES_BASE` as the URL, never the session `uploadUrl`, which grants upload access by itself. For example: `throw new HttpError(0, \`File upload failed: ${reason}\`, FILES_BASE)`.
   - To keep the `cause`, extend the `HttpError` constructor with an optional trailing `options?: ErrorOptions` and pass it to `super`. #85 already threads `ErrorOptions` through `MultixError` and `ProviderError` in `errors.ts`, so it is a one-line addition.
   - Do not teach `isTransientHttpError` to accept `ProviderError`. Other `ProviderError`s, such as "no upload URL", "File processing failed" and "Processing timeout", must stay non-transient.
3. **Optional refinement.** A refused redirect (`cause.message === "unexpected redirect"`) is deterministic. Mapping it to a non-transient `ProviderError` avoids two wasted re-uploads; every other transport failure maps to `HttpError(0)`.
4. **Update #85's `upload.test.ts:223-235`.** Expect an `HttpError` with `status === 0`, `isTransientHttpError(err) === true`, the same message suffix, and (if step 2 adds options) `err.cause === failure`.
5. **Port #96's `doc-convert.test.ts` upload-retry test to the resumable mock.**
   - The start request returns `headers: { "x-goog-upload-url": … }`.
   - Make the first session `upload, finalize` request (URL contains `upload_id=`) throw `new TypeError("fetch failed")`.
   - Assert two `start` calls and two session uploads (the whole session restarts), the final `# Up` output, and no `process.exit(1)`.
   - Also cover a `start`-step network failure, because #85 has two network calls where #96 had one.
6. **Run `npm test` after resolving.** Both `upload.test.ts` and `doc-convert.test.ts` must pass. Do not delete either test to make the merge green.

## Medium

### M1. Status 0 lumps deterministic `TypeError`s together with network failures, so some config errors are still retried

**Where:** `client.ts:123-126` (new in this PR) and the existing `fetch-json.ts:82-84`.

**Failure scenario:** `fetch` also rejects with a `TypeError` for local, non-network faults:
- a header value that is not a valid ByteString, such as a pasted API key containing a smart quote or non-Latin-1 character (`listGeminiKeys` only trims);
- an invalid URL;
- `redirect: "error"` after #85.

All of these become `HttpError(0)`, so `doc convert` makes 3 attempts with 1 s and 2 s of backoff. That costs 3 s, and for >20 MB inputs it also means repeated `fs.readFileSync` of the whole file. This partly contradicts the PR's claim that "Config … errors fail on the first attempt", and it is the same class of bug as #89.

**Fix:** This is not a blocker for #96, because the classification in `fetchJson` predates it. Open a follow-up issue to treat a rejection as status 0 only when it is a `TimeoutError` or `AbortError`, or a `TypeError` whose `cause` carries an undici or system network code (`UND_ERR_*`, `ECONNRESET`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ETIMEDOUT`, `EPIPE`, `UND_ERR_SOCKET`). Any other rejection would become a non-transient error with the cause attached.

### M2. After #85 lands, retrying a status-0 upload timeout multiplies the worst-case runtime

**Where:**
- `convert.ts:110-153`: 3 attempts.
- PR #85 `uploadTimeoutMs()`: about 35 minutes for a 2 GB file.

**Failure scenario:** A slow link times out uploading a large file. #96 classifies the `TimeoutError` as transient, so `doc convert` restarts the full resumable upload twice more. That is up to about 105 minutes of upload, plus backoff, for one file. Before #96 the blanket loop did the same, so this is not a regression. But #96 is the change that makes "timeouts are transient" explicit, and #85 is the change that makes timeouts long.

**Fix (whoever merges second):** In `convert.ts`, consider not retrying a status-0 error whose message says the upload timed out. Alternatively, retry upload timeouts at most once. Document whichever choice is made.

### M3. Smoke-test conflict with PR #95

**Where:** `tests/smoke/cli.test.ts:247-248`.
- #96 deletes the `{ timeout: 15_000 }` option and the comment "the retry backoff adds ~3 s".
- #95 changes the same line to `{ timeout: 2 * SPAWN_TIMEOUT }`, keeps that comment, and adds a describe-level `SPAWN_TIMEOUT` (15 s) for slow `node` cold starts on Windows.

**Failure scenario:** This is a textual conflict.
- If the resolver keeps #95's line, the stale backoff comment and the doubled timeout stay, hiding any regression back to slow failure.
- If #96 lands alone, the test uses vitest's 5 s default for spawning `node`, which #95 identified as flaky under parallel load on Windows. CI passed on `windows-latest` for this head, so the risk is flakiness, not a failure.

**Fix:**
- If #95 merges first, #96 drops the per-test override and the backoff comment and relies on #95's describe-level `SPAWN_TIMEOUT`.
- If #96 merges first, #95 should not reintroduce `2 * SPAWN_TIMEOUT` or the backoff comment for this test.

## Low

### L1. The 408 change reaches more callers than the PR describes, and their comments and docs are now stale

Because `isTransientHttpError` is the `pollUntil` default, the 408 change affects:
- `src/providers/replicate/client.ts:288`
- `src/providers/atlascloud/client.ts:216`
- HeyGen `waitForJob` (`src/providers/heygen/jobs.ts:298`, which uses the default)

All three call it only on idempotent status GETs, so retrying 408 there is safe and correct. No behaviour concern.

These places still say "network/429/5xx":
- `replicate/client.ts:266`
- `atlascloud/client.ts:203`
- `docs-site/src/content/docs/commands/replicate.md:108`
- `docs-site/src/content/docs/commands/atlascloud.md:168` (and its VI counterparts)

The PR body says the pollers are "unchanged", but they now retry 408.

**Fix:** Add "408" to these comments and docs, or drop the status list and link to the environment reference.

### L2. The upload wrapper drops the network cause from the message

**Where:** `client.ts:123-126`.

`TypeError("fetch failed")` hides the actual reason in `cause` (for example `ECONNRESET` or `UND_ERR_SOCKET`), so users only see `File upload failed: fetch failed`. #85 already formats `${e.message}: ${e.cause.message}`. This goes away if H1 is resolved as described.

### L3. The missing-key unit test depends on the developer's environment

**Where:** `doc-convert.test.ts:139-159`.

The test stubs only `GEMINI_API_KEY=""`. If the developer's shell exports `GEMINI_API_KEY_2` (or any numbered key), `listGeminiKeys` finds it. `fetchSpy` is then called, and the "fetch not called" assertion fails. No paid call happens, because the spy returns `undefined`. CI is unaffected.

**Fix:** In the test's `beforeEach`, stub every `GEMINI_API_KEY_\d+` present in `process.env` to `""`. The smoke tests already avoid this with `extendEnv: false`.

### L4. Test gaps

- There is no `doc convert` test for 408. The behaviour is covered only by the unit test of the classifier.
- There is no test that `ProviderError` from the processing poll (`client.ts:150-153`) is not retried, even though this behaviour changed: it was retried 3 times before.
- The fake-timer pattern is sound. Only `setTimeout` is faked, and `AbortSignal.timeout` uses Node's internal timers, so it is unaffected. Every input path before the first backoff is synchronous `fs` or in-memory streams, so `runAllTimersAsync` cannot finish before the sleep is scheduled. All `fetch` calls are stubbed, so no paid API calls are made.

### L5. 501 and 505 are classified as transient (`status >= 500`)

This predates the PR and does not need action now. Note it if M1's follow-up revisits the classifier.

## Checks against the brief

- **AbortError and TimeoutError:** `AbortSignal.timeout` rejects with a `TimeoutError` DOMException. Both `fetchJson` and the new upload wrapper turn it into status 0, which is transient. Doc convert passes no user `AbortSignal`, so `AbortError` does not occur here.
- **`fetch` `TypeError` and undici codes:** all become status 0 and are retried, including deterministic ones (M1).
- **`HttpError` status:** 0, 408, 429 and 5xx are retried. 429 and 400/403 with `RESOURCE_EXHAUSTED` break first, after `withGeminiKey` rotation. Other 4xx fail at once. Invalid JSON on a 200 is `HttpError(200)`, so it now fails at once instead of being retried 3 times. That is acceptable.
- **Key rotation:** unchanged.
  - `key-pool.ts:53-59` rotates only on 429 and on 400/403 with `RESOURCE_EXHAUSTED`.
  - 401 and plain 403 were never rotated, before or after this PR, so the brief's "rotation preserved for 401/403" does not apply.
  - The real behaviour: with an invalid `GEMINI_API_KEY` and a valid `GEMINI_API_KEY_2`, the run fails on a 401 without trying key 2. That matches the documented "Other errors are not rotated" and is not a regression. Before this PR it retried the same bad key 3 times.
- **Docs:** EN `reference/environment.md:51-53` and VI `vi/reference/environment.md:50-52` are accurate and consistent with the code. Only the stale 408 mentions remain (L1).
- **Secrets:** none leak. The key travels in a header, the `HttpError` URL is the fixed `FILES_BASE`, and `labelError` adds only the input label.

## Recommended actions

1. Before the second of #85 and #96 merges, apply H1 steps 1-6 exactly. Prefer adding `ErrorOptions` to `HttpError` so the cause survives.
2. Resolve the smoke test with #95 as described in M3.
3. Fix the 408 wording in the Replicate and Atlas comments and docs (L1).
4. Open follow-up issues for M1 (narrow status-0 classification) and M2 (cap retries of long upload timeouts), as AGENTS.md requires.
5. Optional: isolate numbered Gemini keys in the unit tests (L3) and add a `doc convert` test for 408 and for processing-time `ProviderError` (L4).

## Unresolved questions

- Should a deterministic redirect refusal (after #85) be non-transient? This is a product choice; it is cheap to retry, but wasteful for 2 GB files.
- What merge order do the maintainers intend for #85 and #96? The instructions in H1 are symmetric, but the test rewrite in step 5 is smaller if #85 lands first.

Status: DONE_WITH_CONCERNS
Summary: Approve #96 on its own: the #89 fix is correct, key rotation is unchanged, and the 408 change is safe for the idempotent poll GETs. It needs explicit coordination with #85 (upload errors must remain `HttpError(0)`) and #95 (smoke timeout). Critical 0, High 1, Medium 3, Low 5.
