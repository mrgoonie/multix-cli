# Code review: Atlas 3D pricing (issue #597)

- Commit: c101819 `feat(atlas): price 3D runs from Atlas Cloud's live price list` (branch `claude/relaxed-clarke-9not2t`, diff `origin/dev...HEAD`)
- Scope: 22 files, about 1,167 lines added and 34 removed. Read every changed file in `src/`, plus the EN/VI docs, README and skills.
- Reviewer: isolated; did not write the code. No source files edited.

## Verification run

- `npx vitest run tests/unit/providers/atlascloud/pricing.test.ts`: 18/18 pass.
- Worker: `npm run typecheck` and `npm run check:bundle` pass (bundle is clean, so `pricing.ts` stays runtime-neutral). Worker `npm test`: 773/773 pass.
- Ran `estimateAtlas3dCost` and `buildCostReceipt` against Atlas's real public responses for `GET /pricing/models` and `GET /models` (free GETs; scratch script, no paid calls). Also ran `extractUsage` on both bodies. The telemetry finds no stray `cost`, credits or ids in them, so the price-list GETs cannot inject a cost the provider supposedly reported.
- Ran `dist/cli.js` (built at the commit) with an empty `HOME` and `--dry-run` to check what a dry run reports.

## Findings (ranked)

### High

**H1. The receipt shows a list price as `computed` actual cost even when the estimate itself says the price is not pinned.**
`src/agent/cost-preflight.ts:262` (`listPrice`) only checks `low_usd === high_usd`. It ignores the estimate's `unpinned` settings, a failed narrowing, and `quoted_at_run`. `src/budget/cost-receipt.ts:210` then reports it as `status: "computed"`.
Concrete case, checked against the live price list: `atlas run meshy-v7/text-to-3d --input '{"prompt":"x","mode":"refine","ultra_mode":false}'`. The estimate gives low = expected = high = $0.66. Its assumptions include "Atlas's listed rows do not pin mode; the final price may differ." The receipt still reports `actual_usd: 0.66, status: computed`. Meshy's refine pass is a different billable step, so the receipt states a specific actual cost that the estimate in the same receipt disclaims.
Fix: attach `list_price` only when the estimate has no unpinned settings and narrowing matched. The simplest gate is to have `estimateAtlas3dCost` export an explicit `exact` flag (or put it in `units`/`rate`) and have `listPrice` require it. For `quoted_at_run` models, think about a non-`computed` status (for example `estimated`), because Atlas re-quotes at submit. At minimum, the receipt's reason should say the amount is the listed price, not a billed amount.

**H2. A proven ceiling and a `computed` receipt can come from a configuration the request does not ask for.**
`src/providers/atlascloud/pricing.ts:252`: when no row matches the request's settings, `rows` falls back to all rows and only an assumption is added. With one row (or several rows at the same price), `low === high`. The mismatched key is pinned by a string row value, so it does not count as `unpinned`, which makes `exact` true. For a model that Atlas does not re-quote, `upper_bound` becomes `"proven"` (line 282), so `--max-cost` passes under the strict policy.
Reproduced with a synthetic entry: rows `[{settings:{mode:"a"}, usd:1}]`, `quoted_at_run:false`, input `{mode:"b"}`. Result: `upper_bound: "proven"`, and the receipt reports `computed $1`. Today's live data has no single-row model with settings, so this is latent. But it breaks the stated rule that "proven" means a single price Atlas does not re-quote for this request. The guard has to stay sound when Atlas changes its list.
Fix: if `set.length > 0 && narrowed.length === 0`, force `upper_bound: "estimated"` and do not attach `list_price`.

**H3. `atlas 3d` / `atlas run <3d>` with `--dry-run` reports the price-list GET instead of the generation request.**
`src/agent/cost-preflight.ts:197,203` fetch the price list through the global `fetch`. During `preAction` that is already the telemetry wrapper, and in a dry run the wrapper exits on the first request (`fetch-telemetry.ts:112`).
Reproduced with an empty cache:
`HOME=$tmp node dist/cli.js atlas 3d "a chair" --no-validate --dry-run --json` gives `"request":{"method":"GET","url":"https://api.atlascloud.ai/api/v1/models"}`.
The same happens for `atlas run tencent/hunyuan3d-rapid/text-to-3d --type image --no-validate --dry-run`. A non-3D `atlas run` still shows the real `POST .../generateImage` with its body.
Without `--no-validate`, the schema GET already masked the POST, so the visible regression is the `--no-validate` path. Either way, the request shown is now the price list, not provider work. The fetches are also recorded in `run.calls` on real runs. As a result, a validation failure before submit (for example `atlas 3d` with no prompt and no `--ref`) now produces an `observation`/`unknown` receipt where it used to be `settled $0 no_request`, and the price-list GETs inflate `http.requests` / `http.errors` in the envelope and history.
Fix: skip the network read in a dry run (use `cacheOnly`, or skip unasked pricing when `run.dryRun`). Also call the price list with the original, unwrapped fetch (pass `fetchFn` captured before `installFetchTelemetry`), so preflight reads never count as the run's provider calls.

### Medium

**M1. A `--async` submit reports the full list price as `computed` actual cost for a job that has not finished.**
`cost-receipt.ts:210` keys on `outcome === "ok"`. `atlas 3d --async` / `atlas run <3d> --async` exit 0 right after the POST. Atlas does not charge failed tasks (the estimate even says so), so if the job later fails, the receipt still reports, for example, $5.185 spent. The resume (`atlas status --wait`) is an `observation`, so nothing corrects it.
Fix: do not attach `list_price` when `run.options.async` is set (keep `unknown`, or use a pending/estimated reason). The docs line "After a successful run, `cost.actual_usd` is that list price" should say that it applies to a run that waited for the result.

**M2. `actual_source: "computed_from_usage"` is wrong for list-price receipts.**
`cost-receipt.ts:213`. Nothing was measured, but consumers (history, spend aggregation, agents) cannot tell a metered computation from an assumed list price. Add a distinct source (for example `"list_price"`) to the receipt schema, or document the overload. Adding a source is a schema-visible change, so handle it deliberately.

**M3. `expected_usd` often prices a configuration the request explicitly excluded.**
`pricing.ts:268`: when settings are set, `expected = price.default_usd` (clamped to `high` if it falls outside the range). The default row's values are never used for the settings the request leaves unset. Checked against the live list:
  - `tripo-h3.1/text-to-3d` with `{texture:false}`: expected $0.22. That is the `texture:true` default price; the correct value is $0.11 (the other settings at their defaults). The range is 0.11 to 0.385.
  - `meshy-v7/image-to-3d` with `{should_texture:false}`: expected $0.55 (the ultra-mode price); the correct value is $0.44.
  - `tencent/hunyuan3d-pro/text-to-3d` with `{generate_type:"Normal", enable_pbr:true}`: expected $0.90 and high $0.90. Without a custom face_count the price is $0.70.
  - Fix: fill each unset setting from the row whose `usd === default_usd` (the default configuration), then narrow. Keep the full range only for settings that are genuinely unpinned. The ceiling (`high`) stays safe as it is; this is about the quality of the expected value, which `--cost-policy estimate` agents rely on.

**M4. The new receipt reason for failed `observation` runs is wrong for status and resume commands of every provider.**
`cost-receipt.ts:222` now says "Only read requests were sent before the run failed; it submitted nothing, so it was not billed." That is fine for `atlas 3d` failing after the schema/price GETs. But it applies globally: a failed `atlas status <id> --wait` (or another provider's status/poll command) gets this text for a job that was submitted, and possibly billed, in an earlier run. It is also scope creep beyond Atlas.
Fix: word it as "This run sent only read requests and started no paid work", or scope it to runs whose command is a submit command.

**M5. Docs overstate catalog coverage.**
`docs-site/src/content/docs/commands/catalog.md:43` (and the VI copy) says "other views use a cached copy when there is one". In fact only `providers`, `models` and `show` take the cards (`catalog-command.ts:186-297`). `compare`, `recommend`, `quote` (via `selected()`), `rate`, `review` and `note add` (`buildOfferings()` at :195, :463, :617) never see Atlas 3D offerings. For example, `catalog compare --task 3d` returns `rows: []` even though Hi3D has list prices, and `catalog rate atlas:hi3d/v3.0-master/image-to-3d 5` cannot resolve an offering that `catalog models --task 3d` shows.
Fix: either pass the cached cards in those views too, or correct the docs to list exactly which views include Atlas 3D.

### Low

- **L1. Every unasked `atlas 3d` run blocks on the price list when the cache is cold or expired** (`cost-preflight.ts:197`). That is two parallel GETs of about 2.2 MB, each with a 20 s timeout. When the read fails nothing is cached, so every later run waits again; this also happens before the missing-key error appears. Consider a short negative cache, or making unasked pricing `cacheOnly` and letting only `--estimate`/`--max-cost` fetch.
- **L2. Cached `price` objects are not validated on read** (`model-discovery-cache.ts:57` checks only provider and model). A hand-edited or older/newer-shaped `atlas-3d.json` with `price.rows` missing makes `estimateAtlas3dCost` throw `TypeError` at `price.rows.length` (`pricing.ts:226`). That is an unclassified crash of every `atlas 3d` run until the cache expires. Validate `price.rows` as an array of `{usd:number}` in `readAtlas3dCatalog` consumers, or treat a malformed entry as no price.
- **L3. A stale snapshot's `error` is carried along but never shown in the estimate's assumptions.** The user is not told that the refresh failed and a cached copy of up to 7 days was used. Only `rate.last_checked` hints at it.
- **L4. Over MCP, `estimateCommand("atlas 3d")` now returns `no_price` with a CLI-only hint** ("run `multix models --task 3d --live --refresh`"). `atlas run` returns `missing_input` because the worker has no positional model. Both refuse correctly, but the text points MCP users at commands they cannot run. Consider an MCP-neutral message when `prices` is absent.
- **L5. `atlas 3d` sends `--format` and `--seed`, yet the estimator assumes it "sets none of the settings the price depends on"** (`pricing.ts:263`). That is true for today's `pricing_params`, but nothing enforces it. Passing the built body (format/seed fields) as `input` would keep it correct if Atlas starts pricing by format.
- **L6. `--input @file` is read twice** (preflight, then the action). A file changed in between would be priced and sent differently. This is negligible in practice; reusing the parsed body (as `run.textFile` does for speech) would close it.

## Checklist notes

- Concurrency: parallel runs with a cold cache each refetch and rewrite the cache; the writer was already in place, so nothing new.
- Async preAction: `src/cli.ts` uses `parseAsync`, so awaiting the hook is correct. `preflightCost` has no other caller in `src/`, and the two test callers were updated. Non-Atlas commands never touch the network; for an unasked `atlas run` with a non-3D id, the `-to-3d$` gate holds (every live 3D id ends in `-to-3d`).
- Runtime neutrality: `pricing.ts` imports `node:*` only through types; the worker bundle check passes.
- Trust boundary: price strings are filtered of control characters and limited to a numeric pattern; `usd()` refuses negatives. Catalog views are fine; each fetch is limited to `--task 3d` or a `-to-3d` show.
- Tests: there are no tests for `--dry-run`, `--async` receipts, a failed narrowing, or unpinned plus a single price in a receipt. The current suite would not catch H1, H2, H3 or M1.

## Recommended actions (in order)

1. Gate `list_price` on an exact estimate (no unpinned settings, narrowing matched) and on runs that did not use `--async` (H1, H2, M1).
2. Make a failed narrowing never `proven` (H2).
3. Read the price list with the unwrapped fetch, and skip it in dry runs (H3).
4. Base expected values on the default row (M3), and fix the observation reason wording (M4).
5. Correct the catalog docs, or wire the cards into compare/recommend/rate (M5). Add tests for items 1 to 3.

## Unresolved questions

- Does the product want `computed` receipts for models Atlas re-quotes at submit (`quoted_at_run`)? The issue asks for `cost.actual_usd`, but labelling a re-quoted price as computed is a judgment call for the owner.
- Should `catalog compare --task 3d` rank Hi3D's list prices? Right now it silently omits them.

## Resolution (author, after review)

- **H1 – fixed.** A receipt carries the list price only when the estimate names one price for exactly the request's settings: no unpinned or unmatched setting (`exactAtlasListPrice`) and not an `--async` submit. Otherwise `actual_usd` stays `null`.
- **H2 – fixed.** When narrowing fails, the result is never `proven` and is never used as a list price.
- **H3 – fixed.** The price list is read with the unwrapped fetch (`untrackedFetch`), so it is not counted in `run.calls` and not shown by `--dry-run`. A dry run reads only the cache. Verified: `atlas 3d "a chair" --no-validate --dry-run` with an empty cache shows `POST /model/generateImage`.
- **M1 – fixed.** `--async` submits report no list price.
- **M2 – fixed.** Added a new `actual_source: "list_price"` and documented it (EN and VI).
- **M3 – fixed.** Expected price now comes from the row that keeps unset settings at the model's defaults. Example: meshy with `{should_texture:false}` gives expected $0.44.
- **M4 – fixed.** The reason is now provider-neutral: "The run failed after sending only read requests; it submitted no billable work itself."
- **M5 – fixed.** The catalog docs now state which views include Atlas 3D, and that `compare`/`recommend` do not yet.
- **Low items:**
  - Malformed cache: guarded with a test.
  - A stale copy that could not be refreshed: now noted in the estimate.
  - MCP hint: made neutral.
  - The `atlas 3d` assumption: checked against the live list. `format` and `seed` are not price parameters.
  - Cold-cache wait and the double `--input` read: accepted as is.
- **Open questions:**
  - Re-quoted models with an exact default price still get a `computed` receipt; the reason names the list price.
  - Ranking Hi3D in `compare` is left for a follow-up.
