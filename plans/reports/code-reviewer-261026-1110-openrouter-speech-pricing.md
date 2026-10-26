# Code review: 54aac6f, OpenRouter TTS/transcribe pre-flight pricing (#339)

Reviewer: isolated code-reviewer (did not write the change). Date: 2026-10-26.

## Scope
- Commit 54aac6f only (the 0cb7cf7 merge parent was not reviewed). 14 files, +674/-29.
- Source: src/budget/{pricing-catalog,cost-estimate,command-cost}.ts, src/agent/{cost-preflight,output-file-inspect}.ts, src/providers/openrouter/{speech-defaults,speech-client,transcription-client}.ts. Tests: tests/unit/budget/pricing-and-estimate.test.ts, tests/smoke/budget-guard.test.ts. Docs: README, SKILL.md, docs-site EN/VI.
- Checks run: `npm run lint` clean, `npm run typecheck` clean, `npm run build` ok, `npm test` 1909 passed / 22 skipped, `npm run check:mcp` passes (the bundle is clean, so the new import of `speech-defaults.ts` keeps the Worker free of Node built-ins).
- Live cross-check: I fetched `/api/v1/models?output_modalities=speech|transcription` and `/api/v1/models/<id>/endpoints` on 2026-10-26.

## Verdict
**Do not merge as is.** Every catalog value matches the `/models` list. The `/models` price is the **cheapest endpoint** of each model, though, and OpenRouter can route a request to a pricier one. On 11 models, including the **default STT model**, a run admitted with a "proven" ceiling can be billed up to 6.5x that ceiling. That breaks the fail-closed promise of `--max-cost`, which is the whole point of #339.

## Findings (ranked)

### 1. CRITICAL: the "proven" ceiling uses the cheapest endpoint, and OpenRouter can bill a pricier one
- Where: src/budget/pricing-catalog.ts:139-345 (OPENROUTER_CATALOG). Affected: `kokoro` :217, `open-weights-tts` :211, `voxtral-mini-tts-2603` :190, `voxtral-mini-tts` :207, `voxtral-small-transcribe` :295, `voxtral-mini-transcribe-3`, `stt-50` (mistralai/voxtral-mini-transcribe), `stt-7.5` :334 (openai/whisper-large-v3), `stt-3.33` :339 (openai/whisper-large-v3-turbo, **the default** `DEFAULT_OPENROUTER_STT_MODEL`).
- Evidence from `/models/<id>/endpoints`:
  - whisper-large-v3-turbo: DeepInfra $0.00000333/s, Groq $0.0000111/s (3.3x)
  - whisper-large-v3: DeepInfra 0.0000075, Together 0.000025, Groq 0.0000308 (4.1x)
  - kokoro-82m: DeepInfra 0.00000062, Together 0.000004 (6.45x)
  - orpheus-3b: 0.000007 vs 0.000015 (2.1x)
  - Mistral Voxtral TTS and STT: a second endpoint costs 10% more (0.0000143 vs 0.000013, and so on)
- Why it happens: by default OpenRouter load-balances across providers (weighted by price, not cheapest-only) and falls back on errors or rate limits. `openrouter tts --zdr / --deny-data-collection` can also exclude the cheap endpoint. Neither command pins a provider (`provider.order` / `allow_fallbacks:false` are not sent).
- Reproduced through `estimateCommand` + `checkBudget`:
  - `openrouter transcribe` of 600 s audio on the default model: ceiling `high_usd=0.002198`, `upper_bound: "proven"`, and `--max-cost 0.0025` is admitted. Routed to Groq, the bill is $0.00667.
  - `openrouter tts --model hexgrad/kokoro-82m` with 10,000 characters: proven ceiling $0.0062, Together bills $0.04.
- The 5% + whole-minute margin does not cover a 3-6x gap.
- Fix: price each OpenRouter entry at the **maximum** endpoint price from `/models/<id>/endpoints`, and record that source URL. An alternative is to send `provider: { order: [cheapest], allow_fallbacks: false }` when `--max-cost` is set, but that changes routing behaviour and needs a product decision. Either way, add a test asserting that multi-endpoint models use the highest price. Until then, mark multi-endpoint entries `verified: false` or `upper_bound: "estimated"`.

### 2. MEDIUM: a price window that ends with no known successor is not guarded within a day of its end
- Where: src/budget/pricing-catalog.ts:102-127 (`openrouter()` builds a single window with `until`), plus :237 (Drama 3) and :244/:250 (Gemini 3.8).
- The direct-API entries (Fish Drama 3, Gemini 3.8) list the next window, so `nearWindow()` raises the high end to the next price during the last 24 h. The OpenRouter entries have no next window, so in that last day `upper_components` equals the current price.
- Reproduced: at 2026-11-12T16:59Z, Drama 3 gives a proven ceiling of $0.02 for 10,000 bytes. If OpenRouter follows Fish's direct price (Fish's own entry goes from $2/M to $50/M), a request that lands after 17:00Z is billed 25x more. A slightly slow local clock or a long request is enough.
- The window is also labelled `"scheduled"`, while the Fish direct entry uses `"promotion"`, so the "Promotional price ends ..." assumption never appears.
- Fix: end these windows `BOUNDARY_MS` early (go `unknown` a day before), or make `resolveRate` return `no_window` when `until` is within a day and there is no successor window.

### 3. MEDIUM: the "proven" transcription ceiling rests on ffprobe's container duration matching what the provider bills
- Where: src/budget/cost-estimate.ts:79,162-172 and src/agent/cost-preflight.ts:35-39.
- I tested two cases where the header lies:
  - Concatenated MP3 with a Xing header: ffprobe reported the full length (610 s). Safe.
  - WAV whose data-chunk header claims 10 s but holds 600 s: ffprobe reports 10 s, and so does ffmpeg's decoder, so a provider using ffmpeg probably bills 10 s too.

  I could not show an underestimate, but the guarantee is "ffprobe agrees with the provider's decoder", not a proof. The 5% margin has no stated derivation.
- Fix (cheap hardening): also bound the duration by file size. For example, take `max(format.duration, stream.duration, size*8/bit_rate)`, or count decoded packets (`-count_packets`). Then state the assumption in `assumptions` and in the docs instead of calling it unconditionally proven.

### 4. LOW-MEDIUM: characters are counted as code points; OpenRouter and the command itself may count UTF-16 units
- Where: src/budget/cost-estimate.ts:88 (`[...text].length`) versus src/providers/openrouter/commands/tts.ts:165 (`input.length`, UTF-16), which is also what the command's own post-run `estimated_cost_usd` uses.
- Reproduced: 1,000 emoji give a character ceiling of 1,000; the UTF-16 count is 2,000. If OpenRouter or the upstream bills JS-style length, a proven ceiling is 2x low on emoji or astral-plane CJK text.
- Fix: for the `characters` meter, set the high end to `max(code points, UTF-16 units, NFC code points)`. This costs nothing on BMP text.

### 5. LOW: every `openrouter transcribe` run now spawns ffprobe synchronously, even without --estimate/--max-cost
- Where: src/agent/cost-preflight.ts:45,62. The command is now in `pricedCommands()`, so `runtimeDefaults` always probes. That is up to 3 s for `-version` plus 10 s per file, before the command validates its input (a file over 25 MB is probed and then rejected).
- Fix: probe only when `estimateOnly || hasMax`, or cache the probe result.

### 6. LOW: misleading `missing_input` detail for `openrouter tts --text-file/--turns-file`
- Where: src/budget/command-cost.ts:93-95,124. The detail says "without the text to speak" when the text was given through a file.
- Fix: add a `NEEDS["openrouter tts"]` entry saying that only `--text`/`--prompt` can be priced.

### 7. LOW: the Worker's estimate ignores OPENROUTER_TTS_MODEL/OPENROUTER_STT_MODEL
- Where: worker/src/jobs/job-tools.ts:58. It calls `estimateCommand(command, options)` with no defaults, so without `model` it prices the hard-coded default.
- This is harmless only while the job container never sets those env vars; today it passes only provider keys. Note it in a comment, or reject `max_cost_usd` without an explicit `model`.

## Checked and found sound
- **Catalog transcription:** a script compared all 33 entries and their model ids and slugs with the live `/models` lists. No mismatches, every id exists, and the six unpriced models (free Fish, Gemini 3.5 transcribe, gpt-4o(-mini)-transcribe, MAI Transcribe 1.5/2) are left out as the commit says.
- **$0 paths:**
  - missing or non-finite audio seconds → `missing_input`
  - URL or unreadable input → unknown
  - `:free` and variant suffixes (`:nitro`) do not match → unknown
  - after a window ends → `no_window`

  I found no way to price something at $0.
- **Model resolution:** the commander default includes `envDefault(...)`, and `run.options = action.opts()`, so CLI env defaults reach the estimator. Lower-casing only affects matching, and all OpenRouter ids are lower case.
- **Receipts** (src/budget/cost-receipt.ts): openrouter now resolves rates. `measuredUnits` never yields `characters`, `utf8_bytes` or `input_audio_seconds` for openrouter, and the speech responses are binary, so no "computed" actual comes from a mismatched unit. Transcription `usage.input_tokens` maps to `input_text_tokens`, which none of the STT entries price, so `computeActual` returns undefined and the status is unknown.
- **No regressions to gemini/elevenlabs:** `output_audio_tokens` is still produced, and adding `output_audio_seconds` to the non-proven set does not change gemini or elevenlabs outcomes. The existing tests pass.
- **Worker bundle:** `speech-defaults.ts` has no imports, and `check:mcp` is clean.

## Test quality
- The tests cover the meters, the unknown paths, a boundary of the minute rounding, and the strict guard, plus a smoke test with a real ffprobe-measured file.
- Missing coverage:
  - no test that multi-endpoint models are priced at their maximum (finding 1)
  - no test of the last-day window boundary (finding 2)
  - no OPENROUTER_TTS_MODEL/STT env-default smoke test
  - no receipt test for an openrouter run without a reported cost
- The "lists ids in lower case" test checks only the data's spelling, not that OpenRouter matches ids case-insensitively. That claim is unverified (the code comment at command-cost.ts:42 asserts it) but harmless.

## Recommended actions
1. Re-price OpenRouter entries from `/models/<id>/endpoints` at the maximum endpoint price, and add a test for it. This blocks merge.
2. Guard windows whose end has no successor within the last day.
3. Bound the transcription length more defensively, or document the ffprobe assumption.
4. Take the higher of code-point and UTF-16 counts for the character ceiling.
5. Probe only when an estimate is requested.

## Unresolved questions
- Should `--max-cost` pin the OpenRouter provider (`allow_fallbacks:false`) instead of pricing the worst endpoint? That is a product decision.
- Does OpenRouter bill speech characters as code points, UTF-16 units or bytes? Not documented. A cheap live check would settle it.
