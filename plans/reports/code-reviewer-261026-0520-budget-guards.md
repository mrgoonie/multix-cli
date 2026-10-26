# Code review: budget guards, pricing catalog, cost receipts (#295)

Scope: uncommitted working tree vs HEAD, excluding README.md, skill/, docs-site/.
Files: src/budget/{pricing-catalog,cost-estimate,cost-receipt,command-cost}.ts, src/agent/cost-preflight.ts,
src/agent/{agent-runtime,history-store,result-envelope,run-state}.ts, src/commands/agent/{guide,history}-command.ts,
src/core/{error-classify,errors,usage-extract}.ts, src/project-env-names.ts, worker/src/jobs/job-tools.ts, tests.

Verification run: `npm run build` OK, `npm run typecheck` OK, biome on touched dirs clean,
`npx vitest run tests/unit/budget tests/smoke/budget-guard.test.ts` 35/35 pass,
worker `vitest run test/job-tools.test.ts` 15/15 pass, worker `tsc --noEmit` OK.
CLI exercised with fake keys, dead HTTPS_PROXY, and the ElevenLabs fetch fixture. Library behaviour checked with a
scratch vitest probe (not committed). Catalog prices were checked against the three provider pricing pages today and match.

## High

### H1. A no-request receipt replaces an uncertain or computed cost with $0 in `settleOperations`
`src/budget/cost-receipt.ts:150-154` and `:279-285`.
A run that sent nothing gets `status: "settled", actual_usd: 0, role: "none"`. `settled` has the highest RANK (3), and
`informative` is true for every role except `observation`. So a later no-request receipt with the same `operation_id`
replaces whatever came before it.
Scenario: an agent sets `MULTIX_OPERATION_ID=task-7`. The submit fails after the POST (uncertain). The agent retries with
the same id and `--max-cost`, and the retry is refused (BUDGET_EXCEEDED), or it fails validation. `settleOperations`
then returns `{status: "settled", actual_usd: 0, uncertain: 0}`. Reproduced: probe case 1 gives
`total_usd 0, uncertain 0`. Probe case 2 does the same to a computed $0.08 charge.
The same thing happens in `history stats` and in any budget ledger built on this contract. This is the
"uncertain becomes $0" failure the issue forbids.
Fix: treat `role === "none"` (actual_source `no_request`) as non-informative, the same way an observation without a
figure is treated. A run that sent nothing tells you nothing about the operation's charge. Add a test for
"uncertain charge + refused retry, same op id".

### H2. Codex image driver runs are recorded as "settled $0, no provider request was sent"
`src/budget/cost-receipt.ts:150` with `src/agent/cost-preflight.ts:223-247` and `src/providers/openai/codex-image-driver.ts:133`.
`openai generate` / `image-to-image` use the `codex` program through execa, not fetch, when the driver is codex.
That is the default when there is no OPENAI_API_KEY and `codex login` is done. `run.calls` stays empty, so the receipt
says `role: none, status: settled, actual_usd: 0, actual_source: no_request`. The text-mode "Cost:" line is suppressed,
and `history stats` counts the run as $0. Paid or quota-spending work is reported as free.
Fix: make the external-run guard in agent-runtime record the external run (for example a
`run.calls.push({method: "EXEC", ...})` or a `run.externalRuns` counter). Pass it into `buildCostReceipt` so the run
counts as `role: "charge"`, with status `unknown` on success and `uncertain` on failure.

## Medium

### M1. `history stats` shows `cost_usd: 0` for buckets whose real spend is unknown
`src/commands/agent/history-command.ts:149-158`.
`priced = operations.some(op => op.actual_usd !== null)`. Any run that sent nothing contributes a $0 op: a validation
error, a missing key, a refused `--max-cost`, or a parse error after `run.group` was set. That one op makes the bucket
"priced". Probe case 3: two successful Replicate runs with unknown cost plus one missing-key failure gives
`cost_usd: 0`. Before this change the key was absent. `spend.unknown` is computed but never surfaced, so `cost_usd`
silently excludes unknown operations.
Fix: drop `no_request` receipts from the spend (or compute `priced` only from `role === "charge"` ops). Emit
`cost_unknown_ops` next to `cost_uncertain_ops`.

### M2. Charge receipts that share an operation_id collapse into one, so distinct paid runs are under-counted
`src/budget/cost-receipt.ts:279-285`, `src/agent/cost-preflight.ts:233` (`MULTIX_OPERATION_ID`).
Settlement keeps one "best" figure per op. Two real charges with the same explicit id count once: for example two
resubmits that each got a new provider job, or an agent that exports `MULTIX_OPERATION_ID` once in its shell for a
whole session. A genuine resubmit is a second charge. Only polls, replays and re-reads of the same provider job
should collapse.
Fix: within one operation, sum charge receipts that have different provider request/job ids (or different history
ids) and keep "best figure" only for receipts about the same provider job. Alternatively, document that the env id
means "same provider job" and warn when two charges share it.

### M3. A successful run after a 429 retry is reported "uncertain"
`src/budget/cost-receipt.ts:165`.
`partial` treats every billable call with status 0 or >= 400 as possibly charged. The Gemini key pool
(`src/providers/gemini/key-pool.ts`) retries a 429 with the next key, so a normal multi-key run (429 then 200) gets
`status: uncertain, actual_usd: null` (probe case 4). The measured usage is thrown away. The same applies to a
401/403/400 failure, which cannot be billed.
Fix: count 0, 408 and 5xx as possibly billed. Treat 400/401/403/404/422/429 as rejected. Compute the actual from usage
when the remaining billable calls succeeded.

### M4. Gemini TTS actual cost is usually "unknown"
`src/agent/fetch-telemetry.ts:12,182`.
Usage is only parsed from JSON bodies under 2 MB. Gemini TTS returns base64 PCM inline (about 64 KB per second), so
any clip longer than about 30 s has no usage. The receipt is `unknown` and has no variance. This is safe (not $0), but
it means `computed` almost never happens for the main Gemini case. Consider a streaming or regex extraction of
`usageMetadata` / `usage` from the tail of large JSON bodies, or extract usage in the speech generator and hand it to
the run state.

### M5. The ElevenLabs computed actual relies on an unverified header meaning
`src/budget/cost-receipt.ts:102-104`.
The actual is `header.character-cost` x USD per character. Current ElevenLabs docs show both `character-cost` and
`x-character-count`. Third-party sources say Flash/Turbo spend 0.5 credits per character. If the header reports
credits, Flash/Turbo actuals are half the real amount: the catalog price already includes the discount, so it is
applied twice. The smoke fixture sets the header to the code-point count, so the test confirms the code's own
assumption rather than the provider's behaviour.
Fix: prefer `x-character-count` when present. Otherwise check the header against the estimate's character count and
mark the status `unknown` when they disagree by more than a small tolerance. Confirm with one live, opt-in call.

## Low

- L1. `src/agent/agent-runtime.ts:109`: `update` is not in `NO_DRY_RUN_GROUPS`, so it gets `--estimate/--max-cost/--cost-policy`.
  `multix update --max-cost 1` refuses the self-update with BUDGET_UNPROVEN. Exclude non-provider groups (use `NON_PROVIDER_GROUPS`).
- L2. `worker/src/jobs/job-tools.ts:144`: `costPreflight` reads raw `args.options`, but `prepareRun` accepts keys with
  leading dashes (`"--text"`). For those, the estimate is `missing_input` and `max_cost_usd` refuses a valid run. Pass the
  normalised option map from `prepared`, or strip `^-+` in `opt()`.
- L3. The worker estimates `gemini generate-speech` with the `voices.ts` default, while the CLI uses `getDefaultModel()`, which
  reads `GEMINI_TTS_MODEL`/`TTS_MODEL`. If the job container ever sets those, the MCP estimate prices a different model.
- L4. Text mode now writes a `Cost: ...` line to stderr after every successful provider run with a known figure or an
  estimate (`agent-runtime.ts:363-365`). This is a visible behaviour change for scripts that read stderr. Consider
  limiting it to `--verbose`, `--max-cost` or `--estimate` runs, or document it.
- L5. Duplicated logic: `src/providers/gemini/omni.ts` keeps its own Gemini list-price table (two sources of truth for
  Gemini prices). Two `usd()` formatters exist (`command-cost.ts:129`, `cost-preflight.ts:249`). The `status !== -1`
  filter (`cost-receipt.ts:138`) is dead: nothing records -1.
- L6. Smoke "sends nothing" tests rely on the dead proxy making a failure. Assert `out.http === undefined` (and/or preload
  a fetch stub that throws) so the test proves no request was sent.

## Nit

- `parseMaxCost` accepts `0x10` (16) and `1e3`. Consider `/^\d+(\.\d+)?$/`.
- `--cost-policy estimate` without `--max-cost` is silently ignored, but `--cost-policy bogus` without `--max-cost` errors.
- The Fish catalog entries have no CLI command or estimator builder (no `fish` provider yet). That is fine as data, but nothing exercises the `utf8_bytes` pricing end to end.
- `settleOperations` drops an adjustment for an op whose actual is null (a refund on an uncertain op is lost silently).

## Checked and found fine

- preAction order: `preflightCost()` runs in the root `preAction` after local validation hooks and before any action, and
  no command registers network work in an earlier hook, an argParser, or passThroughOptions. `rerun` forwards
  `--estimate`/`--max-cost` to the child, which applies the guard again. Refused `--max-cost` exits 2 (`--json`) / 1 (text)
  with BUDGET_EXCEEDED/BUDGET_UNPROVEN, `cost.actual_source: no_request`, and `next[0]` = the same command with `--estimate`
  and without the limit.
- `--estimate` with `--json`, text mode, `--dry-run`, an unknown price, and a refused budget all exit 0. Output and
  history are marked `estimate_only`, have no outputs, and are excluded from stats. The MCP `estimate`/`max_cost_usd`
  gives the same verdicts through shared `command-cost.ts`, and nothing starts when it refuses.
- Price math: per-unit components, the current window using an exclusive `until`, a ceiling within one day of a change
  that uses the higher price (drama-3 at 16:59:59Z gives high $50/M), micro-dollar floor/ceil with float snapping, and the
  stale/unverified/no-window/no-price cases resolve to `unknown`, never $0. Catalog values match the Gemini, ElevenLabs
  and Fish pricing pages (checked 2026-10-26).
- Units: ElevenLabs code points, Fish UTF-8 bytes, Gemini 25 audio tokens/s. Vietnamese NFC/NFD counts are correct
  (17/22 code points, 22/27 bytes). Context/style text is counted in the high end only.
- Failed runs after a billable request are `uncertain` (actual null), never $0. A provider-reported $0 stays $0.
- No secrets: estimate/receipt carry counts, not text. BudgetError messages carry provider/model only. `next` uses
  `redactArgv`. `MULTIX_OPERATION_ID` is excluded from project .env files.
- Runtime neutrality: src/budget and its imports (core/errors, core/redact, provider model constants) contain no `node:*`.
  Worker typecheck passes. MCP schema change is additive (all three new inputs are optional).

## Resolution (implementer)

| Finding | Outcome |
| --- | --- |
| H1 | Fixed. `settleOperations` ignores receipts whose `actual_source` is `no_request` or `refused`; an operation made only of them is dropped. Tests cover uncertain then not-sent, and computed then not-sent. |
| H2 | Fixed. The external-run guard records each provider CLI run (`run.externalRuns`), and the receipt counts it as a billable `EXEC` call: unknown on success, uncertain on failure. |
| M1 | Fixed. A bucket whose operations are only not-sent runs no longer shows `cost_usd`; `cost_unknown_ops` is reported next to `cost_uncertain_ops`, and the docs say `cost_usd` is then a lower bound. |
| M2 | Fixed. Distinct charge runs of one operation add up; a verbatim replay (same instant, status and figure) counts once; a provider-reported observation settles the operation. |
| M3 | Fixed. Only status 0, 408 and 5xx make a successful run uncertain. A run whose every billable request was refused with another 4xx is `settled` $0 with `actual_source: refused`. |
| M4 | Fixed. JSON bodies over 2 MB (up to 200 MB) are streamed through a rolling 64 KB tail, and the trailing `usageMetadata` / `usage` block is parsed from it. Unit and telemetry tests use a 3 MB Gemini body. |
| M5 | Fixed conservatively. Characters come from `x-character-count`; `character-cost` is only read as characters on full-credit models (not Flash/Turbo), else the actual stays unknown. A live check needs a paid key and is not run in CI. |
| L1 | Fixed. Cost flags are only added to provider groups; `multix update --help` has none. |
| L2 | Fixed. `estimateCommand` strips leading dashes from option keys. |
| L3 | Not changed. The job container receives only provider keys, not `GEMINI_TTS_MODEL`, so both sides resolve the same default today. |
| L4 | Kept and documented: the `Cost:` line is on stderr only, which stdout parsers do not read. |
| `0x10` | Fixed. `--max-cost` accepts only plain decimals. |
