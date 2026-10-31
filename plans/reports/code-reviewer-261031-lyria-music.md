# Code review: gemini generate-music (Lyria) — issue #527

Commit f6378a2 `feat(gemini): add generate-music with Lyria over the Interactions API`, diff `origin/dev...HEAD` (21 files, +1626/-14).

## Verification run
- `npm run typecheck`: clean.
- `npx vitest run tests/unit/providers/gemini tests/unit/capabilities`: 17 files, 299 tests pass.
- `npm run check:mcp`: pass; bundle check clean (no `node:*`, commander or execa in the worker bundle). `src/budget/command-cost.ts` now imports `src/providers/gemini/lyria.ts`, which only imports `core/errors` and `./omni.js`, so the worker stays runtime-neutral.
- Offline `dist/cli.js gemini generate-music --estimate` (invalid key, dead proxy): $0.04 for the clip model and $0.08 for lyria-3.5, `upper_bound: proven`, nothing sent.
- `dist/cli.js catalog models --task voice` lists both Lyria models (see M2).
- Google docs, checked live: model ids `lyria-3-clip-preview` and `lyria-3.5`, REST POST `/v1beta/interactions`, WAV through `response_format`, audio in the `model_output` step, at most 10 images on lyria-3.5. Pricing page: $0.04 and $0.08 per song, no free tier. The code's prices and model ids match.

## Overall
The billing-safety core is sound and mirrors omni-flow. It submits once, rotates keys only on 429, and never retries after status 0 or a 5xx. Polling stays on the key that accepted the job. The interaction id is logged, and `trackInFlight` is set, before the session record and before polling. The resume command is threaded through `waitForInteraction`/`oversizedInteraction`. Neither the record nor the logs contain keys. Inputs are validated before the lyrics file or images are read and before any request. No critical or high defects. The gaps are in cost accounting after resume, catalogue data, the Worker's spend caps, and some untested surfaces.

## Critical
None.

## High
None.

## Medium

### M1. A `--no-wait` or timed-out run never settles its receipt, but the docs say it does
- Files: src/providers/gemini/lyria-flow.ts:235 (the `--no-wait` return) and :267 (the only `request.count` push); src/budget/cost-receipt.ts (`computeActual` runs only for `role === "charge"`); docs-site/src/content/docs/commands/gemini.md:233 and vi:230.
- Scenario: `multix gemini generate-music --model lyria-3.5 --prompt ... --no-wait`, then `multix gemini music-status <id> --download`.
  - The submit run is a charge with outcome ok, but no `request.count` metric, so its receipt is `status: unknown` ("no trusted price for the measured usage").
  - The resume run sends only GETs, so its role is `observation` and it is also `unknown` ("spend belongs to the operation's submit run").
  - A run whose polling times out ends `uncertain`, and resuming it never settles it either.
  - The operation's `actual_usd` stays null for good; the ledger shows only `estimate_usd`.
  - Both doc pages say "the receipt settles at that price once the song completes". That is true only of a run that waited in one process.
- Fix, either of:
  - (a) When `music-status` sees a completed Lyria interaction, record a settlement for the operation, for example a `CostAdjustment` of kind `correction` at `lyriaCost(model)`. Or let `buildCostReceipt` compute a flat-price observation when the job named by `nameJob` completed.
  - (b) Narrow the docs to "a run that waits for the song settles at the list price; a `--no-wait` or resumed run keeps the estimate".
- Either way, add a test for the resume path's receipt.

### M2. Lyria offerings get tagged `voice` in the catalogue (confirmed)
- File: src/catalog/catalog-build.ts:109 `if (meters.includes("requests")) return "voice";`. The new pricing entries use the `requests` meter (src/budget/pricing-catalog.ts, the lyria entries).
- Scenario: `multix catalog models --task voice` prints `gemini:lyria-3-clip-preview  music, voice` and `gemini:lyria-3.5  music, voice` (reproduced with dist/cli.js). The same applies to `catalog recommend -t voice`, `catalog compare -t voice` and the Worker's `multix_model_catalog` / `GET /api/v1/model-catalog`. An agent asking for voice design can be steered to a $0.08 song generator.
- Fix: give `PriceEntry` an explicit `task`, or derive the task from the verified `MODEL_CAPABILITIES` entry before falling back to meters. For example, skip `addTask` from meters when the offering already has verified tasks, or map `requests` to `voice` only for `fish`. Add a catalog test that `gemini:lyria-3.5` has tasks `["music"]`.

### M3. The Worker runs lyria-3.5 (a multi-minute song at 2x the price) under the advertised 30 s audio cap with no uncapped-spend gate
- File: worker/src/jobs/cli-command-policy.ts:244 `"gemini generate-music": { fileOptions: { image: "file", "lyrics-file": "file" } }`.
- Scenario:
  - The `multix_run` tool description tells callers and operators "Caps: ... 30 s audio" (wrangler var `MULTIX_MCP_MAX_AUDIO_SECONDS=30`).
  - A remote caller sends `{"model": "lyria-3.5"}` and gets a song of a couple of minutes at $0.08. Nothing goes through `MULTIX_MCP_UNCAPPED_SPEND`.
  - The comment's argument ("flat price whatever its length") explains why a length cap does not bound cost. But the model choice does change the price, and `priceOptions` exists exactly for "an option whose non-default value sets the price".
  - `minimax generate-music` has the same gap, but that is existing behavior and no reason to repeat it.
- Fix: `priceOptions: ["model"]`. The catalog default `lyria-3-clip-preview` stays capped. `lyria-3.5`, or any other value such as `models/...`, then needs the uncapped-spend path, which `budget` mode satisfies through the proven estimate plus `max_cost_usd`. Add a worker test for this.
- Optional: refuse the clip model when the operator sets `MAX_AUDIO_SECONDS` below 30. CapRules has `fixedSeconds` for video only.

## Low

### L1. `music-status` model guard does not normalise a `models/` prefix
- File: src/providers/gemini/commands/generate-music.ts:184 `Object.hasOwn(LYRIA_MODELS, interaction.model)`.
- Scenario: if the Interactions resource echoes `model: "models/lyria-3.5"`, every `music-status` call throws ValidationError "is a models/lyria-3.5 interaction, not Lyria music". The only resume path for a paid song would then be blocked.
- The tests use bare ids. `lyriaCost` (lyria.ts) and the cost builder already strip `models/`, so the code is inconsistent about the prefix.
- Fix: compare `interaction.model.replace(/^models\//, "")`.

### L2. A paid song whose bytes are neither ID3/MPEG-sync nor RIFF/WAVE cannot be saved, even on resume
- File: src/providers/gemini/lyria-flow.ts:307. `sniffAudioFormat` returns null, then ProviderError.
- Scenario: Google returns MP3 that starts with padding, or a future format. The run fails after billing, and `music-status --download` repeats the same refusal, so the song is lost.
- Fix: fall back to the part's `mime_type` or the requested format, or save it as `.bin` with a warning, instead of discarding billed output.

### L3. The submit read is unbounded
- File: src/providers/gemini/lyria-flow.ts:195. `createInteraction` is called without `maxBytes`, and `fetchJson` has no default cap. Omni passes `interactionMaxBytes()`.
- With `background: true` the response is small, but a synchronous completion with inline WAV would be read uncapped. And a `ResponseTooLargeError` would not get the "may be billed" wording, because `submitError` is not wrapped with `oversizedInteraction` as omni does.
- Fix: pass `maxBytes: interactionMaxBytes()` and wrap the error as omni does.

### L4. `--output` edge cases are silent
- File: src/providers/gemini/commands/generate-music.ts.
  - `--output song.m4a`: the MP3 bytes are copied under the wrong extension with no warning. `resolveMusicFormat` ignores extensions it does not know.
  - `--no-wait --output x.mp3`: `--output` is silently dropped. The JSON says nothing, and the `music-status --download` hint does not carry `--output`.
  - `--output song.wav` with the default clip model fails with "lyria-3-clip-preview supports --output-format mp3 (got 'wav')", although the user never passed `--output-format`.
- Fix: warn on an unknown audio extension. Include `--output` in the resume hint, or warn that it is ignored with `--no-wait`. Word the error after the `--output` extension when the format was inferred.

### L5. `music-status --download` leaves the original session record stale
- Scenario: the resumed download is saved under a new `gemini_lyria_<stamp>` name. The `gemini_lyria_<stamp>.json` written by the `--no-wait` run keeps `status: in_progress` and has no `output_path`.
- This matches `video-status`, so it is acceptable, but worth noting.

### L6. Docs index not updated for the page's new scope
- AGENTS.md says to update `docs-site/src/pages/llms.txt.ts` when a page changes scope. Its Gemini entry still reads "Analyze, transcribe, extract, image, video, and speech commands".
- Not updated either:
  - the `description:` frontmatter of commands/gemini.md (EN and vi);
  - the Gemini row in docs-site/src/content/docs/commands.md (and the vi version).
- The new EN and vi sections themselves are in parity, and their claims match the code (20 MB inline image total, `INLINE_MAX_BYTES`), apart from M1.

### L7. Clip model refuses images; Google's docs are ambiguous
- File: src/providers/gemini/lyria.ts:51 `maxImages: 0`.
- Google's intro says "Both models ... supporting multimodal inputs (text and images)", but the image section documents only lyria-3.5 (up to 10).
- The refusal is the safe direction (it happens before billing). Confirm that the live API refuses images on the clip model, or record the evidence in the comment.

### L8. `lyria-3-pro-preview` is listed on the pricing page ($0.08) but rejected
- This may be intentional scope. The rejection message offers only the two supported ids. Mention it, or note it as out of scope in the issue.

## Missing tests
- `music-status` has no tests:
  - the model guard (L1);
  - `--download` implying a wait;
  - failed or cancelled exits (`terminal` flag);
  - summary output without audio bytes;
  - the `findInteractionKey` resume text (`musicResumeCommand` in the oversized error).
- `estimateCommand("gemini generate-music", ...)` has no budget test: the default model, `--model lyria-3.5`, and the `models/` prefix.
- The receipt is never tested end to end: the waiting run should settle at 0.04/0.08 (`computed_from_usage`). The current test only checks the `postUsage` push.
- No worker test of the `generate-music` policy: variadic `image` file input, `lyrics-file`, the M3 gate.
- No catalog test for the Lyria task tags (M2).
- `tests/smoke/parse-args.test.ts` does not list the gemini `generate-music`/`music-status` subcommands (minor).

## Edge cases checked and found OK
- Lost response, 5xx or timeout on submit: no retry, "may be billed" message, one POST (tested).
- A 429 rotates to the next key; polls stay on the accepting key (tested).
- A run stopped by a signal after acceptance: `trackInFlight` makes the envelope offer `music-status <id> --download`, not a rerun. This is better than omni, which does not set `inFlight`.
- A provider-failed job (`ProviderJobFailedError`) is not reported as resumable.
- `--lyrics` together with `--lyrics-file` is refused.
- The lyrics file is capped at 64 KB, has its BOM stripped, and an empty file is refused. Image types are allow-listed, URLs refused, the total inline size capped.
- Inline audio is size-checked before it is decoded. The interaction read is capped by `interactionMaxBytes()` (omni's limits).
- Worker: the image and lyrics URLs keep their last path segment, so the extension needed by `getMimeType` survives. `--output` is placed in the job output directory. `music-status` falls through to the default policy and is runnable.
- The omni refactor keeps its default resume (`video-status`). The oversized-body message is now provider-neutral, and no test depended on the old text.

## Recommended actions (priority order)
1. M2: fix the catalogue task derivation for `requests`-metered non-Fish entries, and add a test.
2. M3: add `priceOptions: ["model"]` to the Worker policy, and add a test.
3. M1: either settle the receipt on a resumed completion, or correct the EN and vi docs. Add a test.
4. L1: normalise the `models/` prefix in the `music-status` guard.
5. L2 and L3: harden saving of billed output and the submit read.
6. Add the missing tests, then the L6 docs index and description updates.

## Unresolved questions
- Does the live Interactions resource ever return `model` with a `models/` prefix? This decides how severe L1 is.
- Does `lyria-3-clip-preview` really reject image input (L7)?
- Is `lyria-3-pro-preview` meant to be out of scope for #527 (L8)?
