# Sume native provider: implementation report

Status: DONE_WITH_CONCERNS (controller wiring still pending; see Concerns)

## Files

New, runtime-neutral (no node:* through imports; checked by tests/unit/providers/sume/runtime-neutral.test.ts):
- src/providers/sume/models.ts: SUME_ROUTING, SUME_DASHBOARD_LINK, catalogue and estimate URLs, job id and idempotency key checks.
- src/providers/sume/types.ts
- src/providers/sume/errors.ts: SumeApiError, SumeJobFailedError, SumeSubmitError, envelope parsing (with a fallback for truncated snippets), mapSumeError, scrubSecret.
- src/providers/sume/estimate.ts: keyless POST /v1/open/estimate.
- src/providers/sume/catalog.ts: catalogue parsing and validateAgainstCatalog.
- src/providers/sume/request.ts: flag-to-body mapping for both routers.
- src/providers/sume/client.ts: SumeClient.
- src/budget/provider-quote.ts: quoteCommand / quotedCommands.

New, Node-only:
- src/providers/sume/node-client.ts, node-inputs.ts (uploads), node-outputs.ts (downloads).
- src/providers/sume/commands/{index,models,image,video,status,cancel,upload,generate,job-flow,catalog-check}.ts

Modified:
- src/agent/fetch-telemetry.ts: exports `untrackedFetch`.
- src/agent/cost-preflight.ts: `preflightCost()` is async and quotes Sume commands first.
- src/agent/agent-runtime.ts: the preAction hook awaits it.
- src/capabilities/model-discovery.ts: adds "sume" as a discovery provider and `sumeModelTasks`.
- src/commands/agent/model-discovery-cache.ts: `discoverSumeCatalog`, cached in sume-catalog.json.
- src/core/usage-extract.ts: Sume money rules.
- worker/src/jobs/job-tools.ts: `costPreflight` is async and quote-first.

Tests:
- New: tests/unit/providers/sume/{fake-sume.ts, client.test.ts, commands.test.ts, runtime-neutral.test.ts, live.test.ts, fixtures/sume-catalog.json}, tests/unit/budget/provider-quote.test.ts, tests/unit/agent/cost-preflight-quote.test.ts, worker/test/job-cost-preflight.test.ts.
- Extended: tests/unit/core/usage-extract.test.ts, tests/unit/capabilities/model-discovery.test.ts, tests/unit/commands/models-command.test.ts (the last at the coordinator's request).

## CLI surface

- `multix sume models [--kind image|video|lipsync|captions] [--refresh] [--json]` needs no key.
- `multix sume image <prompt> -m <id>` options: `[--image <path|url>]...`, `--aspect-ratio`, `--image-size`, `--quality`, `--resolution`, `--num-images`, `--input <json>`, `--idempotency-key`, `--wait`, `--download/--no-download`, `--output`, `--wait-timeout`, `--image-format`, `--no-webp`.
- `multix sume video [prompt] -m <id>` options: `--image`, `--end-image`, `--video`, `--audio`, `[--reference-image]...`, `--duration`, `--resolution`, `--aspect-ratio`, `--generate-audio/--no-generate-audio`, `--input`, `--idempotency-key`, plus the same wait and output flags.
- `multix sume status <jobId> [--wait] [--download] [--output] [--wait-timeout]`
- `multix sume cancel <jobId>`
- `multix sume upload <file>` prints the public URL.

## Decisions

- `-m` is required and checked against the live catalogue (cached, with a fresh read before a model is called unknown). The check rejects:
  - an unknown model;
  - a model of the wrong kind;
  - a route-only (Remix) model;
  - omit and required fields;
  - a capability marked false;
  - values outside the stated lists or ranges.
  If the catalogue cannot be read, the server's own 400 reports bad input.
- Without `--wait`, image and video print a job handle with check, resume and cancel commands.
- Submit safety:
  - Each invocation gets a fresh UUID Idempotency-Key.
  - Retries reuse that key on network errors, 429 and retryable 5xx. They never happen on 400, 402, 403 or 409, or on refused-provider 5xx.
  - When retries run out and Sume may have accepted the job, the error prints the key and the exact command with `--idempotency-key`, and says not to resubmit without it.
- The catalogue and the quote go through `untrackedFetch` and the public api.sume.com, so they are never recorded as billable calls and never stop a dry run.
  - A plain `--dry-run` skips the quote.
  - A normal run does quote, so its receipt has an estimate.
- An unquotable request gets an unknown estimate (never $0): a missing model, a local media file not yet uploaded, or a quote failure. `--max-cost` then gives BUDGET_UNPROVEN.
- Usage accounting:
  - The submit's `data.usage.usd` is counted as cost unless `idempotency_hit` is true.
  - A settled usage_summary counts as captured cents, or 0 once refunded.
  - Reserved amounts and result reads are never counted.
  - Bodies without a Sume `job_<uuid>` follow the generic rules unchanged.
- SUME_DASHBOARD_LINK points to https://www.sume.com/docs/authentication, because the dashboard itself needs a login.
- `newIdempotencyKey` uses the global `crypto`, not `globalThis.crypto`, which the worker typings reject.

## Test evidence (2026-10-28)

- `npx vitest run tests/unit/providers/sume tests/unit/budget tests/unit/agent tests/unit/core/usage-extract.test.ts tests/unit/capabilities tests/unit/commands/models-command.test.ts`: 19 files passed, 1 skipped (live); 269 tests passed, 2 skipped.
- `npx vitest run tests/unit`: 2254 tests passed. The 1 failure is project-env-names (TOPVIEW_UID, from the parallel TopView work).
- `npm run typecheck`: clean. The test files were also typechecked with a temporary config: clean.
- `npx biome check` on all my files: clean. The remaining `npm run lint` errors are only in tests/unit/providers/topview/*.
- `npm run check:mcp`: worker typecheck clean, 23 files and 401 tests passed, bundle check clean.

## Concerns

- The controller still needs to:
  - register `registerSumeCommands`;
  - add SUME_API_KEY and SUME_BASE_URL to the env, key, check and worker-secret lists;
  - update the capabilities, docs, README, .env.example and skill.
- `quotedCommands()` returns "sume image" and "sume video". command-capabilities must use those command names.
