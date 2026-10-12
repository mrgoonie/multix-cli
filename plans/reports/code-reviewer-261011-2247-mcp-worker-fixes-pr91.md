# Follow-up Review: PR #91 `feat/mcp-worker` (closes #55), fix commit b1bf753

Reviewer context: isolated, read-only. Head `b1bf753` (parents: merge `0d29f0c` of origin/main into `862923e`). Worktree `D:\www\oss\multix-cli\.claude\worktrees\agent-afeab75ccebb00123`; HEAD confirmed through `.git/worktrees/agent-afeab75ccebb00123/logs/HEAD`.
First review: `plans/reports/code-reviewer-261011-2222-mcp-worker-pr91.md`.
The Bash tool returned no output in this session, so nothing was run locally. Evidence comes from reading the source at HEAD, the GitHub API (commit files, check runs, job steps), and the tests in the branch.

## Scope
- Delta `862923e..b1bf753`: 21 files, +613/−77.
  - Worker source: `index.ts`, `mcp-server.ts`, `config.ts`, `providers/atlascloud.ts`, `providers/types.ts`.
  - Worker tests: `http.test.ts`, `mcp-tools.test.ts`, new `live-smoke.test.ts`.
  - Worker config: tsconfig split (`tsconfig.json` + `tsconfig.test.json`), `wrangler.jsonc`, `check-bundle.mjs`.
  - Shared code: `src/core/errors.ts`, `src/providers/cloudflare/video-client.ts`, plus a CLI test.
  - Docs: EN/VI docs, README, SKILL, AGENTS.md.
- Focus: whether each first-review finding is really fixed, plus new holes in CORS, batching, spend caps, the live test, and shared CLI code.

## CI status (head b1bf753)
All 6 check runs are `success`:
- MCP Worker (job 114509020236). The Type check, Test, and Bundle check steps all ran and succeeded.
- CI on Node 20/22 × ubuntu/windows.
- Documentation site.

## Overall Assessment
Every High and Medium item from the first review is fixed, and each fix has a test. The CORS work is correctly scoped:
- Only `OPTIONS` from an already-allowed Origin skips auth.
- Every other method still goes through the rate limiter, then the bearer check.
- There is no `allow-credentials` and no wildcard.

Batch rejection happens after auth and after the bounded 64 KiB read. A video `duration` is now sent to every provider, and when the caller omits it, the server sends a default no greater than the cap. The changes I found are small residual gaps and doc wording, all Low. **Verdict: mergeable.** The Low items can be follow-ups.

## First-review findings: verification

| # | Finding | Status | Evidence |
|---|---|---|---|
| H1 | CI typecheck red (`captureStackTrace`) | **Fixed** | `src/core/errors.ts:17-20` uses an optional call on a locally typed cast. The receiver is preserved (`(Error as …).captureStackTrace?.(…)` is a member call), so V8/Node stack traces are unchanged. `worker/tsconfig.json:7,16` checks only `src/**` with `types: ["@cloudflare/workers-types"]`. Tests are checked separately via `tsconfig.test.json`, and `typecheck` runs both (`worker/package.json:11`). The CI MCP Worker job is green. |
| H2 | JSON-RPC batch spend amplification | **Fixed** | `worker/src/index.ts:139-141` returns 400/-32600 for array bodies. The check runs after auth (`:118-121`) and after `readBodyLimited` (64 KiB, `:130`), so parsing stays bounded. Test: `http.test.ts:172-192`. |
| M1 | Duration cap bypass when `duration` is omitted | **Fixed** (Low residual, see L1) | `mcp-server.ts:307` sends `args.duration ?? limits.defaultVideoSeconds`. `config.ts:93` defines that default as `min(5, cap)`. Per provider: Replicate `replicate.ts:81`, HeyGen `heygen.ts:48` (a cap below 5 fails closed at HeyGen's 5 s minimum, tested), Cloudflare `cloudflare.ts:48`. Atlas: `atlascloud.ts:74-92` fails closed when there is no schema, and `:113-119` re-checks the duration that will be billed. Tests: `mcp-tools.test.ts:349-410, 447-495, 521-531`. |
| M2 | Resolution uncapped | **Fixed** (Low residual, see L2) | `mcp-server.ts:288-293` checks a lower-cased allowlist before any adapter call. The only video tool is `multix_generate_video`, so this covers every provider. Default allowlist is `480p,720p,1080p` (`config.ts:59,89-94`; `wrangler.jsonc:24`). Test: `mcp-tools.test.ts:497-519`. |
| M3 | No credential-gated live smoke test | **Fixed** | `worker/test/live-smoke.test.ts:20,33` runs only when `MULTIX_MCP_LIVE === "1"` **and** a Replicate token is set; the video part also needs `MULTIX_MCP_LIVE_VIDEO=1`. CI sets neither, so the suite is skipped by default. It does not print key values. See L5 for its coverage limits. |
| M4 | CLI behavior change without a test | **Fixed** | `tests/unit/providers/cloudflare/client.test.ts:113-147` polls `{status:"processing", output:null}` and then success through the CLI `waitForVideo`. It also asserts that an `AbortSignal` is passed. |
| L1 | CORS unusable for browsers | **Fixed** | `index.ts:81-103`; details in the CORS section below. |
| L2 | Rate limiter caveats | **Fixed (docs)** | `wrangler.jsonc:10-13` and `mcp-server.md:131-138` now say the limit is approximate and that `namespace_id` must be unique. |
| L3 | `/health` returns the version | **Fixed** | `index.ts:169` returns `{ ok: true }`. Test: `http.test.ts:7-11`. |
| L4 | No timeout on the Cloudflare video client | **Fixed** | `video-client.ts:67-75` adds `AbortSignal.timeout(opts.timeoutMs ?? 120 s)`. See L3 for how a timeout is reported. |
| L5 | SDK 1.30.1 in the GHSA range | **Deferred (accepted)** | It is still pinned at `worker/package.json:16`, and the server-only usage is not exploitable. Open a tracking issue for the bump to ≥1.31.0 once it is 14 days old (AGENTS.md: new issue, not this PR). |
| L6 | Bundle check is heuristic | **Fixed** | `check-bundle.mjs:10-20` flags any `"node:*"` string and bare built-in imports in `from` / `import()` / `require()` / `import "x"` form. |
| L7 | Provider text in the logged `detail` | **Fixed (docs)** | `mcp-server.md:162-169` now says that `detail` can echo prompt fragments and that the same scrubbed text goes to the client. |

## CORS / Origin checks (requested)
- **The preflight bypass covers OPTIONS only.**
  - `index.ts:90` requires `request.method === "OPTIONS" && origin !== null`, and it runs *after* `originAllowed` (`:81`). Every other method goes to `handleAuthorizedMcp`: rate limiter, then bearer check, then a POST-only check.
  - A disallowed Origin gets 403 with no CORS headers (`http.test.ts:93-95`).
  - An OPTIONS without an Origin goes through auth and gets 401 (`http.test.ts:116-122`).
- **Origin absent vs present.**
  - Absent: no CORS headers (`corsHeaders(null)` returns `{}`, `index.ts:58`).
  - Present: it must be listed exactly. An empty `Origin:` header is non-null and is not in the list (`csv` drops empty entries), so it gets 403. The literal `null` origin is rejected unless an operator lists it.
- **`Vary: Origin`** is set on every response for an allowed origin (`index.ts:62`). It is absent when there is no Origin. That is harmless because every response is `cache-control: no-store` and the bodies do not depend on Origin.
- **Credentials flag:** none, which is correct. Auth is a bearer header, not cookies, so `Access-Control-Allow-Credentials` is not needed and its absence also blocks ambient-credential use.
- **Wildcard:** not supported. `MULTIX_MCP_ALLOWED_ORIGINS="*"` matches only a literal `*` Origin, which browsers never send, so it fails closed. The docs do not say this (folded into L4).
- **Every response gets CORS headers for an allowed origin:** 401, 429, 405, 413 and 400 all pass through `withHeaders` (`index.ts:103`). The 503 (not configured) and 403 responses do not, which is correct.

## Critical Issues
None.

## High Priority
None.

## Medium Priority
None.

## Low Priority

### L1. On Atlas, the duration sent is not always `min(5, cap)`, and length fields with other names are not capped
- Location: `worker/src/providers/atlascloud.ts:86-91` and `:113-119`.
  - When the schema has a `duration` field whose default is ≤ cap, that default is sent (e.g. 8 s with cap 10), not `min(5, cap)`.
  - When the schema has no `duration` field, nothing is sent (`return undefined`).
  - The billed re-check reads only `body.duration`.
- Failure scenario: an Atlas model whose length input has another name (e.g. `num_frames`, `video_length`), or whose fixed render length is long, is billed at the model default even though `MULTIX_MCP_MAX_VIDEO_SECONDS` is set. Spend still stays within the cap's intent for every model that uses `duration`, which `FIELD_CANDIDATES.duration` (`src/providers/atlascloud/model-input.ts:74`) says covers the catalog.
- Docs overstate the guarantee. `mcp-server.md:155-157` says "A video `duration` is always sent explicitly (the caller's value or `min(5, cap)`)". `multix_list_providers` also reports `default_video_seconds` (`mcp-server.ts:195`) as if it applied to every provider.
- Fix: reword the docs (EN and VI). Atlas sends the schema default when it is within the cap, otherwise `min(5, cap)`, and models without a `duration` input are not length-capped; pin vetted models with `MULTIX_MCP_ALLOWED_MODELS`. Optionally, always send `policy.fallback` instead of the schema default, for one consistent rule.

### L2. A resolution filled from a default is not checked against the allowlist
- Location: `worker/src/mcp-server.ts:288-293` checks only the caller's value. On Atlas, `finalizeAgainstSpec` (`src/providers/atlascloud/model-input.ts:271-276`) fills a *required* `resolution` from the schema default, after the allowlist check, and nothing re-checks it.
- Failure scenario: an Atlas model whose schema requires `resolution` with default `4k` (or `2k`) renders at that resolution when the caller omits it, even though the operator's allowlist excludes it. The docs do say "An omitted resolution uses the model default" (`mcp-server.md:128`), so this is a documented limitation, not a bypass of a stated guarantee.
- Fix (optional): in `atlascloud.ts` `submit`, next to the billed-duration check, reject when `typeof body.resolution === "string"` and `!ctx.limits.allowedResolutions.includes(body.resolution.toLowerCase())`. This needs `allowedResolutions` passed into `submit`.

### L3. Cloudflare video timeouts and network errors are not wrapped
- Location: `src/providers/cloudflare/video-client.ts:67-75, 103-108, 116-119`. `send()` lets the timeout and network rejections (`DOMException` TimeoutError/AbortError, `TypeError`) escape unwrapped. `fetchJson` wraps the same failures in `HttpError(0, …)` (`src/core/fetch-json.ts:80-85`).
- Failure scenario:
  - In the Worker, a 120 s gateway hang is not a `MultixError`, so `runTool` (`mcp-server.ts:142-153`) logs it at `error` and returns the generic "Internal error while running the tool" instead of a timeout message.
  - In the CLI, the user sees the raw "The operation was aborted due to timeout".
  - On create, a timeout after the gateway accepted the job loses the prediction id. This is inherent to any client-side timeout, but worth a clear message.
- Fix: wrap the `f(...)` / `globalThis.fetch(...)` call in try/catch and throw `new ProviderError("Cloudflare request failed: " + (timeout ? "timed out" : "network error"), "Cloudflare")`. Add a test with a fetch that rejects.

### L4. Small doc and message gaps
- `MULTIX_MCP_ALLOWED_ORIGINS` docs (`mcp-server.md:129`) should say that `*` is not supported (exact origins only).
- Errors returned to MCP clients use CLI vocabulary:
  - HeyGen duration and resolution errors name `--duration` / `--resolution` (`src/providers/heygen/request-builders.ts:435-443`). This message is now hit by default when the cap is below 5 s.
  - The Atlas "does not accept" message suggests `multix atlas run …` (`model-input.ts:237`).
  - This is cosmetic only.
- HeyGen supports `768p` (`src/providers/heygen/models.ts:25`), but the default allowlist excludes it. That is conservative and fine, but a one-line doc note would save operators a confusing rejection.

### L5. The live smoke test runs in Node, not in the Workers runtime
- Location: `worker/test/live-smoke.test.ts:1-11`. It calls `handleRequest` in-process with Node's fetch. It therefore does not cover workerd-specific behavior: the native-fetch receiver issue noted at `video-client.ts:68`, the missing `nodejs_compat`, and the real rate-limit binding. It also exercises only Replicate.
- This is acceptable for #55 AC2 as written. Note it on the issue, and optionally add a mode that targets a deployed URL (`MULTIX_MCP_LIVE_URL`) with the same token gate.

### L6. Process: the commit carries an AI co-author trailer
- `b1bf753` has an AI co-author trailer. The maintainer's global development rules ask for conventional commits "without AI references". Squash-merge with a cleaned message if that rule applies to this repo.

## Other edge cases checked (non-issues)
- **Batch variants.** `[]` and single-element arrays are both rejected. Non-array garbage (`null`, numbers) reaches the SDK transport, which returns its own JSON-RPC error. A parse error returns -32700 before the array check.
- **Unauthenticated OPTIONS skips the rate limiter.** This happens only for listed origins and returns a static 204 with no subrequests, so its cost is equivalent to the already unlimited 403/404//health paths.
- **Duration bounds.** The zod schema allows `1..15` (`mcp-server.ts:268-274`), `> cap` is rejected (`:285`), and `boundedInt` clamps the env cap to ≤15 and falls back on garbage values (`config.ts:68-72`).
- **`errors.ts`.** Behavior on Node is unchanged: same call, same receiver, same `constructorOpt`. All 4 root CLI CI jobs are green. Lint passes despite the cast.
- **Worker typecheck isolation.** An explicit `types` list stops `@types/node` from being picked up automatically. Any `node:*` import reached through shared `src/` would now fail `tsc` in CI.
- **`check-bundle.mjs`.** The bare-builtin regex is anchored to import syntax, so a plain string such as `"url"` in a bundled library is not flagged. The CI step ran and passed.
- **Concurrency.** There is still no module-level mutable state, and each request builds a fresh server and transport.

## Positive Observations (risk calibration only)
- The fixes are narrow and each comes with a test that asserts **no provider call** on rejection (`calls.toHaveLength(0)` / no POST). This is the correct proof for spend guards.

## Recommended Actions
1. Merge. Optionally, before merging, fix the L1 doc wording (EN and VI) so the spend guarantee is not overstated.
2. Follow-ups, each as its own issue per AGENTS.md:
   - Atlas billed-resolution re-check (L2).
   - Wrap Cloudflare video fetch errors (L3).
   - SDK bump to ≥1.31.0 (first-review L5).
   - Optional deployed-URL live smoke mode (L5).
3. Clean the commit trailer on squash if the no-AI-reference rule applies (L6).

## Metrics
- Type coverage: strict TS. The worker source is now checked without Node typings, and CI typecheck is green.
- Tests: CI green on the worker (tests plus bundle check) and on root CLI tests across 4 OS/Node combos. Exact counts were not reproduced locally because Bash was unavailable.
- Linting: root lint green in CI.

## Unresolved Questions
- Should Atlas always send `min(5, cap)` when the caller omits `duration`, for one rule across providers? The current rule is the schema default when it is within the cap.
- Does the no-AI-reference commit rule apply to this repo's history, given the attribution trailer convention used in other PRs?

Status: DONE
Summary: Merge. All first-review High and Medium findings are verified fixed (CI green at b1bf753, including the MCP Worker typecheck, tests and bundle check). Critical 0, High 0, Medium 0, Low 6 (Atlas duration-default wording and differently named length fields; schema-filled resolution not allowlisted; unwrapped Cloudflare timeout errors; doc and message gaps; live test is in-process only; AI trailer in commit).
