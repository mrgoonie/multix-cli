# Sume native provider (issue #413, part A)

Status: done with concerns (only shared-registration follow-ups remain, owned by the controller).

## Files

Created:
- `src/providers/sume/`: `types.ts`, `models.ts`, `client.ts`, `request-plan.ts`, `cost.ts` (runtime-neutral), `node-client.ts`, `node-catalog.ts`, `node-inputs.ts`, `node-outputs.ts`.
- `src/providers/sume/commands/`: `index.ts`, `job-flow.ts`, `image.ts`, `video.ts`, `status.ts`, `cancel.ts`, `models.ts`, `estimate.ts`.
- `tests/unit/providers/sume/`: `fake-sume.ts`, `client.test.ts`, `request-plan.test.ts`, `catalog-cost.test.ts`, `commands.test.ts`, `receipt.test.ts`, `runtime-neutral.test.ts`.
- `docs-site/src/content/docs/commands/sume.md` and `docs-site/src/content/docs/vi/commands/sume.md`.

Modified:
- `src/budget/command-cost.ts`: routes `sume image` and `sume video` to `estimateSumeCost`, adds them to `pricedCommands()`, and adds a `sumeCatalog` default.
- `src/agent/cost-preflight.ts`: resolves the model (from `-m` or `SUME_*_MODEL`) and passes the cached catalog snapshot to the estimator.
- `src/core/usage-extract.ts`: see "Receipts" below.
- `tests/unit/providers/topview/usage-extract.test.ts`: done at the coordinator's request. The `it.fails` for `remainCredit` is now a plain `it`, and there are new cases for a decimal-string `costCredit` and a CAPTURED `charged_usd`.

## Design decisions

- **Runtime-neutral client.** Nothing under `src/providers/sume/` reaches `node:*` except the `node-*.ts` files and `commands/`. `runtime-neutral.test.ts` enforces this for `client.ts`, `models.ts`, `types.ts`, `request-plan.ts` and `cost.ts`. The Worker bundle check reports `cost.ts` clean through `command-cost.ts`.
- **Validated against the catalog.** The catalog decides which flags exist. Every flag is checked against the model's catalog row before anything is uploaded or submitted, and refusals list the values the row accepts.
  - `--param key=value` must name a field the row lists.
  - Lip-sync models need `--audio`, plus `--image` or `--video`, plus `--duration`. They refuse `--generate-audio`.
  - Special-route rows (such as restyle) are refused with a clear message.
- **Async by default.** `image` and `video` print the job handle with Check, Resume and Cancel commands. `--wait` polls (never faster than 2s, following `next_poll_after_seconds`) and downloads the outputs.
- **Idempotency.** Every submit sends an `Idempotency-Key`. Transient failures are retried up to twice with the same key. When the outcome stays unknown, or the run is interrupted mid-submit, the error names the key to reuse and links to app.sume.com.
- **Cost estimator** (`cost.ts`):
  - Reads the cached catalog row and matches price options by resolution, quality and audio, then multiplies by the units (images or seconds) and rounds up to the cent.
  - The ceiling is `proven` only when exactly one option matches and the units are known; otherwise it is an `estimated` range.
  - It returns `unknown` (never $0) when there is no cache, the cache is older than 24h (pointing to `multix sume models --refresh`), the model is missing, or a flag is invalid.
- **Receipts** (`usage-extract.ts`):
  - Plain decimal strings now count as amounts under money-named keys (words usd, cost or credit; never an id). Examples: Sume `usage.usd: "0.35"`, TopView `charged_usd: "0.4160"` and `costCredit: "5.00"`.
  - `charged_usd` counts as USD.
  - An object whose `billing_state` is not captured (RESERVED, RELEASED, REFUNDED, ...) is treated as a hold, and its amounts are not counted as spend.
  - `reserved`, `refunded` and `released` key paths are never counted as spend.
  - `remain` now matches as a balance leaf, which covers TopView `remainCredit`.
  - Result: the Sume submit's 0.35 is counted once, and polls and the balance add nothing.

## Test evidence

- `npx biome check` on the src and test paths: clean.
- `npm run typecheck`: clean. `npm run build`: OK.
- `npx vitest run tests/unit/core tests/unit/providers/sume tests/unit/providers/topview`: 618 passed.
- `npm test`: 2538 passed, 1 failed. The failure is `capability-registry.test.ts`: `sume *` and `topview *` are not yet in `command-capabilities.ts`, a file the controller owns.
- `npm run check:mcp`:
  - Worker typecheck passes.
  - 2 worker tests fail, both on controller-owned registration: `cli-catalog.test.ts` needs `npm run catalog` in `worker/`, and `provider-secret-names.test.ts` needs the worker provider table.
  - `check:bundle` run alone: clean.
- No network in tests; secrets, prompts and signed URLs are asserted absent from output. Temp dirs are removed in `afterEach`.

## Open questions

1. `PriceMeter` has no image or video meter. Units are therefore described in the estimate's assumptions, and `rate.components` is empty.
2. The response shape of `/v1/open/estimate` is undocumented. `sume estimate` prints it as returned and never feeds it into `--max-cost`. The receipt records its POST as role "charge" with an unknown cost; it may need excluding in `agent-runtime.ts`, like balance lookups.
3. Legacy `usage.credits` (35 for $0.35) is reported next to `cost_usd` in receipts.
