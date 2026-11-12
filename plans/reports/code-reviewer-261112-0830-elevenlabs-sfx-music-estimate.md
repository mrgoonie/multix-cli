# Code review: pre-flight estimates for `elevenlabs sfx` / `elevenlabs music` (issue #598)

## Scope
- Files: src/budget/{command-cost,cost-estimate,pricing-catalog}.ts, src/agent/cost-preflight.ts,
  tests/unit/budget/elevenlabs-sfx-music-cost.test.ts (new), docs-site EN+VI commands/elevenlabs.md and
  reference/for-ai-agents.md, skill/SKILL.md. ~210 LOC added.
- Verified: `npx vitest run` 3237 pass / 22 skipped; worker `vitest run` 773 pass; `tsc --noEmit` clean;
  biome clean. Manual CLI runs (`npx tsx src/cli.ts elevenlabs ... --estimate [--json]`) for sfx with/without
  duration, music with length / omitted / `--plan` file, `--max-cost` under strict and estimate.

## Overall assessment
Acceptance criteria met: both commands return a numeric estimate with `rate.id` and `rate.source`
(https://elevenlabs.io/pricing/api); `upper_bound: "estimated"`, so `--max-cost` refuses under `strict`
(BUDGET_UNPROVEN) and enforces the cap under `--cost-policy estimate` (BUDGET_EXCEEDED for 14 s music vs
$0.01). USD math is correct (0.12/60 and 0.15/60 per second; 3 s -> $0.006, 14 s music -> $0.035,
600 s -> $1.50). The meterRanges change is gated on `output` being supplied, so the openrouter
output-seconds and Gemini token paths are unchanged. No blocking defects. Disagreements between estimate
and CLI parsing all fail closed (estimate becomes unknown, never under-priced).

## Critical
None.

## High
None.

## Medium
1. Docs: pricing catalog table not updated (EN + VI).
   docs-site/src/content/docs/reference/for-ai-agents.md:186-198 (and vi counterpart) lists every ElevenLabs
   and Fish rate id, but not `elevenlabs/sound-effects@api` or `elevenlabs/music@api`. An agent reading the
   "Pricing catalog" section to find what rates exist will conclude these are unpriced, which contradicts the
   per-command table above it. Fix: add two rows (`eleven_text_to_sound_v2` $0.12/min;
   `music_v1`, `music_v2`, `music_v2_5` $0.15/min), and adjust "Prices as checked on" if needed.
2. Docs: README priced-command list is now wrong.
   README.md:82-87: "Only `gemini generate-speech`, ... are priced so far; `--max-cost` refuses anything it
   cannot price." sfx/music now are priced (and were not added). Scenario: a user reads README, assumes
   `--max-cost` on `elevenlabs music` always refuses, and does not use it. (The list was already missing
   `fish voice-design`; fix both or replace with a link to the for-ai-agents table.) AGENTS.md requires
   README in the docs-impact surface.

## Low
3. Estimate parser stricter than the CLI: src/budget/command-cost.ts:71-76 (`num`) accepts only
   `/^\s*\d+(\.\d+)?\s*$/`, while sfx.ts sends `Number.parseFloat` and music.ts `Number.parseInt`.
   `--duration-seconds .5`, `5.`, `1e1`, or `--music-length-ms 1.5e4` produce `unknown` (verified:
   `.5` -> missing_input), so `--max-cost` refuses a valid run. Fail-closed, so not a spend risk;
   allow a leading-dot decimal at least (`^\d*\.?\d+$`-style) or document it.
4. Misleading NEEDS message: command-cost.ts:222-225 and :436-441. For `sfx --text drum --duration-seconds 31`
   the error says "Cannot estimate elevenlabs sfx without --text or --prompt, and a --duration-seconds..."
   although `--text` was given; the BudgetError hint then still says "pass --cost-policy estimate" when it
   was already passed (pre-existing hint text). Consider a dedicated "duration out of range (0.5..30)" detail.
5. Fractional `--music-length-ms`: estimate prices `14000.9` as 14.001 s; CLI sends parseInt -> 14000.
   Over-estimate by < 1 ms of music; harmless, but `num` could truncate for ms to match the command.
6. `--plan` combined with `--prompt` or `--music-length-ms` (command-cost.ts:160-167): the estimate prices
   only the plan and silently ignores the length; music.ts sends both fields, which the API rejects (no
   charge). Same for a plan containing both `sections` and `chunks` (cost-preflight.ts:103 sums both).
   Fail-safe, but an `--estimate` for an invalid invocation returns a confident number. Optional: return
   unknown when both are set.
7. `round1` (command-cost.ts:78) rounds to 0.001, not one decimal. Rename (e.g. `roundMs`).
8. Omitted length sets `expected = max` (command-cost.ts:91-94): `expected_usd` for a promptless-length
   music run is $1.50 and receipts compute `variance_usd` against it. Deliberately conservative and
   documented ("assumes the longest it may pick"), noting only that "expected" is not a typical value here.
9. Cross-task model collision: resolveRate (pricing-catalog.ts:657) matches provider+model only, so
   `elevenlabs tts --model music_v1` or `speech generate --provider elevenlabs --model eleven_text_to_sound_v2`
   now resolves the music/sfx rate and falls into the chars-per-second heuristic (cost-estimate.ts
   meterRanges else branch) instead of `no_price`. The API rejects such a request, so no money moves; an
   `--estimate` just shows a nonsense number. Optional: check `entry.task` in the builder.
10. Test gap: `runtimeDefaults` wiring (cost-preflight.ts:120-123) is not exercised by the unit test (it injects
   `planLengthMs` directly). Verified manually that `--plan <file> --estimate` prices 60 s -> $0.15.
11. EN/VI commands/elevenlabs.md paragraph says "the total of a `--plan`'s sections": omits v2 `chunks` and
   that `--plan` is priced only from the CLI (the for-ai-agents rows do say both). SKILL.md likewise omits
   "CLI only" for `--plan`.

## Edge cases checked (no defect)
- Commander camelCase vs MCP `duration-seconds`/`--duration-seconds` keys: estimateCommand strips leading
  dashes and `num` reads both spellings; numeric MCP values accepted; NaN/Infinity/negative/0 -> unknown.
- Bounds match the API and the worker caps (cli-command-policy.ts:338-354: sfx min 0.5 / omitted 30 s,
  music omitted 600 s, plan uncapped).
- Worker: job-tools.ts:62 and workflow-manager.ts:564 call estimateCommand without planLengthMs, so an MCP
  `--plan` stays unknown (BUDGET_UNPROVEN); plan runs are `uncappedSpend` -> strict anyway. Behavior
  change: workflow steps running sfx/music (no plan) with an authorized `max_cost_usd` and `estimate`
  policy now start and charge the lease at `high_usd` instead of being refused as unknown. Intended.
- CLI preflight now estimates every sfx/music run (pricedCommands), incl. reading a <=1 MiB plan file;
  musicPlanLengthMs is wrapped in try/catch, size-capped, rejects non-files.
- Receipts: no usage meter for output_audio_seconds is measured, so computeActual returns undefined and
  successful runs stay `unknown` (never a fabricated actual).
- Catalog: new offerings `elevenlabs:eleven_text_to_sound_v2` (task sfx) and `music_v1|v2|v2_5` (task music)
  appear with "no multix command", same as existing ElevenLabs TTS price-only rows (pre-existing pattern;
  `catalog compare -t music` lists them as unknown with the standard "use --estimate" reason).
- USD rounding: micro() rounds at 1e-9 before ceil, so 7 s ($0.014) does not round up spuriously.

## Recommended actions
1. Add the two rate rows to the Pricing catalog tables (EN + VI) and update the README priced list.
2. Optionally loosen `num` to accept `.5`-style decimals and give out-of-range lengths a precise detail.
3. Optionally return unknown for `--plan` + `--prompt`/`--music-length-ms` and plans with both sections and chunks.

## Metrics
- Typecheck: clean. Lint: 0 issues. Tests: all pass (root 3237, worker 773). `npm run verify:docs` not run
  (docs-site deps not checked).

## Unresolved questions
- Whether ElevenLabs bills a plan's declared section lengths or the generated audio length (unpublished;
  covered by the "estimated" upper bound).

Status: DONE_WITH_CONCERNS
Summary: Estimator is correct and fails closed; acceptance criteria met. Concerns are docs gaps (pricing
catalog table EN/VI, README priced list) and minor parse/message mismatches.
