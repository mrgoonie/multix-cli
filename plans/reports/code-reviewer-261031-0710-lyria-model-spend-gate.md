# Code review: gemini generate-music --model spend gate (issue #536)

Scope: uncommitted diff, 4 files (+24/-3):
- worker/src/jobs/cli-command-policy.ts
- worker/test/run-argv-builder.test.ts
- docs-site/src/content/docs/guides/mcp-server.md
- docs-site/src/content/docs/vi/guides/mcp-server.md

Verification run: worker `tsc --noEmit` clean; worker vitest 32 files / 612 tests pass;
biome check on the two changed TS files clean. Probe of `estimateCommand` + `checkBudget`
(scratch script, not committed): omitted model -> $0.04 proven, `lyria-3.5` -> $0.08 proven,
`lyria-3-clip-preview` -> $0.04 proven; all pass `strict` at max_cost_usd 0.10.

## Critical
None.

## High
None.

## Medium

### M1. Docs: budget-mode paragraph is now false for this command (EN + VI)
- docs-site/src/content/docs/guides/mcp-server.md:195-197
- docs-site/src/content/docs/vi/guides/mcp-server.md:195-198

Text: "Of these, only `openrouter tts` has a price estimate ... so in practice `budget`
refuses the rest". The diff adds `gemini generate-music --model` to "these", and it does
have a proven estimate: src/budget/command-cost.ts:73-77 prices it per model with no
env dependence, and the Worker's budget path (worker/src/jobs/job-tools.ts:62,
worker/src/skills/workflow-manager.ts:564-565) uses that estimate under `strict`.
Result: in `budget` mode, `--model lyria-3.5` with `max_cost_usd >= 0.08` runs; it is
not refused. The code behaviour is the desirable one; the doc claim is wrong.
Fix: name both, e.g. "Of these, only `openrouter tts` (for a model whose price is known)
and `gemini generate-music` have a price estimate, so in practice `budget` refuses the
rest", in both languages.

## Low

### L1. An explicit default model is also uncapped (documented false positive)
worker/src/jobs/run-option-caps.ts:190-193: with no catalog `default` for `--model`
(worker/src/cli-catalog.json entry has none, since commander declares no default at
src/providers/gemini/commands/generate-music.ts:53), any value, including
`lyria-3-clip-preview`, returns uncapped. Fails closed and the docs say so ("any
`--model` makes the run uncapped; omit it"), so acceptable. Note only.

### L2. Test gaps
worker/test/run-argv-builder.test.ts:821-823, 842-844 cover `lyria-3.5` (uncapped) and
omitted (capped). Missing: explicit `lyria-3-clip-preview` is uncapped (pins the
documented "any --model" contract), and a catalog-view assertion that
`gemini generate-music` `--model` carries `uncapped_spend: "when given, this option sets
the price of each output"`. Neither blocks.

## Checks requested

1. Correctness. `priceOptions: ["model"]` (cli-command-policy.ts:215-218) feeds
   `uncappedReason` (run-option-caps.ts:187-199). Any given `--model` (string, `""`, or
   bare `true`) is uncapped because `fallback === undefined`. Omitted -> `values.get` is
   undefined -> not priced; the command has no `uncappedSpend`, `uncappedOptions` or
   model-count/resolution caps, so the run stays capped. Option keys spelled `--model`
   are normalised (run-argv-builder.ts:165); the command has no positionals, so extra
   `args` are rejected (run-argv-builder.ts:299). All entry points go through
   `prepareRun` (job-tools.ts:210, api/job-api-handlers.ts:180,
   skills/workflow-manager.ts:544). No other Worker path calls Lyria. `--output-format wav`
   needs `lyria-3.5`, so it cannot buy the dearer model on its own. Correct.

2. GEMINI_MUSIC_MODEL in the job container. Not reachable:
   - Worker sends only provider keys: `jobEnv` (worker/src/jobs/job-runner.ts:77-84)
     copies `GROUP_KEYS` values only.
   - Container rejects any other name: `KEY_NAME_RE` (worker/container/job-runner.mjs:26-27)
     allows `*_API_KEY|*_API_TOKEN|FAL_KEY|CLOUDFLARE_(ACCOUNT_ID|AI_GATEWAY_ID)`;
     `validateSpec` enforces it (:45).
   - The CLI env is a literal object, not `process.env` (job-runner.mjs:142-151):
     PATH, HOME=<job dir>, MULTIX_DISABLE_HOME_ENV=1, MULTIX_HISTORY, MULTIX_OUTPUT_DIR,
     NO_COLOR, then spec.env. Dockerfile sets only NODE_ENV/PORT.
   - cwd/.env: cwd is a fresh mkdtemp dir; inputs are confined to `in/` by
     `INPUT_PATH_RE` (job-inputs.mjs:19), so no `.env` can appear in cwd; home files are
     skipped (MULTIX_DISABLE_HOME_ENV=1, HOME is the job dir).
   So an omitted `--model` resolves to `lyria-3-clip-preview` (models.ts:110-111,
   lyria.ts:24). The Worker estimate also uses the constant, not env
   (command-cost.ts:75). The policy comment's premise holds.

3. multix_catalog / catalog view. catalog-view.ts:76-80 marks `--model` with
   `uncapped_spend: "when given, this option sets the price of each output"` (no default).
   Matches the gate and the docs bullet. No catalog regeneration needed: the CLI surface is
   unchanged.

4. Docs vs code. New bullet (EN :187-189, VI :186-189) is accurate: lyria-3.5 $0.08 vs
   clip $0.04 (README.md:290, skill/SKILL.md:27, command-cost estimates), no listed
   default, any `--model` uncapped, omit for clip. VI matches EN. The surrounding
   budget-mode paragraph is stale (M1).

## Recommended actions
1. Fix M1 in EN and VI.
2. Optionally add the two tests in L2.

## Unresolved questions
None.

Status: DONE_WITH_CONCERNS
Summary: The gate is correct: any --model is uncapped, an omitted one stays capped, and the job container cannot see GEMINI_MUSIC_MODEL. One medium docs issue: the budget-mode paragraph still says only openrouter tts has an estimate, but generate-music has a proven estimate, so budget mode runs lyria-3.5 when max_cost_usd >= 0.08.

## Resolution

- M1: fixed. The budget-mode paragraph now names `gemini generate-music` next to `openrouter tts`, in both EN and VI.
- L1: kept as is. Gating any explicit `--model` is the safe direction, and the docs say so.
- L2: added a test that an explicit `lyria-3-clip-preview` is gated. Catalog-view labelling is unchanged and is already covered for other `priceOptions`.
