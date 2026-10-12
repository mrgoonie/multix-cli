# Code Review: PR #111, fetch error classification (#107)

- Branch `fix/core-fetch-error-classification`, head `0074b8f`. The worktree `agent-a66fd94cbce887a43` is confirmed at this SHA from its `logs/HEAD`.
- Reviewed with Read/Grep and the GitHub API, because Bash was unavailable. Nothing was executed locally.
- CI on `0074b8f` is all green: Node 20/22 on ubuntu and windows, MCP Worker, and the docs site.

## Scope
- 26 files: `src/core/fetch-error.ts` is new; also async-poll, errors, fetch-json, http-client, redirect-fetch; the atlascloud, elevenlabs, gemini, heygen, openai and replicate clients; 6 docs (EN and VI); and 8 test files.
- Scouting covered: the Worker bundle (`worker/src/**` imports the atlascloud, heygen and replicate clients plus `fetch-json` and `async-poll`), every retry consumer (`isTransientHttpError`, HeyGen `retryDelay`, fal `isTransientError`, `doc convert`), places where the CLI might print `cause` (none: no `.cause` or `.stack` printing in `src/`), and catch sites the PR did not convert.

## Overall
- The core idea is right, and it does what #107 asks for on Node/undici: a smart-quote key now gives one ConfigError instead of three "network" retries.
- The #101 refused-redirect rethrow is preserved: `validateUrl` runs outside the try block, and every caller has an `instanceof HttpError` pass-through.
- The #85 Gemini upload mapping is preserved.
- No key or query string leaks were found.
- The classifier is an **allowlist** of Node error codes. Anything without a Node/undici code is now treated as deterministic, so the change trades one bug for its mirror image on runtimes that don't produce those codes.

## Critical
None.

## High

**H1. Real network failures in the MCP Worker are no longer retried.**
- Location: `src/core/fetch-error.ts:51-56`. `isNetworkFetchFailure` requires `instanceof TypeError` plus a Node/undici `code` somewhere in the cause chain.
- workerd's `fetch` does not attach Node error codes. Its connection failures look like `Error`/`TypeError` "Network connection lost.", "internal error", and similar, sometimes with `retryable: true`.
- The Worker bundles `fetchJson`, i.e. `fetchFollowingRedirects({wrapNetworkErrors:true})` → `toFetchError`. That covers AtlasCloud, Replicate and HeyGen.
- So in the Worker, a transient transport failure now becomes a non-retryable `ProviderError`. This breaks:
  - `pollUntil` retries (atlascloud `client.ts:218`, replicate `client.ts:312`);
  - HeyGen keyed retries (`heygen/client.ts:218`, `:437`).
- One blip during a long Atlas or Replicate poll now fails the MCP tool call. Before this PR it was retried.
- The PR's own test pins this behaviour: `tests/unit/core/worker-safe-http.test.ts:348-359` asserts that a codeless `TypeError("fetch failed", {cause: Error("bad port")})` becomes ProviderError.
- There is no Worker test with a realistic workerd rejection (`worker/` has no TypeError or network-failure tests).
- Fix: invert to a **denylist** of known-deterministic shapes and keep everything else transient. Deterministic shapes:
  - `ERR_INVALID_URL` or a URL parse failure;
  - `ByteString` or invalid header value;
  - TLS certificate codes (`CERT_*`, `*_SELF_SIGNED_*`, `UNABLE_TO_*`, `ERR_TLS_CERT_ALTNAME_INVALID`, `DEPTH_ZERO_SELF_SIGNED_CERT`);
  - `duplex option is required`, "cannot have body", "unexpected redirect".

  Every other `TypeError`, timeout, abort, or error with `retryable === true` stays `HttpError(0)`. This fixes #107 without changing behaviour for runtimes the allowlist doesn't know about. Then flip the "bad port" test, and add a Worker-shaped case (`new Error("Network connection lost.")` and `new TypeError("Network connection lost.")`) that must stay transient.

## Medium

**M1. Gaps in the network code allowlist on Node 20/22.**
- Location: `fetch-error.ts:13-23`.
- Missing:
  - `ERR_SOCKET_CONNECTION_TIMEOUT` (Node's `autoSelectFamily` connect-attempt timeout, a common cause behind undici "fetch failed" on hosts with broken IPv6; please verify on Node 20/22);
  - `ENETDOWN`, `EHOSTDOWN`, `EADDRNOTAVAIL`, `EPROTO` (TLS handshake cut by middleboxes), `EAI_FAIL`.
- Each of these is now a non-retryable ProviderError.
- If H1 is fixed with a denylist, this goes away. Otherwise extend the set.
- In the other direction, the `UND_ERR_` prefix (`:29`) is too broad. It also matches deterministic undici errors (`UND_ERR_INVALID_ARG`, `UND_ERR_NOT_SUPPORTED`, `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`, `UND_ERR_RESPONSE_EXCEEDED_MAX_SIZE`), which will be retried. That is low impact.

**M2. The non-network ProviderError drops the only useful diagnostic.**
- Location: `fetch-error.ts:108-114`.
- It uses `safeMessage(err)` on the top-level error only. On Node that is always `"fetch failed"`.
- So a TLS failure (corporate MITM proxy, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_HAS_EXPIRED`) now reports `Request to https://api.replicate.com/v1/files failed: TypeError: fetch failed`, with no reason, and is not retried.
- Not retrying TLS certificate errors is correct, because they are deterministic. The message is not.
- The network branch already appends `chain[1]`. Do the same here using `safeMessage`: undici and OpenSSL cause messages carry hostnames and codes, not header values.
- Also drop the `TypeError: ` prefix from user-facing text.
- Update the pinned expectation at `worker-safe-http.test.ts:355-357`.

**M3. The PR claims "501/505 no longer retried", but only `isTransientHttpError` was changed.**
- These retry paths still retry 501/505:
  - HeyGen `retryDelay` (`src/providers/heygen/client.ts:218`, `status >= 500`);
  - fal `isTransientError` (`src/providers/fal/run-helpers.ts:36`).
- The docs edited in this PR are accurate for what they cover (Replicate, Atlas, `doc convert`; EN and VI match).
- But the PR body and commit read as a global policy. Either narrow the wording, or file a follow-up issue to align HeyGen and fal. Under AGENTS.md, a follow-up issue is preferred to widening this PR.

## Low

**L1. `AbortError` is always classified transient** (`fetch-error.ts:54`).
- This is harmless today: every converted site uses `AbortSignal.timeout` only, and there is no user `AbortController` (Ctrl+C kills the process).
- If a future caller passes a user cancellation signal, it would back off and retry an aborted request.
- Suggest treating only `TimeoutError` as transient, or documenting the assumption.

**L2. `safeMessage` URL scrubbing stops at whitespace** (`fetch-error.ts:62`, `\S+`).
- A message embedding a URL with a space before `?` would keep its query. The realistic producer ("Failed to parse URL from …") is routed to the ConfigError branch first, so no leak was found.
- The `\bURL\b` / `header` regexes (`:98`, `:101`) also scan text that, in the invalid-header case, includes the header value. That only affects which ConfigError text is chosen, never what gets echoed.

**L3. ConfigError text in Gemini `uploadFetch` names the wrong URL.**
- `uploadFetch` (`gemini/client.ts:183`) passes `FILES_BASE`, which is intentional so the session upload URL is never echoed.
- So `Invalid request URL: https://generativelanguage.googleapis.com/upload/v1beta/files` blames the wrong URL when the server-issued session URL is the bad one.
- The fallback path also loses the `File upload failed:` prefix.

**L4. Catch sites not converted (pre-existing, outside this diff).**
- `elevenlabs/client.ts:71` `apiDelete` propagates raw fetch rejections.
- Raw undici `Headers.append: "<value>" is an invalid header value.` messages echo the header value. This is only reachable with an embedded CR/LF/NUL in a key, because surrounding whitespace is trimmed.
- Suggest a follow-up issue, not this PR.

**L5. Replicate `withOrphanHint` drops `cause`** when it re-wraps a ProviderError (`replicate/client.ts:129-131`). Pre-existing, but this PR now routes more failures through that branch.

## Verified OK
- Smart-quote key (ByteString) → ConfigError. The message never echoes the value, and `cause` is kept. The CLI and Worker print only `.message` (`worker/src/mcp-server.ts:143`); no `.cause` or `.stack` printing exists in `src/`.
- Undici-coded failures (`ECONNRESET`, `UND_ERR_SOCKET`, `ENOTFOUND`, an AggregateError with `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`/`HEADERS_TIMEOUT`) → `HttpError(0)` with `fetch failed: <cause>`. Cause messages carry host and port only.
- `TimeoutError` (DOMException from `AbortSignal.timeout`) → `HttpError(0)`.
- A Gemini upload-step timeout and "unexpected redirect" still → ProviderError, not retried (#85).
- Replicate, HeyGen, Atlas, OpenAI and ElevenLabs all keep `instanceof HttpError` pass-through before `toFetchError` (redirect loop, refusal). `fetchSameOrigin` still rethrows raw errors, and callers wrap them.
- `fetchBytes` handles data URIs before fetch, so `redactUrl` never sees a huge data URI.
- `hasNetworkCause` / `causeChain` are depth-bounded (cycle-safe).
- EN and VI docs are consistent with each other and with `isTransientHttpError`.

## Recommended actions
1. Fix H1: switch to a denylist of deterministic shapes, add Worker-shaped tests, and flip the "bad port" expectation.
2. Fix M2: include the sanitized first cause in the ProviderError message.
3. Fix M1 if H1 keeps the allowlist.
4. M3: narrow the PR wording, or open a follow-up issue for the HeyGen and fal 501/505 behaviour.
5. Open follow-up issues for L4 and L1.

## Metrics
- CI: 6/6 green on `0074b8f`. The PR body reports 984 tests passed and 8 skipped (not re-run locally).
- Lint and typecheck: green in CI.
- There is no test coverage for non-Node (codeless) rejection shapes staying transient.

## Unresolved questions
- What does workerd actually throw for an unreachable public origin, and for a connection reset mid-request? The H1 severity assumes these are codeless errors rather than 52x Responses. A quick `wrangler dev` probe against a closed port would settle it.
- Is `ERR_SOCKET_CONNECTION_TIMEOUT` surfaced through the undici `fetch failed` cause on Node 20.x and 22.x? Likely, but not verified here.

Status: DONE_WITH_CONCERNS
Summary: Fix first. 0 critical, 1 high (Worker network failures now non-retryable), 3 medium, 5 low.
