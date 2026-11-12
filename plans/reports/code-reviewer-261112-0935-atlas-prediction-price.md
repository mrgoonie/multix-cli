# Code review: Atlas prediction `data.price` as actual cost (#602)

Commit: 1efcdf2 `fix(atlas): report the prediction's data.price as the actual cost`
Scope: src/core/usage-extract.ts (+31), tests (unit, smoke, fixture), docs-site EN+VI (atlascloud.md, for-ai-agents.md), skill/SKILL.md.

## Verdict
No blocking defects. Behavior matches issue #602's expected outcome. Three low-severity notes.

## Verification
- `npx vitest run tests/unit/core/usage-extract.test.ts tests/unit/providers/atlascloud tests/smoke/budget-guard.test.ts`: 187 passed, 2 skipped (skips are outside the new tests; the Atlas smoke test ran and passed).
- `npx biome check` on touched files: clean. `npx tsc --noEmit`: clean.
- Manual run against the smoke fixture (scratchpad ledger): `atlas run` (charge, settled 0.66) + two `atlas status pred-3d-1` (observation, settled 0.66), all `operation_id atlas:pred-3d-1`. `multix history stats` -> `cost_usd=0.66 credits=30` (counted once, not 1.98).
- `worker/` does not import usage-extract, so `check:mcp` is not affected.
- `npm run verify:docs` not run (docs-site deps not installed in this review).

## Checks requested
- False positives on other providers: searched src/providers/** for `price` in response shapes. Only Atlas (`AtlasPrediction.price?: string|number`) and TopView (`price` is an object; `num()` and the string branch both reject it) carry a `price` key; Sume has none (usage_summary only). Catalog/list responses (`/models`, `/pricing/models`) have `data` as an array, so `asRecord(body.data)` rejects them. No current false positive.
- Double counting submit+poll: POST submit returns `processing` (no price). If a sync-mode submit returned `completed`+price and a GET followed, `summarizeUsage` suppresses the POST cost because the GET for the same id reports cost_usd (run-state.ts:244-252). GET polls replace per job (fetch-telemetry.ts:343-351).
- Double counting with `atlas status` in `settleOperations`: status receipts are `observation` + `settled`, which set `op.reported` and replace the charge sum (cost-receipt.ts:342-381). Verified empirically above.
- Source path: `body.data.price`, prefixed with host by fetch-telemetry -> `api.atlascloud.ai body.data.price`; matches docs.
- Metrics: numeric price was already captured by `walk` (METRIC_KEY matches `price`); string price is not (decimalAmount requires a money word), so the explicit `metrics["data.price"]` assignment is needed and consistent.
- Interaction with `walk` loop: predictionPrice runs after walk and before the cost-selection loop, so the loop's `out.cost_usd === undefined` guards keep it; credits are still picked from `data.credits_consumed` and merged into `sources`.
- Success status set (`completed|succeeded|success`) matches `SUCCESS_STATUSES` in prediction-output.ts:16.

## Findings (all low)
1. src/core/usage-extract.ts:293-298 - not provider/host scoped. Any future provider whose JSON is `{data:{id:string, status:"success"|"completed"|"succeeded", price:<number>}}` with `price` meaning a unit/list price would be reported as a settled provider charge, and because it is assigned before the selection loop it also outranks that body's real cost keys (e.g. `data.usage.cost`, Sume-style `captured_usd_cents`) and ignores the `held`/`ESTIMATE_PATH`/`summarized` guards. No current provider matches (verified), so latent only. Option: gate in fetch-telemetry by host, or have predictionPrice run only when the loop found no cost.
2. tests/smoke/budget-guard.test.ts:383-386 - the history assertion is `toContain("0.66")`, which also passes if spend were double counted (0.66 appears per entry). A `history stats --json` total assertion (expect 0.66, not 1.32) would actually lock the no-double-count property. Manually verified correct today.
3. Docs scope (skill/SKILL.md:155, docs-site .../commands/atlascloud.md:112): the new behavior applies to every Atlas prediction (image/video/audio too), but it is documented only inside the 3D pricing bullet/sentence. Accurate, just incomplete for non-3D users. Also "stays null until atlas status reads the finished prediction" - the async submit receipt itself stays null; it is the operation (history) that settles. Minor wording.

## Docs accuracy
EN and VI pages changed in parallel with matching content. Claims checked against code: `settled`, `provider_reported`, `body.data.price`, list_price fallback only without a reported price (cost-receipt.ts:182-216), history shows spend (verified). The $0.02 vs $0.66 Meshy example matches the issue's reproduction table.

Status: DONE
Summary: Fix is correct; no false positives in current providers, no double counting across submit/poll or with `atlas status` (verified via history stats). Only low-severity latent/test/doc notes.
