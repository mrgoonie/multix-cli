# Code review: provider error URL redaction (commit 60bfc24, issue #340)

Branch `claude/gracious-heisenberg-ar96dy`, base `origin/dev`. Reviewer did not write the code. No REVIEW.md in the repo; AGENTS.md rules applied.

## Scope
- Files: src/core/redact.ts, src/core/errors.ts, src/core/error-classify.ts, src/core/index.ts, src/agent/fetch-telemetry.ts, docs-site for-ai-agents (EN/VI), 4 test files + 1 smoke fixture. ~158 added / 12 removed lines.
- Checks run: `npm run lint` clean, `npm run typecheck` clean, `npm run build` ok, full `npx vitest run` 1817 passed / 21 skipped, `npm run check:mcp` passes (bundle clean, no node:* added to src/core).
- Consumers of `.snippet` checked: atlascloud/client.ts:89, heygen/heygen-errors.ts:65-72, replicate/client.ts:83, runway/client.ts:98 and :134-135, gemini/key-pool.ts:57,65, gemini/omni-flow.ts:271, fal/run-helpers.ts:89, replicate/node-outputs.ts:175, cloudflare/video-client.ts:92, check-helpers/gemini-ping.ts:33-35, core/error-classify.ts:221.

## Overall
The design is sound: one runtime-neutral helper, applied at the error constructor, at `HttpError.snippet` and at `build()`, which covers the issue's three sinks (`error.message`, the stderr error line, history). It is idempotent (`?[redacted]` re-matches to itself), the regex parts before `?` cannot overlap, and the "stop at `"`" rule does keep ordinary JSON error bodies parseable. Tests do prove the stated behavior, including an end-to-end smoke test over all sinks. There are no blockers for the stated goal. The problems below are edge cases in the regex's terminator rules and some sinks the change does not cover.

## Critical
None.

## High

### H1. A JSON-escaped quote after the query breaks JSON snippets and changes provider error messages
`src/core/redact.ts:40`. The query class `[^\s#"<>\`]*` accepts a backslash, so for `\"` it consumes the `\` and stops at the `"`. The unescaped `"` that is left ends the JSON string early.
- Scenario: a provider wraps the echoed URL in quotes, as Go's `%q` and many Python and JS error formatters do: `{"detail":"failed to download \"https://b.s3.amazonaws.com/a.m4a?X-Amz-Signature=SIG\""}`. After redaction the snippet is `...a.m4a?[redacted]""}`, and `JSON.parse` throws (verified: "Expected ',' or '}' after property value").
- Impact: `errorDetail()` in replicate/client.ts:66-75 and runway/client.ts falls back to the raw snippet, so the user sees a raw JSON blob instead of `detail`. `parseHeygenErrorBody` (heygen-errors.ts:43-60) and `terminalPredictionFromError` (atlascloud/client.ts:88-106) fall back to field regexes that stop at the stray quote, so `message`/`error` is cut short. This does not leak anything, but it is a behavior regression that only shows up with real provider bodies. The commit message's claim that "raw JSON error bodies stay parseable" is false in this case.
- Same root cause, a leak: a query that contains an escaped quote (`?x=\"1\"&sig=SECRET`) is redacted only up to the quote, so `1\"&sig=SECRET` stays in the text (verified).
- Fix (verified locally against all four existing unit cases plus the Go-quoted case):
  ```ts
  const URL_QUERY = /(https?:(?:\\?\/){2}[^\s?#"<>`]{0,2048})\?(?:[^\s#"<>`\\]|\\[^\s"])*/gi;
  ```
  A backslash is consumed only together with a following non-quote character, so `&` and `\/` still match and `\"` ends the query intact. Add a unit test with a `%q`-style body that asserts `JSON.parse` succeeds and the signature is gone.

## Medium

### M1. The envelope `log[]` and text-mode stderr still carry raw lines that never pass through MultixError
`src/agent/agent-runtime.ts:281-288` (`log:` built from raw `run.stderr`) and `src/agent/agent-runtime.ts:128-131` (raw passthrough to the real stderr).
- Scenario: `byteplus video` reaches `logger.error(\`Task succeeded but no video_url in response: ${JSON.stringify(final)}\`)` (src/providers/byteplus/commands/video.ts:96; the same pattern is at image-to-video.ts:111, reference-to-video.ts:133, generate-3d.ts:102, leonardo/commands/video.ts:184, and minimax/generators/video.ts:68,87 through `logger.error(result.error)`). If the provider object contains a signed URL (for example a `last_frame_url`, or a status message that echoes the input), `error.message` comes back redacted via `classifyMessage(lastErrorLine)`, but `log[]` in the `--json` envelope and the terminal stderr show the raw line with the signature. The issue lists the envelope and stderr as sinks that must not leak.
- The smoke test passes only because the OpenRouter path's stderr lines come from an already-redacted `MultixError.message`.
- Fix: apply `redactUrlsInText` to each `log[]` line in `finalizeRun`, which is cheap and covers every command. Optionally also apply it in `logger.error`/`logger.warn` in src/core/logger.ts so terminal stderr is covered too. If that is out of scope, open a follow-up issue as AGENTS.md requires, and narrow the docs claim (L3).

### M2. Quadratic regex time on adversarial or very large text
`src/core/redact.ts:40`. The host/path class is unbounded and accepts `:` and `/`, so every `https://` start rescans to the end of the token. Measured: 50 KB of repeated `https://` takes 395 ms, and 200 KB takes 6.2 s of synchronous CPU.
- Exposure: `HttpError.snippet` is capped at 500 chars (fetch-json.ts:13), but `MultixError` messages and `classifyMessage(lastErrorLine)` are not. Examples are `ProviderError(\`Veo error: ${JSON.stringify(op.error)}\`)` at gemini/veo.ts:156 and any stderr line. In the Worker, which imports `errors.ts`, this blocks the isolate's CPU budget.
- Fix: bound the path part (`{0,2048}` as in H1). With that bound, 200 KB took 250 ms in the same test. Alternatively, cap input length before replacing.

## Low

### L1. Text where the query is cut short or not recognized at all (documented in part)
The doc comment mentions path and fragment secrets, but these cases are not listed:
- `#` ends the query and the fragment is kept. `https://a/b#access_token=TOK` and `?x=1#tok=…&sig=S` leak everything after `#`.
- A provider that echoes a URL-decoded query (`response-content-disposition=attachment; filename=x&X-Amz-Signature=…`) leaks everything after the first space. NBSP counts as `\s` too.
- Percent-encoded nested URLs (`redirect=https%3A%2F%2F…%3Fsig%3D…`), `?` in place of `?`, and scheme-less hosts (`bucket.s3.amazonaws.com/a?X-Amz-Signature=…`) are not matched.
- Fix: at minimum, also redact a `#fragment` that directly follows the matched URL (`(?:#[^\s"<>\`]*)?`). The other cases are acceptable as documented limits; add them to the JSDoc so the contract is honest.

### L2. Useful non-secret query links are now redacted in every MultixError message
`src/core/errors.ts:18`. Google 403 SERVICE_DISABLED errors embed `https://console.developers.google.com/apis/api/…/overview?project=123`, and the activation link loses its project. This is an acceptable trade-off for a blanket rule. Mention it in the PR so it is a deliberate choice.

### L3. The docs overclaim stderr coverage and do not mention `log[]`
`docs-site/src/content/docs/reference/for-ai-agents.md:70` and `vi/reference/for-ai-agents.md:70`. "the same message goes to stderr" holds only when the command did not print its own `✗` line (agent-runtime.ts:299 prints `Error: info.message` only when there is no `lastErrorLine`). Otherwise stderr shows the command's own line. Also, only `http(s)` query strings are redacted, not fragments. The VI translation matches the EN text. Fix: either do M1 or say "in `error.message` and the history entry" and drop or qualify the stderr claim.

### L4. fetch-telemetry now stops at `"`, which is weaker than the old regex for dry-run string values
`src/agent/fetch-telemetry.ts:37`. The old regex `[^\s#]*` redacted a query that contained a literal `"`. The shared one stops there. `shorten` works on already-parsed string values, where a literal quote is not JSON escaping, so the old behavior was safer there. This is rare; H1's fix does not change it. Accept it, or keep a quote-tolerant variant for the parsed-value case.

### L5. `HeygenApiError` overwrites `this.message` after `super()` and skips constructor redaction
`src/providers/heygen/heygen-errors.ts:26`. This is safe today, because `apiMessage` comes from the already-redacted snippet and `build()` redacts again, but it is fragile. A future caller that passes `apiMessage` from a parsed body would get an unredacted `message` wherever it is printed directly. Fix: wrap the value in `redactUrlsInText(describeHeygenError(...))`.

### L6. Test gaps
- No test with a `\"`-quoted URL inside a JSON body (H1), with a fragment, or for `log[]` contents with a raw stderr line (M1).
- `tests/unit/core/worker-safe-http.test.ts` MultixError case: `not.toContain("S1")` is a weak sentinel. Use a distinctive token.
- No consumer-level test that replicate/runway `errorDetail` still extracts `detail` from a body containing an echoed signed URL.

## Edge cases found by scouting
- Idempotency: double redaction (constructor, then `build()`, then `toHeygenApiError` re-wrapping) is stable.
- runway `scrubSecret` (client.ts:134) still works: if the secret sat inside a URL query it is already gone, and otherwise `split`/`join` runs as before.
- gemini key-pool `RESOURCE_EXHAUSTED` / `retryDelay` matching is unaffected, because Google bodies quote URLs with unescaped `"` in JSON and the match stops there.
- Out of scope, pre-existing (file as a separate issue): `redactArgv` (src/agent/history-store.ts:78) misses the `--image=https://…?X-Amz-Signature=…` form because the argument starts with `--image=`, so a signed input URL passed with `=` reaches history `argv` and the envelope `next[]`.

## Recommended actions
1. Change the regex to the H1/M2 form and add the `%q`-body unit test.
2. Redact `log[]` lines in `finalizeRun` (M1), or file a follow-up and narrow the docs (L3).
3. Optionally redact the fragment after a matched URL (L1) and harden HeygenApiError (L5).
4. Open a separate issue for the `--flag=URL` argv leak.

## Metrics
- Typecheck: clean. Lint: 0 issues. Tests: 1817 passed, 21 skipped. check:mcp: pass.

## Unresolved questions
- Is `log[]` meant to be covered by #340 ("--json envelope")? If so, M1 is a blocker for closing the issue.

## Resolution (commit 7a8e3d0)

- H1, M2: the query now stops at an escaped quote and the path match is bounded (`{0,2048}`); tests cover a quoted URL in a JSON body and 200 KB input.
- M1: every stderr write goes through `redactUrlsInText` in `captureStreams`, so terminal stderr and the envelope `log[]` are redacted; the smoke test asserts it with a raw provider body logged to stderr.
- L1, L2: fragments, URL-decoded queries and percent-encoded nested URLs are listed as known limits in the JSDoc; fragments stay, matching the dry-run behaviour from #326.
- L3: EN/VI docs now name `message`, `log[]`, stderr and history, and say fragments are kept.
- L4: `fetch-telemetry.ts` is back to its own greedy pattern, so dry-run redaction is unchanged.
- L5: HeyGen's rebuilt message goes through `redactUrlsInText`.
- L6: added the quoted-URL, `mapReplicateError` detail and distinct-token tests.
- Unrelated `redactArgv --flag=URL` case: added to #322, which owns `redactArgv`.
