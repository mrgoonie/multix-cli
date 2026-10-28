# TopView native provider (issue #413, part B): implementation report

## Executed phase
- Scope: TopView provider in `src/providers/topview/**`, tests, and the budget delegation in `src/budget/command-cost.ts`.
- Branch: claude/gracious-heisenberg-kchf79. Nothing was committed, pushed or switched.
- Status: DONE_WITH_CONCERNS. The concerns are wiring the controller owns, plus two usage-extract gaps.

## Files
Created under `src/providers/topview/`:
- `models.ts` (208 lines): routing, kinds, status normalization and URL safety. Its header cites the reference pages that replace the marketing paths.
- `types.ts` (173 lines)
- `client.ts` (622 lines): the legacy client for credits.
- `platform-models.ts` (778 lines): the verified registry with its schemas, the body builder and the validator.
- `platform-client.ts` (468 lines): the API Platform client for USD.
- `cost.ts` (354 lines): `estimateTopviewCommand`.
- Node-only files: `node-client.ts` (48), `node-inputs.ts` (143) and `node-outputs.ts` (127).
- `commands/`: `index.ts` (registers `registerTopviewCommands`), plus `task-flow.ts`, `marketing.ts`, `video-avatar.ts`, `product-avatar.ts`, `product-anyshoot.ts`, `status.ts`, `account.ts` and `platform.ts`.

Created under `tests/unit/providers/topview/`:
- `fake-topview.ts`
- `client.test.ts`, `platform-client.test.ts`, `platform-models.test.ts` and `cost.test.ts`.
- `commands.test.ts`
- `runtime-neutral.test.ts`
- `live.test.ts`, gated by `MULTIX_LIVE_TOPVIEW=1` plus the keys. It is read-only.

Also created: `tests/unit/budget/topview-estimate.test.ts`.

Modified: `src/budget/command-cost.ts`. It imports the estimator, adds `topview generate` to `pricedCommands()`, and delegates `topview *` before the generic builders.

## Behaviour summary
**Legacy API (credits)**
- Every request sends Bearer auth plus `Topview-Uid`. The `{code,result}` envelope is checked, and documented codes are mapped.
- Submits are never retried. A submit that may have created a task anyway (5xx, network error, 5xxx code, unusable 2xx) carries a dashboard warning.
- Polling retries 408/429/5xx and envelope codes 5000, 5001, 5003 and 5004.
- Uploads run credential, then a PUT to a safety-checked URL without the key, then check.
- Commands:
  - `url-to-video` and `materials-to-video` use `/v1/m2v/task/submit`.
  - `export` uses `/v1/m2v/export` and judges success by the export entry.
  - `video-avatar`.
  - `product-avatar`: remove-background, then V3 image_replace, then image2Video. Each step logs its id and a resume flag. A `faceExistence=false` result with a mode other than avatar2 stops with a resume hint.
  - `product-anyshoot` uses `/v1/product_anyShoot`.
  - `upload` and `credits`. `credits` shows balance only; the API keys in the response are dropped.

**API Platform (USD)**
- `models` and `generate`.
- The request is validated against the published schema and the per-mode rules before anything is uploaded or sent.
- Each request carries an Idempotency-Key. The same key and body are re-sent on 408/429/5xx, honouring Retry-After. 402 and other 4xx are never retried.
- When retries run out after an ambiguous failure, the error tells the user to rerun with `--idempotency-key <key>`.
- `payment_required` stops polling, with the amount due and a top-up and resume hint. `failed` exits non-zero.

**Shared**
- `status <kind> <id>` with `--wait` / `--download`.
- stdout carries only the result; hints go to stderr.
- Summaries redact signed URLs. Downloads are https-only and safety-checked on every hop.
- All user-supplied URLs must be http(s), carry no credentials, and pass `checkUrlSafety`.

**Cost**
- Legacy commands are unknown/null (`credits_only`), so `--max-cost` fails closed.
- `generate` is priced from the verified table:
  - "proven" only when the model does not bill measured usage and the request fixes every billed unit (resolution, duration, images).
  - "estimated" for seedance and gpt-image, for automatic duration, and for open wan settings.
  - Unknown (never $0) for a missing or unknown model, a stale price, an unpriced resolution, or invalid input.

## Tests
- `npx vitest run tests/unit/providers/topview tests/unit/budget`: 12 files passed, 260 tests passed, and the 2 live tests were skipped.
- `npm run typecheck`: clean. The test files also typecheck under a temporary config.
- `npm run lint`: clean.
- `npm run build` succeeds.
- Full `npx vitest run`: 2580 passed and 2 failed. Neither failure is a regression in TopView code:
  - `tests/unit/project-env-names.test.ts` reports `TOPVIEW_UID` as unaccounted. This needs controller wiring.
  - `tests/unit/commands/image-format-preflight.test.ts` expects 20 commands and finds 21. That extra command comes from the Sume commands now registered in `src/commands/index.ts`; TopView is not registered there and offers no `--image-format`.
- `npm run check:mcp` was not run because `worker/node_modules` is absent. `cost.ts` and everything it imports pass the runtime-neutral import-graph test, and `worker/src/jobs/job-tools.ts` reaches it through `command-cost.ts`.

## Concerns for the controller
1. **Wiring (files I may not touch).**
   - `src/commands/index.ts` needs `registerTopviewCommands`.
   - `src/providers/provider-keys.ts` and `src/project-env-names.ts` need `TOPVIEW_ROUTING`, `TOPVIEW_PLATFORM_ROUTING` and `TOPVIEW_UID_ENV`.
   - `src/commands/check.ts` and `check-helpers/setup-hints.ts` need the three keys: `TOPVIEW_API_KEY`, `TOPVIEW_UID` and `TOPVIEW_PLATFORM_API_KEY`.
   - `.env.example`, `README.md`, docs-site (en and vi) and `skill/SKILL.md` need updating.
   - `src/capabilities/command-capabilities.ts` needs the commands. The task-serving ones are url-to-video, materials-to-video, export, video-avatar, product-avatar, product-anyshoot and generate; status, upload, credits and models are utilities.
   - The worker catalog needs regenerating.
2. **usage-extract does not record `charged_usd`.** I checked this against the current `src/core/usage-extract.ts`. A completed prediction (`{code:200,data:{charged_usd:"0.8245",...}}`) yields only `ids:["pred1"]`, with no cost. `charged_usd` is a decimal string.
3. **usage-extract misreads the legacy credit balance as spend.** The `/user/credit/detail` response produces `credits:42` from `result.remainCredit`, which is a balance, plus `apiKeyMap[].costCredit` as a metric. Credits from a task query (`result.costCredit`) are read correctly. The credits command should probably be excluded or treated as balance-only.
4. **Estimator limits.**
   - A positional model (`topview generate <model>`) is invisible to the estimator. Agents and MCP callers should pass `--model`.
   - `PriceMeter` has no video-seconds or images meter, so `units` is `{}` and the detail lives in `assumptions`.
5. **Unverified details, handled defensively.**
   - The video-avatar status values. Status parsing is lenient, and unknown values stay non-terminal.
   - The m2v `videoDuration` unit.
   - The background-removal credit cost.
   - The m2v export timing.
   - The gpt-image-2 edit price table, which conflicts with the schema. I followed the schema.

Status: DONE_WITH_CONCERNS

## Test fixture keys
The fake keys are `test-topview-key-NOT-A-SECRET` and `test-topview-platform-key-NOT-A-SECRET`. No fixture in the TopView tests matches a real secret format (sk_live_, sk_test_, ghp_, AKIA, xoxb- or long hex).
