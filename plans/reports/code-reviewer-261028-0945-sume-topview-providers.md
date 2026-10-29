# Code review: native Sume and TopView providers (commit b13d27d, issue #413)

Reviewer context: isolated reviewer that did not write the code. Base is b13d27d^.
Checks run: `npx vitest run tests/unit/providers/sume tests/unit/providers/topview` (pass), `npm run typecheck` (pass), `npm run lint` (pass), `npm run check:mcp` (pass, bundle has no node:* imports). No real provider APIs were called.

## Critical

None.

## High

### H1. Sume's reserved charge is recorded as settled spend, including for failed or canceled (refunded) jobs
- Where:
  - `src/core/usage-extract.ts:223` (`decimalAmount`), the cost branch at `:258-270`
  - `src/providers/sume/client.ts:269-287` (`parseSubmitted`)
  - `src/budget/cost-receipt.ts:171-173`
- What happens: the submit response `data.usage.usd` ("0.35") is a reservation. Sume refunds it when a job fails or is canceled, and the client says so itself at `client.ts:101`, while `job-flow.ts:245` logs it as "reserved". Even so, extractUsage counts the value as `cost_usd`. In `buildCostReceipt`, the `reportedUsd !== undefined` branch (line 171) comes before the `outcome === "failed"` branch (line 190), so the run gets `status: "settled", actual_source: "provider_reported"` whatever the job's outcome.
- Failure scenario:
  1. `multix sume video --model X --wait` is submitted and returns 202 with usage.usd "0.35".
  2. The job ends `failed`, and Sume refunds the charge.
  3. History and the receipt still record $0.35 settled spend.
  The same thing happens for a run without `--wait` whose job is later canceled with `sume cancel`, or fails afterwards. Spend reports and budget accounting then overstate real spend. That contradicts the commit message's claim "USD receipts from captured charges only".
- Test gap: `tests/unit/providers/sume/receipt.test.ts:95-123` covers only a completed job, and it asserts that the reservation is a settled spend. Nothing covers a failed or canceled job. The "reserved" fixture at `:38-45` uses `reserved_usd`, but the documented field is `reserved_usd_cents` (see researcher-261028-0902-sume-api.md), so it does not exercise the real response shape.
- Fix:
  - Treat the submit's `usage` as a hold. One option is to add `usage` under a submit-response path to `ESTIMATE_PATH`. Another is to have the Sume client expose it under a key named `reserved_*`.
  - Record spend only from the job's captured amount: `usage_summary.captured_usd_cents` / `captured_credits` from `GET /v1/jobs/{id}`, once the job is terminal and completed.
  - For a run without `--wait`, the receipt should be `uncertain` or estimated, not settled.
  - Add receipt tests for failed and canceled jobs, and fix the fixture to use the documented `*_cents` fields.

## Medium

### M1. `topview run` loses the Idempotency-Key when it is interrupted mid-submit
- Where:
  - `src/providers/topview/commands/run.ts:52-58`
  - the key is generated inside the client: `src/providers/topview/platform-client.ts:~247`
- Failure scenario:
  1. The user presses Ctrl-C, or the agent's timeout kills the process, while the POST is in flight.
  2. The Platform may have created and reserved the prediction, but the key was printed only on success or in the orphan-hint error, so the user never sees it.
  3. Re-running creates a new prediction under a new key and charges a second time.
  Sume's `job-flow.ts` already guards this case: it generates the key in the command and wraps the submit in `exitOnInterrupt` with `orphanHint(key)`. TopView's run command does not.
- Fix: generate the key in the command, pass it to `client.submit` (the client already accepts an override), and wrap the submit in `exitOnInterrupt(..., orphanHint)` the way Sume does. Add a test that interrupts the submit.

### M2. Remote MCP caps do not bound several paid TopView and Sume commands
- Where: `worker/src/jobs/cli-command-policy.ts:264-303`
- Gaps:
  - `topview product-anyshoot` (`:295`) has fileOptions but no cap on `--count`. `generatingCount` goes up to 4 and is billed per image.
  - `topview video-avatar` (`:291`) and the m2v commands have no duration or count caps.
  - `topview run` has no policy entry at all. There is precedent for this (`replicate run`, `fal run`), but it still means no caps.
  - `sume video` uses VIDEO_CAPS:
    - The default `--duration` that the worker fills in does not bound lipsync, video-to-video or captions models, which bill by input length.
    - A fixed default duration may also fail a model's `duration_values` check.
  - `sume image` has a count cap, but a model whose default `num_images` is above 1 (qwen-image-layered defaults to 2) bypasses it, because the flag is never sent.
- Failure scenario: a remote MCP caller runs `topview product-anyshoot --count 4` or a long `sume video` lipsync, and the spend exceeds `MULTIX_MCP_MAX_*` limits that the operator believes are enforced.
- Fix:
  - Add a count cap for `product-anyshoot`.
  - For sume video, either refuse models that bill by input length under the worker, or require `--max-cost` there.
  - Have the worker send an explicit `--num-images` within the cap.
  - At minimum, document which commands are uncapped.

## Low

### L1. TopView Legacy submit retries on HTTP 429
- Where: `src/providers/topview/legacy-client.ts:311-340`, the retry itself at `:332`
- Issue:
  - Legacy has no idempotency. The retry rests on the assumption that a 429 means nothing was created.
  - TopView's docs (researcher-261028-0902-topview-api.md) do not document a 429. A gateway or proxy 429 sent after the backend accepted the request would therefore cause a double charge.
- Fix: do not retry a Legacy submit at all. Surface the 429 with `withLegacyOrphanHint`. If the retry stays, cite the evidence for the assumption in the comment and add a test.

### L2. `sume estimate` is recorded as a "charge" with unknown cost
- Issue:
  - `sume estimate` is a POST, so its receipt role is "charge" and its cost is unknown.
  - That adds to `cost_unknown_ops` in history.
  - `--max-cost` refuses this free call with BUDGET_UNPROVEN.
- Fix: make it a known-free operation, for example a zero estimate in `command-cost.ts` or an observation role for this command.

### L3. Credits double-count across a submit run and a later status run
- Issue: a `topview status` or `sume status` run that later reads `costCredit` or captured credits for the same task adds credits that were already attributed to the submit run. History sums credits per run without deduplicating by task id.
- This pattern existed before the commit, but the new providers make it more likely.
- Fix: deduplicate credits by provider task id, as USD is already deduplicated by operation_id.

### L4. Global changes to usage-extract have no regression tests for other providers
- Where: `src/core/usage-extract.ts:49`, `:89`, `:133-149`, `:266`
- Changes with no regression test:
  - Decimal strings now count under money words.
  - `remain` replaces `remaining` in BALANCE_LEAF.
  - A `charged_usd` leaf from any provider now counts as cost.
  - `isHold` now applies to every body that has a `billing_state`.
- These apply to every provider, but only Sume and TopView fixtures cover them.
- Fix: add a small cross-provider regression table, for example OpenRouter, fal and Replicate bodies, each with its expected extraction.

### L5. `sume/cost.ts` ignores `pricing.unit`
- Issue: the price is the rate times the units derived from the flags, whatever the declared unit is. Today's catalog uses "image" for image models and "second" for other models, so the result is correct for now.
- Risk: a catalog row with a unit such as "per_1k_chars" or "per_minute" would be priced wrongly and could still be marked proven.
- Fix: price only the units the code knows, and return an unproven or unknown estimate for any other unit.

## Non-findings checked
- Dry-run: `installFetchTelemetry` intercepts the first fetch, and every client resolves `globalThis.fetch` at call time. Uploads and paid submits are therefore never sent on `--dry-run`.
- Ordering: flag validation runs before any upload, and uploads run before the paid submit. Product-avatar never resubmits a stage on its own and prints resume hints.
- Idempotency:
  - Sume generate retries (transient errors and malformed 2xx, max 2) reuse the same Idempotency-Key, and 4xx refusals are not retried.
  - Platform submit retries 429, network errors and 5xx (except 501/505) with the same key.
  - Legacy retries nothing except 429 (L1). Status 0, 5xx, and a 2xx carrying a 5xxx business code all get the orphan hint.
- Spend extraction:
  - RESERVED and RELEASED Platform holds are excluded, and so are Sume's reserved, refunded and released amounts.
  - `remainCredit` and the Sume balance are excluded.
  - SPEND_LOOKUPS (`src/agent/agent-runtime.ts:53`) discards usage for `sume estimate` and `topview credit`.
- `--max-cost`: `sume image` and `sume video` are priced in `command-cost.ts`. An unknown or unproven estimate is refused unless the policy is "estimate".
- Secrets:
  - Only the Authorization header carries keys.
  - HttpError redacts URL query strings, so signed URLs are not exposed, and `scrubSecret` removes key echoes from error snippets.
  - The `apiKeyMap` keys from the Legacy credit endpoint never reach output.
  - Prompts and request bodies are not logged.
  - Sume upload refuses caller-supplied authorization, cookie, x-api-key and host headers, and checks the upload URL with checkUrlSafety. The TopView upload PUT uses `redirect: "manual"`.
- Runtime neutrality: `client.ts`, `legacy-client.ts`, `platform-client.ts`, `errors.ts`, `models.ts`, `cost.ts` and `request-plan.ts` import only core modules. The import-graph tests and the worker bundle check pass.
- Worker file access:
  - Every flag that reads a local path is a fileOption or a filePositional (`topview upload`).
  - `@file` values are rejected globally, which blocks `topview run --input @file`.
  - `sume estimate` uses urlOptions, and the CLI also refuses local files there.
- Matches the API docs:
  - paths, auth headers and status values
  - the Legacy string code "200" and the Platform `{code:200,data}` envelope
  - the `finishedVideoUrl ` key with a trailing space
  - `generatingCount` sent as a string
  - Sume's `next_poll_after_seconds`

Status: DONE_WITH_CONCERNS
Summary: The money, secret and runtime-neutrality protections largely hold, but Sume records its refundable submit reservation as settled spend even for failed or canceled jobs (H1). `topview run` can lose its idempotency key when interrupted (M1).
Concerns/Blockers: H1 should be fixed before merge. M2 (uncapped remote MCP spend) needs a decision from the operator.
