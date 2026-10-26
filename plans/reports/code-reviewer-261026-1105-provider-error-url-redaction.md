# Code review: commit 792919d, fix(core): redact URL query strings in provider error messages (Closes #340)

Reviewer: isolated (did not write the code). Date 2026-10-26. Head `792919d` (single commit, 11 files, +147/-22). No REVIEW.md in the repo; AGENTS.md applied.

## Scope
- `src/core/redact.ts`: new `redactUrlsInText` (the private `scrub` from `fetch-error.ts`, with `\` added to the stop set).
- `src/core/errors.ts`: `HttpError` redacts `snippet` and its message.
- `src/core/error-classify.ts`: `build()` redacts every message (envelope, text-mode stderr line, ledger).
- `src/agent/agent-runtime.ts`: envelope `log` tail redacted.
- `src/core/fetch-error.ts`: uses the shared helper.
- Tests: redact/HttpError unit tests, classifier test, OpenRouter transcribe test, agent-mode smoke test (local HTTP server, envelope and ledger). Docs EN+VI (`for-ai-agents.md`).

## Verification
- `npx vitest run tests/unit/core tests/unit/providers`: 82 files passed, 8 skipped (1453 passed, 22 skipped).
- `npx vitest run tests/smoke/agent-mode.test.ts` (dist already built and contains the change): 9 passed.
- `npm run typecheck`: clean. `npx biome check src tests`: clean (390 files).
- Runtime neutrality: `redact.ts` has no imports. `errors.ts` imports only `redact.ts`. `error-classify.ts` imports only `errors.ts`/`redact.ts`. `redact.ts` and `errors.ts` are in `WORKER_SAFE_MODULES`, and that test passes. `check:mcp` was not run (no worker-facing signature change).
- Ledger: `appendHistory` stores `info.message.slice(0, 500)`, so it is redacted before truncation. Correct.
- Probe of `redactUrlsInText` (a copy of the function run under plain node, inputs below). JSON stayed parseable in every JSON case.

| Input | Output | Verdict |
|---|---|---|
| `{"error":"failed https://cdn.x/a.wav?X-Amz-Algorithm=A&X-Amz-Signature=SECRET"}` (Go `encoding/json` default) | `…a.wav?[redacted]&X-Amz-Signature=SECRET"` | **leak** |
| `{"error":"failed https:\/\/cdn.x\/a.wav?X-Amz-Credential=AK\/2026\/us\/s3&X-Amz-Signature=SECRET"}` (PHP/escaped slashes) | `…a.wav?[redacted]\/2026\/us\/s3&X-Amz-Signature=SECRET"` | **leak** |
| nested `\"https://x/a?sig=SECRET\"` in a JSON string | `?[redacted]\"` | ok, parseable |
| `HTTP 400 from https://api.x/v1?[redacted]: x` | `HTTP 400 from https://api.x/v1?[redacted] x` | `:` eaten, not idempotent |
| `url=https://x/a?sig=SECRET&next=1, other text` | `url=https://x/a?[redacted] other text` | trailing `,` eaten (cosmetic) |
| `see https://x.test/{id}/a` | `see https://x.test/%7Bid%7D/a` | path re-encoded (cosmetic) |
| `Unsupported scheme gs://bucket/a.mp3 (use https)` | `Unsupported scheme gs:[redacted] (use https)` | whole URL lost, no query present |
| `cannot open file:///Users/me/a.wav` | `cannot open file:[redacted]` | whole path lost |

## Snippet consumers (`grep '\.snippet' src/`)
- `atlascloud/client.ts terminalPredictionFromError`: `JSON.parse` on the snippet and the fallback `"data"`/`"status"`/`"error"` regexes still work. URLs sit inside JSON strings, the replacement stops at `"` and `\`, and the probe confirms the Atlas failed-envelope stays parseable. Only change: `data.error` now carries `?[redacted]`, which is intended.
- `gemini/key-pool.ts` (`RESOURCE_EXHAUSTED`, `"retryDelay": "Ns"`) and `gemini/omni-flow.ts` (`"message"` extraction): no URL involved, unaffected.
- `runway/client.ts scrubSecret`: runs on the already redacted snippet. If the secret was echoed in a URL query it is gone already and `includes(secret)` is false (fine). A secret outside a URL is still split out. Rebuilding `HttpError` re-redacts the snippet, which is stable because the first pass already consumed the trailing characters. `errorDetail` JSON parsing is unaffected.
- `heygen/heygen-errors.ts parseHeygenErrorBody` (JSON then field regex) and `toHeygenApiError` (passes `error.snippet` back into a new `HttpError`, so a second redaction): unaffected.
- `cloudflare/video-client.ts`, `fal/run-helpers.ts`, `replicate/*`, `openrouter/*`, `check-helpers/gemini-ping.ts`, `codeFromHttp(status, snippet)`: string use only. The body keyword refinements (quota, etc.) are not inside URL queries. Unaffected.
- Public contract: `snippet` changes from a constructor parameter property to a declared readonly field with the same type and the same enumerability. There is no API break.

## Findings

### Blocking
1. **Signature still leaks when the provider's JSON escapes `&` as `&` or `/` as `\/`.** Adding `\\` to the stop set (needed to keep `\"` intact) makes `URL_IN_TEXT` stop at the first JSON escape. `QUERY_TAIL` only starts at `?`/`#`, so the rest of the query survives. On an S3/GCS pre-signed URL the signature is the *last* parameter (`X-Amz-Algorithm=…&…&X-Amz-Signature=…`, `X-Goog-Signature`), so the credential that #340 is about is exactly the part left in `HttpError.snippet`/`message`, the envelope `error.message`, the ledger and the `log` tail. Go's `encoding/json` escapes `&` as `&` by default (`SetEscapeHTML(true)`), and PHP `json_encode` escapes `/`, so this is a realistic provider body, not a theoretical one. The tests only use single-parameter queries (`?sig=…`, `?X-Amz-Signature=…`) and unescaped JSON, so they do not catch it.
   Fix: after the two passes, swallow the remainder of a redacted query up to a real terminator, treating JSON escapes as part of it. For example:
   ```ts
   const REDACTED_TAIL = /\?\[redacted\](?:\\u0026|\\\/|[^\s"'<>\\])+/g; // keeps \" and \n intact
   return text.replace(URL_IN_TEXT, redactUrl).replace(QUERY_TAIL, "?[redacted]").replace(REDACTED_TAIL, "?[redacted]");
   ```
   (or allow `\\u0026` and `\\/` inside `URL_IN_TEXT` and cut at the first `?`/`#` instead of calling `new URL`). Add tests with a multi-parameter S3 URL in a `&`-escaped body and a `\/`-escaped body, asserting `JSON.parse` still works.

### Non-blocking
2. **`build()` re-redaction eats the `:` in every `HttpError` message whose request URL had a query.** `HttpError.message` is `HTTP 400 from https://host/path?[redacted]: <snippet>`. `URL_IN_TEXT` matches `…?[redacted]:` and `redactUrl` reparses it, dropping the colon. The envelope then shows `…?[redacted] {"error":…}`, which reads worse and undercuts the docstring's "Idempotent" claim. The idempotency test uses an input with nothing after the URL. Fix: exclude `[redacted]` sequences from `URL_IN_TEXT` (for example stop the URL match at `?[redacted]`), or make `build()` skip already-redacted `HttpError` messages. Add an idempotency test on a real `HttpError.message`.
3. **Trailing punctuation and path normalisation.** A query match swallows `,`, `)`, `.` that end a sentence (`…?sig=S, retry` becomes `…?[redacted] retry`). `new URL` re-encodes `{`/`}`/`|` in paths, and this now runs on every classified message, not only fetch failures. The change is cosmetic, but agents read `error.message`. Consider trimming `[),.;:]+$` off the match before `redactUrl` and appending it back.
4. **Non-special schemes collapse completely, even without a query.** `gs://bucket/a.mp3` becomes `gs:[redacted]` and `file:///…/a.wav` becomes `file:[redacted]`. Previously this happened only in network-failure text. Now it also hits `ValidationError`/`ConfigError` messages that name a user-supplied `gs://`, `s3://` or `file://` input, so useful diagnostics are lost. This is `redactUrl`'s documented behaviour for opaque origins, so it is not a regression of `redactUrl` itself, but its blast radius widened. Consider redacting only `?…`/`#…` for opaque URLs in free text.
5. **Terminal stderr is only partly covered.** The commit message says stderr is covered. Top-level errors print `info.message` (redacted). Command-local catches that call `logger.error(e.message)` and then `process.exit` (for example `minimax/commands/image-to-image.ts:104`, `commands/update.ts:86`, `fal/commands/*`) write raw text to the real stderr. For `HttpError` the message is already safe. For a `ProviderError` built from provider text (as in the new classifier test case) the terminal line is not redacted, though the envelope `log` and the ledger are. Either soften the claim or route `logger.error` through `redactUrlsInText`. Low impact: the user supplied the URL themselves, and the persisted copies are clean.
6. **Fetch-error behaviour changed silently.** The old `scrub` did not stop at `\`. Node fetch/undici messages practically never contain backslashes (except Windows paths in `file:` URLs, which collapse anyway), so the risk is low. Note it in the commit or test it.

### Positive (risk calibration)
- The redaction runs once at construction, so every downstream consumer (`mapRunwayError`, Heygen, Atlas) gets a safe snippet without per-provider changes. `rawUrl` remains the only unredacted field and is non-enumerable.
- The smoke test covers stdout, stderr, envelope and ledger end to end against a local server, with no paid API.

## Recommended actions
1. Fix finding 1 (escaped-JSON continuation) and add the two regression tests before merging. This is the acceptance criterion of #340.
2. Fix finding 2 and add an idempotency test on a real `HttpError.message`.
3. Optionally fix 3 and 4, or open a follow-up issue.
4. Soften the stderr claim in the commit/PR text or cover `logger.error` (finding 5).

## Unresolved questions
- Should free-text redaction keep the path of opaque-scheme URLs (`gs://`, `s3://`) that carry no query? This is a product call: the path can itself be sensitive (bucket and object names).

## Resolution (author, after review)
- Finding 1 (blocking): fixed. A third pass (`ESCAPED_REST`) swallows the rest of a redacted query that a JSON encoder cut at `&` or `\/`, stopping before `\"` so the body stays parseable. Tests cover Go-style and PHP-style bodies, `JSON.parse` and idempotency.
- Finding 2: fixed. A URL match that already carries `?[redacted]` is left as is, so `…?[redacted]: body` keeps its colon; tested.
- Finding 5: fixed. `logger.warn` and `logger.error` redact URL query strings, so stderr lines printed by commands that catch and log are covered; tested.
- Findings 3, 4, 6: kept as is. Swallowed trailing punctuation only follows an already redacted query; collapsing opaque-scheme URLs (`gs:`, `file:`) whole is the existing `redactUrl` policy and the safer default (bucket and object names can be sensitive); the backslash stop only makes the fetch-error scrub stricter about where a URL ends while the tail pass still redacts the query.
