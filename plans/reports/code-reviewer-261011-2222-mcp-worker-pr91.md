# Code Review: PR #91 `feat/mcp-worker` (closes #55), remote MCP server on Cloudflare Workers

Reviewer context: isolated, read-only. Head `862923e`, base `fea7a95`. Worktree `D:\www\oss\multix-cli\.claude\worktrees\agent-a42d546a6ca20f84d`.
Bash was unavailable in this session, so nothing was run locally. Evidence comes from reading source, the vendored SDK in `worker/node_modules`, the GitHub API (files, check runs, annotations) and issue #55.

## Scope
- Files: 37 changed. New `worker/` package (src 9 files, tests 3, scripts, config), a shared Cloudflare provider refactor (`src/providers/cloudflare/{client,models,model-ids,video-client}.ts`), CI job, root scripts, docs EN/VI, README, SKILL, AGENTS.md, biome/.gitignore.
- LOC: about 2.1k added, excluding the 4,244-line `worker/package-lock.json`.
- Focus: auth, rate limiting, SSRF, cost caps, secret handling, bundle purity, CI, npm package impact, shared-code regressions, docs, scope.

## Overall Assessment
The security core is sound:
- Fail-closed token check.
- SHA-256 plus constant-time XOR compare.
- Strict `Bearer` regex.
- Origin check, and the rate limiter runs before auth.
- Bounded streaming body read.
- zod schemas, an SSRF guard with good test coverage, and generic messages for unexpected errors.

Two things block merge:
1. **The PR's own CI job is red.**
2. **JSON-RPC batching lets one HTTP request carry 100 billable tool calls**, which multiplies the advertised 60 req/min limit by 100.

The duration cap also has gaps (described below), and one acceptance criterion from #55 is missing.

## Critical Issues
None.

## High Priority

### H1. The `MCP Worker` CI job fails (typecheck), so tests and the bundle check never run in CI
- Evidence: check run 114504202869 on `862923e` concluded `failure`. Annotations: `Property 'captureStackTrace' does not exist on type 'ErrorConstructor'` (twice), exit code 2.
- Source: `src/core/errors.ts:16-17` (`Error.captureStackTrace`). The worker typechecks shared `src/` with `"types": ["@cloudflare/workers-types"]` (`worker/tsconfig.json:7`), and `worker/package-lock.json` has no `@types/node`.
- Why it passes locally: the test files pull in vitest typings, which reference `node`. TypeScript then walks up to the repo-root `node_modules/@types/node`. The CI job runs only `npm ci --prefix worker`, so no root `node_modules` exists there.
- Side effect: locally, Node globals leak into the worker typecheck, so `tsc` does not actually prove the worker code is Node-free.
- Impact:
  - The PR description's "43 passed / bundle clean" is local-only evidence.
  - The CI gate added by this PR has never passed.
  - Merging would leave `main` red.
- Fix (any one):
  - (a) Make the call runtime-neutral in `errors.ts`: `(Error as { captureStackTrace?: (t: object, c?: Function) => void }).captureStackTrace?.(this, this.constructor)`.
  - (b) Add a worker-local ambient declaration `interface ErrorConstructor { captureStackTrace?(target: object, ctor?: Function): void }`.

  Also consider splitting the tsconfig: `tsconfig.json` for `src/**` only, without vitest types, and a separate one for tests. Then Node typings cannot leak into the worker-source check. Re-run CI and attach the green run.

### H2. JSON-RPC batches multiply the rate limit and spend 100x per HTTP request
- Location: `worker/src/index.ts:65-69` (one `limit()` call per HTTP request) and `worker/src/index.ts:83,98` (the parsed body goes straight to the transport).
- Evidence:
  - The vendored SDK 1.30.1 accepts arrays: `webStandardStreamableHttp.js:504-512`, `MAX_BATCH_SIZE = 100` in `server/requestBody.js:4`.
  - The stateless mode needs no `initialize` before `tools/call`.
- Failure scenario: a holder of the token sends one 64 KiB POST containing 100 `tools/call` → `multix_generate_video` messages. That is 60 req/min × 100 = 6,000 billable video starts per minute per IP. Paid-plan subrequest limits allow this (Replicate needs 1 subrequest per call, Atlas 2).
  - The docs present the 60/min limiter as a spend bound (`docs-site/.../guides/mcp-server.md:130-133`).
  - The 2025-06-18+ MCP spec removed batching, so rejecting it costs nothing.
- Fix: in `handleMcp`, after parsing, `if (Array.isArray(parsedBody)) return jsonRpcError(400, -32600, "Batch requests are not supported");`. Add a test. Optionally, call the limiter once per `tools/call` instead of once per HTTP request.

## Medium Priority

### M1. The video duration cap only applies when the caller sends `duration`
- Location: `worker/src/mcp-server.ts:276-278`. Gaps per adapter:
  - **Replicate** (`worker/src/providers/replicate.ts:73-85`), **HeyGen** (`heygen.ts:45-52`) and **Cloudflare** (`cloudflare.ts:41-52`) forward `duration` only if it is set. When it is omitted, the provider or model default is billed.
  - **Atlas** (`atlascloud.ts:50-59,70-80`) re-checks `body.duration` only when the schema fetch succeeds. `loadSpec` swallows every error, so if the spec fetch fails and `duration` is omitted, the server-side default goes through unchecked.
- Failure scenario: an operator sets `MULTIX_MCP_MAX_VIDEO_SECONDS=5`. A caller omits `duration` on HeyGen or Cloudflare `prunaai/p-video`, and the provider renders its own default length, which can be longer.
- The docs admit this only for arbitrary Replicate models (`mcp-server.md:147-150`) and imply the Atlas re-check always happens.
- Fix:
  - For the fixed-model adapters (HeyGen, Cloudflare, and the default Replicate video model), always send an explicit `duration = args.duration ?? Math.min(<known default>, limits.maxVideoSeconds)`.
  - For Atlas, either fail closed when the spec is unavailable and `duration` was omitted, or send `duration` explicitly.
  - Add a test for each case.

### M2. Resolution is not cost-capped
- Location: `worker/src/mcp-server.ts:261-264` accepts any `\d{3,4}p|2k|4k`.
- Problem: resolution is a cost multiplier on most video models (1080p/4k vs 720p), similar to duration and output count, yet only those two have operator caps. Issue #55 requires "limits on … spending".
- Fix: either add `MULTIX_MCP_MAX_RESOLUTION` (or an allowlist), or restrict the enum to `480p|720p|1080p` by default.

### M3. Issue #55 acceptance criterion 2 is unmet: there is no credential-gated live smoke test
- Evidence: every worker test uses mocked fetch (`worker/test/*.ts`). There is no env-gated live test, and the PR states the Worker "has not been deployed".
- Issue #55 AC2 asks for "mocked CI coverage and a credential-gated live smoke test". AGENTS.md allows such tests behind an explicit opt-in.
- Fix: add an opt-in test, e.g. `MULTIX_MCP_LIVE=1` plus the URL and token. It should run `tools/list`, plus one cheap image call with `wait_seconds` and one video start and status call. Do not print keys.
- Alternative: record the decision on the issue and leave #55 open for that criterion.

### M4. The shared Cloudflare `output: null` change alters CLI behavior without a CLI test
- Location: `src/providers/cloudflare/video-client.ts:80-81`.
- Before this PR, `null` output was rejected as "invalid video output". Because Replicate returns `null` while a job runs, CLI polling of a running Cloudflare video threw. The change is a correct bug fix and inside scope (shared code), but no file under `tests/` changed.
- The rest of the refactor preserves behavior: same URL, same headers, `collectLogPayload` still env-driven in `client.ts:97-105`, and `Prefer: wait` is still sent only on create.
- Fix: add a CLI-side test, e.g. `tests/providers/cloudflare*.test.ts`, asserting that a poll returning `{status:"processing", output:null}` continues instead of throwing.

## Low Priority

### L1. `MULTIX_MCP_ALLOWED_ORIGINS` cannot work for real browsers
- Location: `worker/src/http-guards.ts:31-34`, `worker/src/index.ts:71-79`.
- There are no CORS response headers, and an `OPTIONS` preflight carries no `Authorization`, so it gets a 401. An "allowed" browser origin therefore can never complete a call.
- This is safe: it fails closed, and cross-site requests are already blocked by the preflight. But the docs (`mcp-server.md:128`) imply browser support.
- Fix: either document the variable as DNS-rebinding defense only, or add a pre-auth `OPTIONS` handler that returns CORS headers for listed origins.

### L2. The rate limiter is coarse
- Location: `worker/wrangler.jsonc:13`.
- `namespace_id: "1001"` is hard-coded. A deployer who already uses 1001 for another Worker on the account will share counters with it.
- The Workers rate limiter is per-location and eventually consistent, while the docs say "60 requests per minute per client IP" as if exact.
- Requests without auth from a shared NAT IP can drain a legitimate client's bucket.
- `cf-connecting-ip` cannot be spoofed in production, so keying on it is fine.
- Fix: tell deployers to choose a unique `namespace_id`, and describe the limit as approximate.

### L3. `/health` returns the exact version
- Location: `worker/src/index.ts:117`. It is a minor fingerprinting aid. It is documented and was accepted in the issue ("`/health` may be public"). Optional fix: drop `version` or put it behind auth.

### L4. Cloudflare video requests have no timeout
- Location: `src/providers/cloudflare/video-client.ts:65-69`. `send()` passes no `AbortSignal`, unlike `fetch-json.ts:72`, which uses 120s. A hung gateway call holds the Worker request until the platform limit.
- Fix: `signal: AbortSignal.timeout(...)` with an injectable timeout.

### L5. SDK pinned to 1.30.1, inside the GHSA-6qxp-vccf-f47h range
- Location: `worker/package.json:16`. The advisory covers 1.12.0–1.30.1 and is fixed in 1.31.0. It affects the OAuth client over HTTP, not the server or transport, and the worker imports only server modules, so it is not exploitable here.
- `npm audit` will stay noisy. Track the bump to ≥1.31.0 in an issue.
- Note: the brief I was given mentioned `agents` 0.28.0, but the branch does not use `agents`. It uses `WebStandardStreamableHTTPServerTransport` directly instead of Cloudflare `createMcpHandler()`, which #55 suggested. This is an acceptable deviation (stateless, fewer deps), but say so on the issue.

### L6. The bundle check is heuristic
- Location: `worker/scripts/check-bundle.mjs:10`. The `fs` regex matches any `"fs"` string literal (false-positive risk). It checks only `fs` and `child_process`, not other `node:` modules.
- Mitigation: without `nodejs_compat`, wrangler's build already fails on unresolved `node:*` imports.
- Optional fix: scan for `/["']node:[a-z_/]+["']/` generally.

### L7. Provider error text is logged at warn level
- Location: `worker/src/mcp-server.ts:145-152`. The scrubbed provider error text goes to `detail`. Provider moderation errors can echo prompt fragments, while the docs say "Prompts are never logged".
- Fix: log only the error class and status, or soften the docs claim.

## Edge Cases Found by Scout (verified as non-issues)
- **IP literals in `image_url`.** WHATWG URL parsing turns decimal, hex, octal and short-form IPv4 into a dotted quad, and `isIpLiteral` catches that. IPv6 always starts with `[`. Trailing dots are stripped. Single-label hosts are rejected. Ports, credentials and non-https schemes are rejected. Tests cover `2130706433`, `[::1]`, `169.254.169.254` and `file://` (`worker/test/mcp-tools.test.ts:409-430`).
- **Remaining SSRF exposure.** DNS-rebinding names (e.g. `127.0.0.1.nip.io`) and provider-side redirects remain. The docs correctly say these sit at the provider's network boundary, and the providers do the fetching, not the Worker.
- **Header and path parsing.**
  - `Basic`, a missing scheme, and multi-token `Authorization` values all give 401.
  - Path matching is exact: `/mcp/` and `/%6dcp` both give 404.
  - `Origin: null` (the string) is rejected unless it is listed.
- **Body cap.** A missing or bogus `Content-Length` is still bounded by the streaming read (`http-guards.ts:44-68`).
- **Model allowlist.** Matching is exact on `provider:model`. Case changes, `owner/name:version` variants and bare version hashes of unlisted models are rejected. Default models are also checked (`mcp-server.ts:99-110`).
- **Status and cancel.** Prediction IDs are restricted to `[A-Za-z0-9_-]{1,128}`, which blocks path injection into provider URLs. Status and cancel respect the provider allowlist.
- **Error output.** Unexpected exceptions go to the client as a generic message. Expected errors are scrubbed of configured secrets (≥8 chars), bearer tokens and URL query strings, then truncated to 600 chars.
- **Concurrency.** A fresh `McpServer` and transport are created per request, and there is no module-level mutable state. No race found.
- **npm package.** `files` is a whitelist (`dist`, `skill`, README, LICENSE, CHANGELOG), so `worker/` never ships. The root `tsconfig` (`src/**`) and root vitest (`tests/**`) exclude `worker/`. `.gitignore` covers `.wrangler/`, `.dev.vars`, and nested `dist/` and `node_modules/`.
- **Secrets in config.** `wrangler.jsonc` contains only non-secret vars. `.dev.vars.example` holds empty placeholders.
- **CI matrix.** The new job is Ubuntu-only. Root jobs on Windows and Ubuntu are green and unaffected. `readdirSync({recursive})` needs Node ≥ 20.1, which holds on the Node 22 job.

## Scope
Nothing goes beyond #55 except the Cloudflare `output: null` fix (M4). That fix is a necessary shared-code correction for the Worker's status polling and is fine to keep, but it needs a CLI test. The "small Cloudflare provider changes" are a faithful extraction into the runtime-neutral `video-client.ts` and `model-ids.ts`, as AGENTS.md requires.

## Positive Observations (risk calibration only)
- The auth and fail-closed design, the ordering (503 → Origin → rate limit → auth → method) and the error scrubbing are better than typical. They do not need rework.
- The docs are honest about the single-tenant spend model.

## Recommended Actions
1. Fix H1 (`captureStackTrace` typing) and get the `MCP Worker` job green. Attach the run.
2. Reject JSON-RPC batch arrays in `handleMcp` (H2), with a test.
3. Always send an explicit capped `duration` for the fixed-model adapters, and fail closed in Atlas when the spec is unavailable (M1).
4. Add a resolution cap or allowlist (M2).
5. Add the opt-in live smoke test, or record the deferral on #55 (M3).
6. Add a CLI test for `output: null` polling (M4).
7. Clean up L1–L7 as follow-ups, either in this PR or as new issues per AGENTS.md.

## Metrics
- Type coverage: strict TypeScript, no `any` in the worker source. The worker typecheck fails in CI (H1).
- Test coverage: 43 worker tests (author's local run; not reproduced here). No CI run reached the test step.
- Linting: root lint jobs green on all four OS/Node combos.

## Unresolved Questions
- Should the Worker keep its own Node-free tsconfig for `src/` (no vitest types), so the "no Node APIs" claim is enforced by `tsc` and not only by wrangler?
- Does the maintainer accept the SDK transport instead of `createMcpHandler()` (from `agents`) as #55's chosen architecture?
- Should the default `wrangler.jsonc` ship with a conservative `MULTIX_MCP_ALLOWED_MODELS` instead of "any model"?

Status: DONE_WITH_CONCERNS
Summary: Request changes. Critical 0, High 2 (CI job red on typecheck; JSON-RPC batching multiplies the rate limit and spend 100x), Medium 4 (duration cap bypass when duration is omitted or the Atlas spec fetch fails; uncapped resolution; missing live smoke test from #55 AC2; CLI behavior change without a test), Low 7.
