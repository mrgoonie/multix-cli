# Review fixes: Sume and TopView providers

Source review: `plans/reports/code-reviewer-261028-0945-sume-topview-providers.md`. Nothing committed.

## Changes

1. **Sume submit usage is a reservation, not spend.**
   - `src/agent/run-state.ts`: new `postAmountsReserved` flag. When it is set, POST responses keep their amounts in `metrics` but never count as `cost_usd` or credits. `runGeneration` in `src/providers/sume/commands/job-flow.ts` sets it, so the change affects only `sume image` and `sume video`. No other provider's receipt changes.
   - `src/core/usage-extract.ts`: a `usage_summary` object is a hold while its `status` is `reserved`. Once the status is `captured` or `refunded`, `captured_usd_cents` / 100 counts as `cost_usd`. When a body contains a usage summary, amounts elsewhere in that body are not counted.
   - `src/providers/sume/client.ts` and `types.ts`: `parseJob` now exposes `charge {status, capturedUsd}`.
   - `completeJob` (used by `--wait` and `status --wait`) and `sume status` of a completed job call `GET /v1/jobs/{id}` (best effort) to record the captured charge, and log "Sume charged $X".
   - Results:
     - A failed or canceled job reads a refunded summary, so it settles at $0.
     - A run that only submits gets `actual_usd: null` with status `unknown`.
     - A later status run settles the operation through `settleOperations`.
   - The submit log line now reads "reserved $X, charged only if it completes".
   - The reserved fixture now uses the documented `*_usd_cents` fields.
2. **`topview run` keeps its key on interrupt.**
   - `src/providers/topview/commands/run.ts` generates the key (`randomUUID`), or takes it from `--idempotency-key`, before the request.
   - It wraps the submit in `exitOnInterrupt`, which prints the key with `platformOrphanHint`, newly exported from `platform-client.ts`.
3. **Legacy paid submits are never resent.**
   - `src/providers/topview/legacy-client.ts`: the 429 retry loop is removed.
   - `src/providers/topview/errors.ts`: a 429 now gets the Legacy orphan hint.
   - GET polling still retries transient failures.
4. **`sume estimate` is a free quote.**
   - `src/budget/command-cost.ts`: new `isFreeCommand`. Its estimate is a proven $0, so `--max-cost` passes.
   - `src/budget/cost-receipt.ts`: new `free` input. Its requests make the receipt an observation, so no `cost_unknown_ops` is added.
   - `src/agent/cost-preflight.ts` passes `free` through.
   - Other free lookups (`openrouter generation`, `topview credit`) are GETs and were already observations.
5. **`src/providers/sume/cost.ts`** prices only `image(s)` for image runs and `second(s)` for video runs. Any other unit gives an `unknown` estimate with reason `unsupported`.
6. **`worker/src/jobs/cli-command-policy.ts`**: added `topview product-anyshoot` `caps: { count: ["count"] }`.
   - TopView has no duration flag in seconds. m2v's `--video-length-type` is a range code, so no duration cap was added.
   - `npm run catalog` left `cli-catalog.json` unchanged.
7. **`tests/unit/core/usage-extract.test.ts`**: added regression tests for other providers' bodies:
   - an OpenRouter body with numeric `usage.cost` (exact full output);
   - fal and Replicate metrics, with no cost;
   - a cost next to a non-summary `status: "reserved"`;
   - remaining credits versus spent credits;
   - numeric `charged_usd` with and without a hold;
   - a charge summary.

**Docs** (English and Vietnamese):
- `commands/sume.md`, "Costs, refunds and limits": the reservation is logged but not counted, the captured charge is reported once the job completes, refunded jobs record nothing, and the quote is free.
- `commands/topview.md`: covers the run key on interrupt, and that Legacy never retries, including on 429.
- `guides/mcp-server.md`: the `product-anyshoot --count` cap.

## Tests added
- `tests/unit/providers/sume/receipt.test.ts`:
  - a completed job, captured once;
  - failed and canceled jobs, refunded and settled at $0;
  - a submit-only run, unknown;
  - a job still holding its reservation;
  - `sume estimate` with a proven $0 and an observation receipt.
- `tests/unit/providers/sume/commands.test.ts`: `sume status` reads the captured charge.
- `tests/unit/providers/sume/catalog-cost.test.ts`: units it cannot count give an unknown estimate.
- `tests/unit/providers/topview/commands.test.ts`: SIGINT during the submit prints the key, and a rerun with `--idempotency-key` sends the same key.
- `tests/unit/providers/topview/legacy-client.test.ts`: a 429 is sent once, with no sleep, and gets the orphan hint.

## Verification
All of these passed:
- `npx biome check src tests worker/src worker/test`
- `npm run typecheck`
- `npm run build`
- `npm test`: 2558 passed, 22 skipped.
- `npm run check:mcp`: worker 394 passed, bundle clean.
- `npm run verify:docs`: 0 errors.

## Open points
- The capture path assumes `usage_summary` sits on `GET /v1/jobs/{id}` under `data.job` or `data`, as the researcher report documents. No keyed probe has confirmed it. If the summary is missing, the cost stays unknown and is never wrongly settled.
- Not addressed, because they were outside the requested items:
  - review item L3 (credit dedup across runs);
  - the remaining M2 decisions: sume video billed by input length, and an explicit `--num-images` default.
