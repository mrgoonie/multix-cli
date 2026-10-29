# Code review: uncapped spend guard (issue #425)

Commit: `e2a0332 fix(mcp): refuse runs the operator spend caps cannot bound unless a budget proves them` (vs `HEAD~1` = `044dfec`)
Date: 2026-10-29 (UTC). Reviewer: isolated code-reviewer agent. No source files modified.

## Scope
- Files: 15 (worker/src: api/job-api-handlers.ts, api/openapi-document.ts, config.ts, jobs/catalog-view.ts, jobs/cli-command-policy.ts, jobs/job-tools.ts, jobs/run-argv-builder.ts, jobs/run-option-caps.ts, wrangler.jsonc; tests: run-argv-builder, job-tools, rest-api; docs: README.md, docs-site EN + VI mcp-server.md)
- LOC: +449 / -24
- Verification run: `npx vitest run test/run-argv-builder.test.ts test/job-tools.test.ts test/rest-api.test.ts` -> 104 passed; `tsc --noEmit` clean; `biome check worker/src worker/test` clean.
- Probes: a throwaway vitest file (created under worker/test, run, then deleted) calling `prepareRun` / `costPreflight` with adversarial inputs. Results quoted below.

## Overall assessment
The guard is wired correctly where it is wired: `prepareRun -> assertSpendGuard -> costPreflight -> runner.run` on both surfaces, and it fails closed (budget mode effectively denies, because none of the marked commands has a pricer: `pricedCommands()` in src/budget/command-cost.ts:121 lists only speech/TTS commands). Option-name normalisation (`--input`, `---input`) is handled before the `values` map, so the dashed-alias concern does not apply. However the marking is a hand-maintained list, and at least one pass-through command with a paid effect is unmarked (`fal tts`), and the pre-existing count/duration cap check can be bypassed with exponent notation. Neither is caught by a structural test.

## Critical / High

### H1. `fal tts` is a full pass-through runner and is not marked
- worker/src/jobs/cli-command-policy.ts:247 `"fal tts": { fileOptions: {...}, unsupported: ["receipt"] }` - no `uncappedSpend`, no `uncappedOptions`.
- src/providers/fal/commands/tts.ts:148-161: `-m/--model` accepts any fal endpoint ("other fal TTS ids need --text-field"); `--input <json>` is merged as the request body (src/providers/fal/speech-input.ts:186 `const input = { ...extra }`).
- Probe: `prepareRun({command:"fal tts", options:{text:"x", model:"fal-ai/veo3"}})` -> argv `fal tts --text=x --model=fal-ai/veo3 --output-dir=out`, `uncappedSpend: undefined`. With `text-field: "prompt"` and `input: '{"duration":"8s","resolution":"1080p",...}'` this is `fal run` under another name, so it escapes the duration/resolution caps in `budget` and `deny` mode alike.
- Fix: mark `"fal tts"` with `uncappedOptions: ["input", "text-field"]` at minimum (or `uncappedSpend: PASS_THROUGH` when `--model` is not in `FAL_SPEECH_MODELS`). Add a catalog-wide test: every option whose flags contain `<json>` must be in `unsupported`, `uncappedOptions`, or belong to a command with `uncappedSpend` (that rule also flags `openrouter tts --provider-options`, see M3).

### H2. Count/duration caps bypassed with exponent notation (pre-existing, but inside the issue's goal)
- worker/src/jobs/run-option-caps.ts:33-37 and :52 validate with `Number(raw)`; many CLI commands parse with `Number.parseInt(raw, 10)`, which stops at `e`.
- `"9e-1"` -> cap sees 0.9 (passes), CLI sends 9. `"100e-2"` -> cap sees 1, CLI sends 100. `"12e-1"` -> cap sees 1.2 s, CLI sends 12 s.
- Probe output (limits maxOutputs=4, maxVideoSeconds=10): `openrouter generate --num-images=100e-2` accepted, `byteplus video --duration=60e-1` accepted, `leonardo generate --num=9e-1` accepted, all with `uncappedSpend: undefined`.
- Affected parsers: src/providers/openrouter/commands/generate.ts:47 (no upper clamp), leonardo/commands/generate.ts:104, image-to-image.ts:100, image-to-video.ts:88, fal/commands/image.ts:56, byteplus/commands/generate.ts:60, image-to-image.ts:66, video.ts:68, image-to-video.ts:84, reference-to-video.ts:107, minimax/commands/generate-video.ts:43, openrouter/commands/image-to-video.ts:80. (replicate/runway use `Number` + `Number.isInteger` and are safe.)
- Fix (Worker side, no CLI change needed): in `positiveNumber` require `/^\d+$/` (counts) or `/^\d+(\.\d+)?$/` (durations) before `Number`, and/or rewrite the value to the canonical `String(n)` in `values` so the CLI receives exactly what was checked. Add tests for `"9e-1"`, `"1e1"`, `"0x10"`.

## Medium

### M1. Source-length classification is inconsistent
`elevenlabs dub` is marked `SOURCE_LENGTH` (cli-command-policy.ts:229-230), but other commands billed by input media length are not: `elevenlabs isolate` (:237), `elevenlabs voice-changer` (:226), `elevenlabs transcribe` (:227), `openai transcribe` (:190), `gemini transcribe/analyze`, `atlas audio`. Same for duration-billed audio with no cap: `elevenlabs music --music-length-ms`, `elevenlabs sfx --duration-seconds` (probe: `--music-length-ms=600000` accepted, unmarked). Either mark them or record why only dub/heygen qualify (price magnitude), in the policy comment and the docs list.

### M2. Model-default resolution is the same gap as model-default count, unhandled
`resolution` caps only check a value that is given or has a catalog default (run-option-caps.ts:73-89). `atlas video`, `atlas image-to-video`, `replicate video` (VIDEO_CAPS without `fillResolution`) and `fal video` (no resolution cap at all, :244) leave resolution to the model when omitted. `fal image -m` / `fal video -m` also accept any model id. Needs a decision: `fillResolution`, or a `resolutionFromModel` mark analogous to `countFromModel`. Not verified per model.

### M3. `openrouter tts --provider-options <json>` and `byteplus generate-3d --flags <raw>` are raw pass-throughs left unmarked
cli-command-policy.ts:199, :223. Both are probably bounded by text length / single 3D output, so likely acceptable, but they should be explicitly classified (mark or comment) so the json/raw rule in H1's test can be enforced.

### M4. Default mode changes production behaviour for mainstream commands
wrangler.jsonc sets `MULTIX_MCP_UNCAPPED_SPEND: "budget"`, and since no marked command is priced, `heygen video`, `heygen translate`, `heygen lipsync`, `heygen video-agent`, `heygen template`, `elevenlabs dub`, and all `*run` commands are now refused on the live server with no caller-side workaround. The docs state this honestly ("in practice budget refuses them"), and issue #425 asked for an operator decision, but the PR should state explicitly that it picks option 1 and that these commands go dark by default; the error text "Pass max_cost_usd: the run starts only when its price is known and fits" (run-option-caps.ts:133-135) sends callers on a retry that can never succeed. Suggest: when `estimateCommand` has no pricer for the command, say so in the guard error ("this command has no price estimate; this server refuses it unless the operator sets MULTIX_MCP_UNCAPPED_SPEND=allow").

### M5. Future pricers + `cost_policy: "estimate"` could reopen the gap
`assertSpendGuard` accepts any `max_cost_usd`; `costPreflight` then honours the caller's `cost_policy`. Once a pricer is added for an uncapped command (e.g. heygen video), an estimate built from flags cannot see the uncapped dimension (source length, JSON body). Consider forcing `strict` for runs with `uncappedSpend` set, or document that a pricer for a marked command must price the uncapped dimension.

## Low

- L1. REST `cost_policy` is only type-checked (job-api-handlers.ts:148-150). An invalid string without `max_cost_usd` is silently ignored; with it, the error comes from `parseCostPolicy` as "Invalid --cost-policy" (CLI wording). MCP rejects both via zod enum. Validate against `COST_POLICIES` in `runRequest` for parity.
- L2. REST callers that already sent `max_cost_usd` on capped but unpriced commands (it used to be ignored) are now refused with BUDGET_UNPROVEN. Acceptable (opt-in field, now documented in OpenAPI), but worth a line in the PR description.
- L3. `docs-site/src/content/docs/guides/rest-api.md:191-193` (and vi/:192-194) list the POST /jobs fields as `command, options, args, inputs, wait_seconds`; `max_cost_usd` / `cost_policy` are not mentioned, and REST has no `estimate` field. mcp-server.md says REST "takes the same max_cost_usd and cost_policy fields" (correct), so only rest-api.md is stale.
- L4. Issue #425 names `topview run` and `sume image/video`; neither exists on this base (`origin/dev`, `origin/main`). Whoever lands those providers must mark them; without the structural test from H1 nothing will force it.

## Ordering and estimate-only (checked, OK)
- MCP (job-tools.ts:210-217): `prepareRun` (caps, validation) -> guard skipped only when `estimate: true` -> `costPreflight` returns the estimate whenever `estimate` is true, so an estimate call can never reach `runner.run`. Correct.
- REST (job-api-handlers.ts:178-182): no `estimate` field; guard then `costPreflight` (returns undefined or throws) then run. Correct; BudgetError/ValidationError are MultixError -> 400 via api-http.ts:95.
- Option spelling: run-argv-builder.ts strips leading dashes before lookup and `values` is keyed by the canonical long name, so `{"--input": ...}` is marked; short flags (`n`) and case variants (`INPUT`) are rejected as unknown. `estimateCommand` also strips dashes (command-cost.ts:298-300).
- Mode parsing (config.ts): unknown value -> `budget`, trimmed and lower-cased; plumbed through `serverSettings` for both MCP and REST (api-router.ts:180).

## REST body validation (question 2)
`max_cost_usd`: rejects non-number, NaN/Infinity (via `Number.isFinite`), negatives; `null` is rejected (typeof). Sound. `cost_policy`: see L1.

## Docs accuracy (question 3)
README.md:1033-1035, mcp-server.md (EN/VI) new section and the env table match the code: command lists equal the policy marks; "None of these commands is priced yet" matches `pricedCommands()`; "estimate: true is answered in every mode" matches job-tools.ts:211-216 (deny included). EN and VI are equivalent. Inaccuracies: the lists omit `fal tts` (H1, a code gap rather than a doc gap) and rest-api.md is stale (L3).

## Test gaps (question 4)
1. No test for `fal tts` / any json-taking option (H1); recommend the catalog-wide invariant test.
2. No exponent-notation cap tests (H2).
3. rest-api.test.ts:316-320: `max_cost_usd: "1"` and `cost_policy: "loose"` assert only `status 400`. Both would also be 400 without the new validation (the guard passes on any defined value, then `checkBudget` refuses the unknown price), so these assertions do not prove the validation exists. Assert the message (`max_cost_usd must be a number`, `cost_policy`).
4. No REST test for `deny` / `allow` modes or for a capped command with `max_cost_usd` (L2).
5. No MCP test that `estimate: true` is answered in `deny` mode (docs claim it).
6. No test for `atlas image-to-image` countFromModel, `replicate video --input`, or dashed `"--input"` key.
7. No test for catalog-view `uncapped_spend` markers (catalog-view.ts:72-76, :91) on command and option level.

## Recommended actions
1. Mark `fal tts` (H1) and add the json/raw-option invariant test.
2. Make count/duration caps reject or canonicalise non-integer / exponent strings (H2) - can be a separate issue since it predates this commit, but it defeats the caps this PR relies on.
3. Decide and document the source-length and model-default-resolution sets (M1, M2, M3).
4. Improve the budget-mode error for unpriced commands (M4); consider forcing strict policy for uncapped runs (M5).
5. Tighten REST `cost_policy` validation and the phantom REST assertions; update rest-api.md (EN/VI).

## Metrics
- Type coverage: no `any` added; tsc clean.
- Tests: 104/104 in the three touched files.
- Lint: 0 issues (biome).

## Unresolved questions
- Does BytePlus honour duplicate inline `--dur`/`--rs` flags written in the prompt (flags mode appends the capped values after the caller's text, src/providers/byteplus/models.ts:62-73)? If the first occurrence wins, the prompt itself is a cap bypass. Not verifiable offline.
- Is marking audio source-length commands (M1) wanted, given it would deny them by default?
