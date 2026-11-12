# Code review: 61de618 feat(elevenlabs): pre-flight estimate for transcribe

Scope: src/budget/{command-cost,cost-estimate,pricing-catalog}.ts, src/agent/cost-preflight.ts,
README.md, docs-site en+vi (commands/elevenlabs.md, reference/for-ai-agents.md), skill/SKILL.md,
tests/unit/budget/elevenlabs-transcribe-cost.test.ts, tests/smoke/budget-guard.test.ts. ~210 LOC added.

## Verification run
- `npx vitest run` (root): 165 files passed, 8 skipped; 3271 tests passed (ffprobe present, so the smoke case ran).
- `worker`: `npx vitest run`: 42 files / 773 tests passed.
- `npm run typecheck`: clean. `biome check` on the touched src/test files: clean.

## Blocking issues
None. I found no correctness bug or regression that should block the merge.

## Task-guard change (cost-estimate.ts:229-231): checked for regressions
New rule: `(rate.task || req.task) && rate.task !== req.task` returns unknown. The only requests
that carry a `task` are built in command-cost.ts:
- `gemini generate-music` (task music) resolves to the Lyria entries, which have task music (pricing-catalog.ts:443, :457). No change.
- `elevenlabs sfx` / `elevenlabs music` (lengthRequest, task sfx/music) resolve to entries with task sfx/music (:503, :519). No change.
- `openrouter transcribe` (now task transcription) resolves to every `sttSeconds` entry, which now has task transcription (:148-153). It is unknown only for non-STT OpenRouter models (TTS char, byte or token prices). Before, those were wrongly priced at about $0 from empty text, so this is the intended fix.
- `elevenlabs transcribe` (task transcription) resolves to `elevenlabs/scribe@api` (task transcription).
- Requests with no task (gemini/elevenlabs/fish/openrouter tts, the `speech generate` routes) resolve to entries with no task. No change.
- sume, atlas 3d/run and free commands never reach `estimateCost` (command-cost.ts:490-525).
- fish tts direct call (src/providers/fish/commands/tts.ts:339) sends no task and hits fish entries that have none. No change.

Other places that read `PriceEntry.task`:
- catalog-build.ts:187-188 derives the task as `entry.task ?? taskOfMeters(...)`. `taskOfMeters` already mapped `input_audio_seconds` to "transcription", so offerings and `catalog compare/recommend` filters for the OpenRouter STT models are unchanged. `rateView` (catalog-build.ts:122-150) does not output `task`, so the catalog JSON / MCP `multix_model_catalog` shape is unchanged.
- cost-receipt.ts:189 calls `resolveRate` without a task check. For the new scribe entry, `measuredUnits` never yields `input_audio_seconds`, so the receipt stays `unknown` instead of a fabricated actual. Correct.

Worker/MCP (`multix_run`): worker/src/jobs/job-tools.ts:62 and workflow-manager.ts:564 call `estimateCommand` without defaults. Over MCP the `input` is an https URL, so `audioSeconds` is undefined and the estimate is `unknown`. The reason changes from `unsupported` to `missing_input`, and the verdict is the same (`BUDGET_UNPROVEN` under `max_cost_usd`). No worker test depends on the old reason (the suite passes). Worker `cli-catalog.json` contains no prices, so it needs no regeneration.

## Medium
1. **Estimate assumption text contradicts per-minute billing.** cost-estimate.ts:190 always prints "Audio billed per second of input; ..." for any `input_audio_seconds` rate. The new scribe catalog note (pricing-catalog.ts:545) and the commit say ElevenLabs bills "per audio minute". Scenario: `elevenlabs transcribe --input 2s.wav --model scribe_v2 --estimate` shows expected $0.00011, the per-second assumption and a $0.0033 high end. If ElevenLabs really rounds each request up to a minute, the real charge is the high end, and both `expected_usd` and the receipt `variance_usd` are understated by about 30x for short clips. The `--max-cost` ceiling is still safe because the high end rounds up to 60 s. Fix: make the assumption text and `expected` follow the rate (for example a per-entry `billing_increment_seconds`), or at least drop "per second" from the wording for scribe. Note: WebFetch of https://elevenlabs.io/pricing/api confirmed $0.20/h for Scribe v3, v2 and v2 Medical (no Scribe v1 listed). It did not surface a billing increment, so "billed per audio minute" in the catalog note is unconfirmed by this review.
2. **`--model` help and README still list only the deprecated models.** The commit tells users to pass `scribe_v2`/`scribe_v3` (command-cost.ts:264, docs, skill). But `elevenlabs transcribe --help` builds its model list from `ELEVENLABS_STT_MODELS = ["scribe_v1", "scribe_v1_experimental"]` (src/providers/elevenlabs/models.ts:168, transcribe.ts:29), and README.md:572/:606 lists only scribe_v1. An agent reading `--help` or the worker CLI catalog never sees a model it can price. This is acceptable if issue #607 explicitly covers the help string and the README model list. Otherwise add them there or here.

## Low
3. **Deprecated model is reported as `reason: "missing_input"`** (command-cost.ts:263-266 via the `Unpriced` path at :528-535). Nothing is missing from the input; the price is missing. An agent that branches on `reason` will try to supply input, though the `detail` text is clear. `no_price` would be the accurate reason. The unit test pins `missing_input` (elevenlabs-transcribe-cost.test.ts:55).
4. **The estimate trims the model; the request does not.** command-cost.ts:261 prices `" scribe_v2 "` as `scribe_v2`, but transcribe.ts:46 sends `opts.model` untrimmed. The guard passes and the API most likely rejects the id with a 4xx (not billed). There is no spend risk, only a misleading "estimated" result. This is the same pattern as the music builders.
5. **ffprobe now runs on every `elevenlabs transcribe`.** Because the command is in `pricedCommands()`, cost-preflight.ts:237-238 calls `runtimeDefaults`, and with it ffprobe (10 s timeout), even without `--estimate`/`--max-cost` and even for the default `scribe_v1`, whose estimate is unknown whatever the length. This matches the existing `openrouter transcribe` behavior, so it is not a regression in kind. You could skip the probe when the model resolves to a deprecated scribe id.
6. **Catalog note wording** (pricing-catalog.ts:545): "speaker roles and multichannel cost extra". The fetched pricing page lists multichannel (and diarization) with no separate charge; only keyterm prompting and transcript editing are priced add-ons. Re-check the note against the page. `--diarize` / `--tag-audio-events`, which multix does send, look unbilled, which supports the proven ceiling.
7. **"Proven" ceiling depends on ffprobe accuracy.** For VBR MP3 without a Xing/VBRI header, ffprobe estimates duration from bitrate and can be off by more than the 5% margin. This risk already exists for openrouter transcribe and is noted here for completeness.

## Docs accuracy (against code)
- README.md:85, docs-site commands/elevenlabs.md (en+vi), reference/for-ai-agents.md (en+vi) and skill/SKILL.md:29 match the code on rate id, models, the 5% / whole-minute high end, proven ceiling, strict default policy (command-cost.ts:566), and URL/scribe_v1 staying unknown. The vi pages mirror the en pages.
- Only the inconsistencies in findings 1, 2 and 6 remain.

## Plan / issue #606 acceptance
- `--estimate` prints a priced estimate without sending: met for `scribe_v2`/`v3`/`v2_medical` with a local file (smoke test). With the default `scribe_v1` it is intentionally unknown (deferred to #607).
- `--max-cost` below the estimate refuses: met (smoke, BUDGET_EXCEEDED, exit 2). Above it the run proceeds: covered only at the `checkBudget` unit level, with no smoke run past the guard (expected, since that would hit the API).

Status: DONE_WITH_CONCERNS
Summary: No blocking bugs. The task-guard change affects only the intended openrouter transcribe case and breaks no other priced command, the catalog or the worker/MCP path (all root and worker tests pass). Concerns: the per-second assumption text and expected value conflict with the per-minute billing claim, the `--help`/README model lists only show the deprecated scribe_v1 models, and the deprecated-model reason should be `no_price`.
