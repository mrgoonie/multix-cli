# Code Review: PR #120 `fix/mcp-worker-followups` (closes #103), head 5df68e0

Reviewer context: isolated, read-only. Worktree `D:\www\oss\multix-cli\.claude\worktrees\agent-aa3244d682d53f525`; HEAD confirmed as 5df68e0 via `.git/worktrees/agent-aa3244d682d53f525/logs/HEAD`. Bash was unavailable, so nothing ran locally. Evidence comes from the source at HEAD, the GitHub API (PR files, compare, check runs), raw files on `main`, and live Atlas Cloud schemas.

Source of the issue: `plans/reports/code-reviewer-261011-2247-mcp-worker-fixes-pr91.md`, findings L1–L4.

## Scope
- 12 files, +519/−101.
  - Worker: `worker/src/providers/atlascloud.ts`, `mcp-server.ts`, `config.ts`, `wrangler.jsonc`, `test/mcp-tools.test.ts`.
  - Shared: `src/providers/cloudflare/video-client.ts`, `src/providers/atlascloud/model-input.ts`, new `tests/unit/providers/cloudflare/video-client.test.ts`.
  - Docs: README, SKILL, EN and VI `guides/mcp-server.md`.
- Base: the merge base is `46288a2` (#100). The branch is **3 commits behind `main`**, which now contains #111 (`src/core/fetch-error.ts`, `toFetchError`). The PR did not use it (see M2).
- CI at 5df68e0: all 6 check runs passed (CI on Node 20/22 × ubuntu/windows, Documentation site, MCP Worker).

### Atlas catalog check
I fetched live schemas to calibrate the findings:

| Model | `duration` | `resolution` |
|---|---|---|
| gemini-omni-1.1-flash t2v | integer, min 3, max 10, default 10 | default `720p`, enum includes `4k` |
| minimax h3-max t2v | number, enum 5..15, default 8, required | default `768P`, enum includes `4k-sr`, required |
| wan-3.0 t2v | number, enum `-1` ("smart") plus 2..30, default 5 | default `1080p`, enum includes `4k-esr` |
| kling v3.0 turbo i2v | integer, enum 3..15 | default `1080p` |
| seedance-2.0-mini r2v | integer, enum `-1`, 4..15 | default `720p`, enum includes `1440p-SR` |

Every sampled model uses a numeric `duration` and a string `resolution`. The new code handles all of them correctly: `-1` is excluded because the lower bound is 0, `768P` is lower-cased before the allowlist check, and the `-sr`/`-esr` suffixes are rejected.

## Overall Assessment
- **Atlas, schema loaded:** the length logic is sound and fails closed (it rejects when no allowed value fits under the cap).
- **Atlas resolution:** the check now covers the default the API fills in.
- **Tests:** each spend test asserts that no POST is made on rejection.

Two gaps remain at the cost boundary:
1. **No-schema path:** it still fails open on resolution, which contradicts the new docs.
2. **Cloudflare error mapping:** it re-implements fetch-error classification that `main` already centralised in #111, with the opposite retry default for Workers-style errors.

**Verdict: fix first.** H1 is a small change. M2 needs a rebase onto `main`.

## Critical Issues
None.

## High Priority

### H1. Atlas with no schema: the resolution default is unchecked when the caller passes `duration`, which contradicts the docs
- **Where:** `worker/src/providers/atlascloud.ts:145-151` and `:184-196`.
- **What happens:** when `loadSpec` returns `undefined` (catalog or schema fetch failed, or the model is not in the public catalog), `lengthRequests` fails closed only if `duration` was omitted. If the caller passes `duration`, the body is sent with no `resolution`. `assertVideoBodyWithinLimits` then reads `body.resolution ?? spec?.properties.resolution?.default`, which is `undefined`, so the check passes.
  - Atlas fills the model's own default, which can be `1080p-esr`, `4k-sr` or `4k` (see the catalog check above).
  - The same path also sends only `duration`. A length field with a different name falls back to the model default.
- **Trigger:** a caller sends `{provider:"atlascloud", model:<model with a 4k default>, duration:5}` while the 794 KB catalog fetch times out (`CATALOG_TIMEOUT_MS = 15_000`, `client.ts:48`, fetched on every call). An Atlas model id that Atlas accepts but the catalog does not list triggers it too. `loadSpec` (`:51-60`) swallows every error.
- **Docs claim otherwise:**
  - `docs-site/.../guides/mcp-server.md:128`: "on Atlas Cloud that default is checked against this list too".
  - `:174-178`: the final check plus "No schema … fail closed".
  - The VI page says the same at `:127` and `:174-178`. Both are true only when a schema is loaded.
- **No test covers it.** `mcp-tools.test.ts:349-362` covers only the "no schema, duration omitted" case.
- **Fix:** fail closed for video when there is no spec.
  - Simplest: reject with "schema unavailable; cannot verify length and resolution" regardless of `duration`.
  - Lighter alternative: require both `duration` and `resolution` from the caller when there is no spec. Document that other length fields remain unverified in that case.
  - Add a test with the catalog returning 500 and `duration: 5` passed: assert `isError` and that no POST is made.

## Medium Priority

### M1. Length shapes the code does not recognise fail open instead of being rejected
- **Where:** `atlascloud.ts:74`, `:84-91`, `:153`, `:176-183`.
- **How detection works:** a length field is detected only by name (`LENGTH_FIELDS`) and numeric shape. Detected fields are capped. Anything else is left for Atlas to fill, and the final check reads only `body[field]`. Unlike the resolution check, it never falls back to the schema default.
- **Shapes that bypass the cap:**
  - `duration: {type:"string", enum:["4s","8s"], default:"8s"}`. `numericValue("8s")` is undefined, so the field is not detected, nothing is sent, and 8 s is billed with the cap at 5. If the caller passes `duration`, they get "not supported" instead.
  - `anyOf`/`oneOf` wrappers with no top-level `type`, `enum` or `default`. `AtlasSchemaProperty` (`src/providers/atlascloud/types.ts:72-81`) does not model them.
  - Frame counts (`num_frames`, `frames`) and differently named seconds fields (`duration_seconds`, `video_duration`).
- **Mitigating factors:** the docs (`mcp-server.md:180-181`) admit frame counts are not capped. Every sampled catalog model uses a numeric `duration`.
- **Why it still matters:** the Worker is the spend boundary, and `MULTIX_MCP_ALLOWED_MODELS` is unset by default, so any catalog model is selectable.
- **Fix (fail closed):**
  - In `assertVideoBodyWithinLimits`, check `body[field] ?? spec?.properties[field]?.default` for every `LENGTH_FIELDS` name, mirroring the resolution check.
  - Reject when a `LENGTH_FIELDS` property exists but `isNumericLength` is false.
  - Reject when the schema declares a property matching `/frame|duration|seconds/i` that is not handled, unless the model is explicitly listed in `MULTIX_MCP_ALLOWED_MODELS`.

### M2. Cloudflare fetch-error mapping diverges from the merged #111 policy
- **Where:** `src/providers/cloudflare/video-client.ts:74-97`.
- **The PR's mapping:**
  - Abort or timeout becomes `HttpError(0)`.
  - `TypeError` becomes `HttpError(0, "network error: …")`.
  - Anything else becomes a non-retryable `ProviderError`.
- **`main`'s policy** (`src/core/fetch-error.ts`, `toFetchError`, merged in #111): every rejection is transient `HttpError(0)` by default. Only deterministic shapes (url, header, tls, request), matched by `code` or message, become `ConfigError`/`ProviderError`. The header comment in that file says Workers throw codeless errors, which is why the default is transient.
- **Where they conflict:**
  - **Workers runtime:** workerd network failures (for example "Network connection lost.") are plain `Error`s, not `TypeError`. Here they become a non-retryable `ProviderError`. That is the opposite of #111, and Workers is the runtime this client exists for. Today the Worker never polls, so the impact is limited to the classification and wording.
  - **Node:** an invalid header value (a token with an embedded CR/LF/NUL) throws a `TypeError`. Here it becomes a retryable "network error", so the CLI `waitForVideo` (`pollUntil`, `async-poll.ts:56-60`) retries a deterministic failure until the deadline. #111 classifies it as a `ConfigError` with no header value.
  - **Possible key echo:** undici's invalid-header-value `TypeError` quotes the value, so `network error: ${msg}` can include `Bearer <token>`. The Worker scrubs configured secrets (`mcp-server.ts:152-156`). The CLI prints it, as it did before this PR. This is low likelihood and not a regression in the CLI. In the Worker it is new exposure because the message now reaches the MCP client, mitigated by `sanitizeText`.
- **Fix:** rebase onto `main` and replace the custom classifier with `toFetchError(cause, new URL(url).origin, { provider: "Cloudflare" })`. Passing the origin as `url` keeps account and gateway ids out of the message: `toFetchError`'s default branch passes its `url` argument straight into `HttpError`. Keep a timeout-specific message only if `toFetchError` does not already produce one. Add a test for a plain `Error` rejection (Workers shape) that expects a transient `HttpError(0)`.
- **Confirmed:** no `node:*` imports (imports are `errors.js`, `fetch-json.js`, `redirect-fetch.js`, `model-ids.js`). For timeouts and network errors the message names only the origin; the unit test asserts that no config value appears in the message.

## Low Priority

### L1. A non-enum numeric length can be clamped to 0
- **Where:** `atlascloud.ts:110`, `:119-123`.
- **What happens:** the lower bound is `prop.minimum ?? 0`. A numeric field with no enum and no `minimum`, whose default is `0` or `-1` (the "smart" or "auto" convention Wan and Seedance use, though they use enums), produces a target ≤ 0, which is clamped to 0, and `duration: 0` is sent. Some APIs treat 0 as "auto", meaning the model picks the length.
- **Fix:** use `Math.max(prop.minimum ?? 1, 1)` as the lower bound, and use `fallbackSeconds` when `schemaDefault <= 0`.

### L2. Redirect-failure errors still carry the account and gateway ids
- **Where:** `video-client.ts:85` returns any `MultixError` unchanged.
- **What happens:** `fetchFollowingRedirects` throws `HttpError(status, "too many redirects …" / "malformed Location", current)` (`redirect-fetch.ts:111,114`) with the full gateway path. That path contains `accountId` and `gatewayId`, so the "origin only" guarantee in the PR body is not complete.
- **Fix:** rebuild the error from `HttpError`'s status and snippet with the origin as the URL.

### L3. The resolution check covers only the `resolution` field
- **Where:** `atlascloud.ts:184-196`.
- **What is missed:** a model that sets output size through `size`/`video_size` (for example `1920*1080`), or that has a non-string `resolution` default, is not checked. No sampled catalog video model does this.
- **Fix:** add a one-line note to the docs, or fail closed on a non-string `resolution` default.

### L4. The `atlas run` hint is lost for CLI positional arguments
- **Where:** `src/providers/atlascloud/model-input.ts:236-239`.
- **What happens:** the hint is now gated on `flag.startsWith("--")`. The CLI also passes `"[text]"` (`atlascloud/commands/audio.ts:54`) and `"[prompt]"` (`three-d.ts:51`), so those CLI errors lose the hint.
- **Fix:** gate on "not a tool argument" instead, for example `/^(--|\[)/`. This is cosmetic.

### L5. `wrangler.jsonc` default change
- **Where:** `worker/wrangler.jsonc:24`.
- **What changes:** `768p` is added to the allowlist. Existing deployments that use the checked-in vars widen their allowlist on the next deploy.
- **Risk:** cost-neutral or lower, since 768p is below 1080p. The Atlas minimax `768P` default already passed after lower-casing.
- **Fix:** mention it in the PR body or changelog.

### L6. Test gaps
Untested cases:
- no schema with `duration` passed (H1);
- a plain `Error` rejection in the Worker (M2);
- a redirect-loop id leak (L2);
- a non-numeric length field (M1).

## Edge cases checked (non-issues)
- **A caller cannot reach `-1` or `0`:** zod `duration` is `int().min(1).max(15)` (`mcp-server.ts:280-286`), and the cap is enforced before the adapter (`:297`).
- **Enum snapping:** it picks the largest allowed value ≤ target, otherwise the smallest value within `[lo, hi]`, otherwise it rejects. Tests at `mcp-tools.test.ts:434-477` cover snapping, other field names, minimum above the cap, and no enum value within the cap. Each rejection asserts that no POST is made.
- **String numeric enums** (`"4"`/`"8"`): they are coerced to strings by `coerce` and parsed back by `numericValue` in the final check, so the cap holds.
- **Several length fields:** the caller's value goes to the first; the others are sent explicitly. The final check covers every field present in the body.
- **Resolution default:** both required (filled by `finalizeAgainstSpec`) and optional (read from the schema default) cases are checked. Tests at `:479-520` cover both.
- **`toolArgWording`** (`mcp-server.ts:128-133`): it applies only to `ValidationError`, and the regex is anchored to a start or delimiter followed by `--[a-z]`. CLI messages are unchanged because the rewrite runs only in the Worker. The Atlas "does not accept" message drops the hint for tool arguments (test at `:522-532`).
- **HeyGen 768p:** it is allowed by default and passed through (test at `:608`).
- **Docs:** EN and VI have matching structure and claims. The only accuracy problem is H1.

## Recommended Actions
1. **H1:** fail closed for Atlas video when there is no schema, and add a test.
2. **M2:** rebase onto `main` and use `toFetchError` with an origin-only URL, then adjust the tests.
3. **M1:** add the schema-default fallback to the length check, and reject non-numeric length fields. Optionally gate frame-count models behind `MULTIX_MCP_ALLOWED_MODELS`.
4. Fold in L1 and L2. They are small.
5. Docs: once H1 is fixed the current wording is accurate. Otherwise qualify lines 128 and 174-178 in both languages.

## Metrics
- Type coverage: strict TS, and the Worker is checked without Node typings. CI typecheck passed.
- Tests: CI passed in all 6 jobs. New tests: 4 unit tests (Cloudflare client) and about 12 Worker cases.
- Lint: passed in CI.

## Unresolved Questions
- Does Atlas accept model ids that are not in the public catalog? If it does, H1 can be triggered on demand rather than only during catalog outages.
- Should frame-count models be blocked outright unless they are allowlisted, or is the current documented limitation acceptable to the maintainer?

Status: DONE_WITH_CONCERNS
Summary: Fix first. Critical 0, High 1 (the Atlas no-schema path fails open on resolution, contrary to the docs), Medium 2 (unrecognised length shapes fail open; the Cloudflare error mapping diverges from #111 `toFetchError` and the branch is 3 commits behind main), Low 6.
