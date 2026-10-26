# Code review: dry-run body URL query redaction (#318)

Scope: uncommitted diff in `src/agent/fetch-telemetry.ts`, `tests/unit/agent/fetch-telemetry.test.ts`, `tests/smoke/agent-mode.test.ts` (+84/-2).
REVIEW.md: there is no REVIEW.md in the repo root (or anywhere else in the repo), so the review checks the diff against AGENTS.md only.

## What I checked

- `npx vitest run tests/unit/agent tests/smoke/agent-mode.test.ts`: 4 files, 26 tests, all passed.
- `npx biome check` on the 3 files: clean. `tsc --noEmit`: clean.
- Ran a probe of `redactUrlValue` edge cases in node (results below).
- Traced the paths that consume `DryRunRequest`: the `--json` envelope `request` field and the text-mode stderr print (`agent-runtime.ts:305-311`). Both go through `describeRequest`, so both get the fix. The other dry-run outputs are the EXEC guard and `next` (see out-of-scope notes).

## Blocking

None. The DoD is met. A JSON body value or FormData string value that is an http(s) URL loses its query and fragment at any depth up to the existing depth cap. Nested `input_audio.url` and an array of URLs are tested, and the smoke test proves it end to end against `dist/cli.js`.

## Should-fix

1. **FormData path has no test.** The issue names "JSON/FormData request body", and `fetch-telemetry.ts:88-93` routes FormData strings through `shorten`. Every new test sends a JSON string body.
   - Failure scenario: a later refactor stops calling `shorten(v)` for FormData strings, for example to show multipart fields verbatim. The tests stay green, and a signed `image_url` field on a multipart upload (OpenAI edits, ElevenLabs and similar) leaks again.
   - Fix: add a third case to `dryRunBody` that takes a `BodyInit`. Pass `new FormData()` with `fd.append("image_url", "https://b.s3.amazonaws.com/a.png?X-Amz-Signature=SECRET")` and assert `{ image_url: "https://b.s3.amazonaws.com/a.png?[redacted]" }`.

2. **URLs inside longer strings are not redacted** (`fetch-telemetry.ts:39`, regex anchored with `^`). Probe: `"see https://a.com/x?sig=S"` is returned unchanged.
   - Failure scenario: an OpenRouter or OpenAI chat body puts the signed URL inside message text, for example `messages[0].content = "Describe https://bucket.s3.../a.png?X-Amz-Signature=..."`, or a provider prompt template interpolates the URL. `multix ... --dry-run --json` then prints the signature verbatim.
   - This is outside the literal scope ("any http(s):// string value"). Per AGENTS.md, open a follow-up issue rather than widening this PR. A minimal fix is `value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, redactUrlValue)`.

## Nit

1. **The doc comment overclaims userinfo removal** (`fetch-telemetry.ts:33-37` vs `:44-45`). The catch fallback keeps everything before `?`/`#`, so userinfo survives when `new URL` throws. Probe: `"https://user:PW@bad host/x?sig=S"` becomes `"https://user:PW@bad host/x?[redacted]"`.
   - This is contrived, because such a URL could never be fetched by the provider. Either strip `^https?://[^/@]*@` in the fallback or soften the comment.

2. **Leading whitespace bypasses redaction** (`:39`). Probe: `" https://a.com/x?sig=S"` is returned unchanged.
   - Failure scenario: a user passes `--image-url " https://...?sig=..."` from a copy-paste, and the command forwards it untrimmed. Use `/^\s*https?:\/\//i` with `value.trim()` before parsing.

3. **A fragment-only URL gets `?[redacted]`** (`:40`): `https://a.com/x#frag` becomes `https://a.com/x?[redacted]`. This invents a query that the real request does not have. It is harmless and consistent with the requested format, but `#[redacted]` would be more accurate. Optional.

4. **Docs wording.** `docs-site/src/content/docs/reference/for-ai-agents.md:30` (and the `vi/` twin at line 31) says the dry-run shows "body with long values shortened". It now also redacts URL queries in the body. The behavior is user-visible and security-relevant, so a one-clause docs update is reasonable. Not required by the stated scope.

5. **The redaction differs from `redactArgv` on purpose.** `history-store.ts:78` redacts only when `SIGNED_QUERY` matches. The new code redacts every query, which is stricter, and that is good for a body. Note it in the PR so nobody "aligns" it back.

## Test-isolation review

- `run.dryRun = true` is reset in `finally` (`fetch-telemetry.test.ts:69-71`), so it cannot leak even if the assertion throws.
- `globalThis.fetch` is overwritten twice per call: first `vi.fn`, then the wrapper. The file-level `afterEach` restores `original` (captured at import time). There is no leak between tests or into the first `describe`.
- The `onDryRun` callback throws instead of exiting. Because the wrapper is `async`, the throw becomes a rejection, and the test asserts it with `rejects.toThrow`. The inner `vi.fn` is never reached, so no real request is possible. Correct.
- The smoke test's `not.toContain("SECRETSIG")` covers the whole stdout, including `next[0]`. It passes there only because `?sig=` happens to match `SIGNED_QUERY` in `redactArgv`. That is acceptable, but see out-of-scope note 1.

## Out-of-scope leak paths (follow-up issues, not this PR)

1. **`next[0]` in the dry-run envelope** (`agent-runtime.ts:223-226`) uses `redactArgv`, which keeps queries that do not match `SIGNED_QUERY`. Example: `--image-url "https://x/a.png?auth=SECRET"` is redacted in `request.body` but printed verbatim in `next` and in the history ledger.
2. **EXEC dry-run body** (`agent-runtime.ts:331-334`, Codex image driver) passes `args` through only a length cap, not `shorten`/URL redaction. If `--image` refs can ever be URLs, their queries leak.

Status: DONE_WITH_CONCERNS
Summary: The change meets the #318 DoD (nested and array URL queries are redacted, unit and smoke tests pass, lint and typecheck are clean). There are no blocking findings. The FormData path is untested, and URLs embedded in prose or in argv-derived `next` still leak, which should be follow-up issues.

## Resolution (implementer)

- Should-fix 1: added a FormData case to the unit tests.
- Should-fix 2: fixed in this PR, because a URL inside a longer body string also breaks the #318 DoD. `shorten()` now redacts every http(s) URL in a string (`redactUrls`), which also covers leading whitespace (nit 2).
- Nit 1: the fallback for unparseable URLs now strips `user:password@`.
- Nit 3: kept `?[redacted]` for fragments so the format matches the issue and `history-store.ts`.
- Nit 4: the dry-run sentence in the EN and VI agent docs now names URL query and secret redaction.
- Nit 5: noted in the PR body.
- Out-of-scope leak paths 1 and 2: tracked in #322.
