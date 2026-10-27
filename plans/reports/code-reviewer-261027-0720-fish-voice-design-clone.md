# Code review: Fish voice design + voice model management

Reviewed: commit 26f5ee3 `feat(fish): add voice design and voice cloning commands` (the uncommitted diff was committed while the review ran; the file set and line counts match). Line numbers refer to HEAD.

## Scope
- Files: src/providers/fish/{voice-design.ts, voices-client.ts, models.ts, commands/voice-design.ts, commands/voices.ts, commands/index.ts}, src/budget/{pricing-catalog,cost-estimate,command-cost}.ts, src/capabilities/command-capabilities.ts, worker/src/jobs/cli-command-policy.ts, worker/src/cli-catalog.json, tests/unit/providers/fish/voice-*.test.ts, worker/test/run-argv-builder.test.ts, README.md, skill/SKILL.md, docs-site EN+VI
- About 2.1k LOC added
- Checks run: `npm run typecheck` passes; `npx vitest run tests/unit/providers/fish` passes (6 files, 115 tests); `worker: vitest run test/run-argv-builder.test.ts` passes (60); biome reports no issues on the touched files. I also bundled a probe with esbuild to confirm the receipt and validation behavior described below.
- Fact check against the official Fish docs (fetched on 2026-10-27): the voice-design request fields, the `model: voice-design-1` header, flat billing per request, no billing for failed requests, and the POST /model multipart fields all match. **The voice-design response schema has no signature field.** It has only id, index, audio_base64, sample_rate, duration_ms, text, instruct and language. The create-model page says only that signatures "come from /v1/voice-design candidates" and names no field.

## Overall assessment
The change is solid and follows the patterns in `fish tts`. It has no `node:*` imports in the clients. Paid POSTs are sent once with no retry. The unknown-state mapping for gateway 5xx, cut-off streams and broken JSON matches tts-client. The key is not echoed, and the instruction is recorded only as its length and a hash. File paths for samples come from the user, or in the worker they are written by the server under `in/`. Output names are generated, so no path is injectable. I found no blocking defects. The main issue is that the code, tests and docs rely on a response field that is not documented.

## Findings

### 1. Optional (medium): guessed `signature` response field, which docs present as a working flow
- Where: src/providers/fish/voice-design.ts:213; tests/unit/providers/fish/voice-design.test.ts:130,154; README.md:625; docs-site/src/content/docs/commands/fish.md (Voice design + Clone sections, EN and VI); skill/SKILL.md (clone example).
- Problem: the code reads `c.signature ?? c.voice_design_signature`, and neither name is in Fish's documented response. The test puts `signature: "sig-1"` into its mock, so it passes against a contract that only exists in the test.
- Failure scenario: against the real API, every candidate's `signature` will probably be `null`. A user or agent following the README ("pass its `signature` as `--voice-design-signature`") or the docs example `--voice-design-signature <signature>` has no value to pass. If they pass the candidate `id` instead, Fish rejects the whole create ("an invalid signature rejects the request").
- Fix:
  - Either confirm the real field name with one live call (gated smoke test, key not printed) and pin it, or remove the guess.
  - In the docs, say that Fish does not document where the signature comes from. Drop the unconditional README wording.
  - Mark the mock field as speculative in the test, or remove it.

### 2. Optional (low/medium): a successful voice-design run gets an `unknown` cost receipt, not $0.01
- Where: src/budget/cost-receipt.ts:101-118 (`measuredUnits` never sets the new `requests` meter); src/budget/pricing-catalog.ts:517-529.
- Verified: `buildCostReceipt({outcome:"ok", model:"voice-design-1", calls:[{POST,200}]})` returns `status:"unknown", actual_usd:null` with the reason "there is no trusted price for the measured usage". The pre-flight estimate for the same request is `estimated / 0.01 / proven`.
- Failure scenario: history and receipts, and any budget ledger that settles from receipts, record every successful voice design as unknown spend. That contradicts the verified flat rate this change adds.
- Fix: when the rate has a `requests` component, set `measured.requests` to the number of successful (2xx) billable calls in `buildCostReceipt`/`measuredUnits`. Add a receipt test.

### 3. Optional (low): the worker output cap is bypassed when `--count` is omitted
- Where: worker/src/jobs/cli-command-policy.ts:162; src/providers/fish/commands/voice-design.ts:206; worker/src/jobs/run-option-caps.ts:50-54.
- Problem: `applyCaps` checks only a given value or the CLI default. `--count` has no CLI default, so an omitted count passes, and Fish then generates its default of 2.
- Failure scenario: an operator sets `MULTIX_MCP_MAX_OUTPUTS=1`. A remote `fish voice-design` without `count` still produces and uploads 2 files. Cost is not affected because billing is per request.
- Fix: give the CLI option the default `"2"`, which matches Fish's default and lets the cap see it. Or add a fill rule that sends `--count` equal to min(2, maxOutputs) when it is omitted.

### 4. Optional (low): the response cap of about 10.7 GB does not bound memory, and an oversize body is mislabelled
- Where: src/providers/fish/commands/voice-design.ts:118-119; src/providers/fish/voice-design.ts:275-279.
- Problem: `maxBytes` is ceil(2048 MiB × 4 × 4/3) + 64 KiB, roughly 10.7 GB, buffered in memory. A body larger than V8's maximum string length (about 512 MiB) makes `TextDecoder.decode` throw inside the JSON try block. That error is reported as `UNKNOWN_REMOTE_STATE`: "the 200 response is not complete JSON".
- Failure scenario: a misbehaving upstream or proxy streams a huge 200. The CLI holds gigabytes in memory before failing with a misleading unknown-state message, when it should report "too large, still billed".
- Fix: use a realistic cap, for example 4 candidates × a per-candidate cap of 64 MB × 4/3. Map a decode `RangeError` to `ResponseTooLargeError`, which is billed.

### 5. Optional (low): candidate numbering is inconsistent between file names and messages
- Where: src/providers/fish/commands/voice-design.ts:144 vs :160 and :232.
- Problem: files are named by response order (`_${i + 1}`). Log lines and warnings use Fish's own `index`, which starts at 0 in the schema.
- Failure scenario: the output prints "Candidate 0: …_1.wav". A warning for "candidate 0" is ambiguous if Fish repeats an index, which the code itself expects ("may repeat or skip").
- Fix: use the same 1-based position in messages and warnings, and keep Fish's `index` as a field.

### 6. Optional (low): an empty-candidates 200 is recorded as `uncertain` spend
- Where: src/providers/fish/voice-design.ts:281-286 together with cost-receipt's "outcome failed after billable call" branch.
- Problem: the code says Fish does not bill an empty result, but the receipt marks the run as possibly charged.
- Fix: this is acceptable if left alone. Otherwise, tag the error so the receipt can settle at $0, or document it.

### 7. Optional (low): the clone upload is capped at 300 s with no override
- Where: src/providers/fish/voices-client.ts:188.
- Problem: up to 20 × 50 MB samples must upload within 300 s, which needs more than about 27 Mbit/s for 1 GB.
- Failure scenario: on a slow uplink the upload aborts. The run ends as `UNKNOWN_REMOTE_STATE` and the user is told to check `voices list`, even though Fish almost certainly never received the full body.
- Fix: scale the timeout with the total upload size, or expose `--timeout`.
- Related: about 1 GB of samples is also held in memory twice (`readFileSync` copy plus `Blob`; commands/voices.ts:66). This is acceptable but worth a note.

### 8. Optional (low): the worker rejects sample URLs without an extension
- Where: src/providers/fish/commands/voices.ts:52-58 together with worker/src/jobs/run-input-files.ts:29 (`safeFileName` keeps only the URL's own extension).
- Problem: a signed or CDN URL with no `.wav`/`.mp3` suffix becomes `in/0-<name>`. `readFishSample` then refuses it because of its extension, even though the bytes are valid audio.
- Fix: fall back to the sniffed kind when there is no extension and require only that sniff and extension agree when an extension exists. Or document the constraint in the MCP docs.

### Nits, not reported as findings
- `checkFishAudio` messages say "asked for wav / asked for N Hz". In voice design the user asked for neither, so the wording is misleading.
- `signature_ok` (WAV header) and `signature` (voice-design signature) sit next to each other in the JSON with unrelated meanings.
- The try/catch around `readCappedText` in `createFishVoice` (voices-client.ts:196-200) is dead code, because `readCappedText` never throws. The broken-body case is handled later by the JSON parse, so behavior is still correct.

## Verified non-issues
- No retries: `createFishVoiceDesign` and `createFishVoice` call `fetchFollowingRedirects` once. `fetchJson` (PATCH and DELETE) has no internal retry.
- `crossOrigin: "error"` on keyed requests, so the key is not forwarded on a cross-origin redirect.
- `voiceId()` limits ids to `[A-Za-z0-9_-]{1,128}`, and the URL uses `encodeURIComponent`.
- Remote `fish voices delete` / `update` follow the existing `elevenlabs voices delete` precedent and run on the caller's own key.
- The `--reference-text` 300 vs 150 limit is a deliberate, documented decision, and a rejection is not billed.
- Typecheck: the new `requests` PriceMeter does not break any exhaustive `Record<PriceMeter,…>`.
- Estimate: `fish voice-design` reports `estimated $0.01, upper_bound proven`. `voices create` has no builder, so it is unknown and `--max-cost` refuses it, as the docs say.

## Recommended actions
1. Resolve finding 1: confirm the signature field live or remove the guessed field and the docs claims.
2. Fix finding 2 so receipts settle at $0.01.
3. Default `--count` to 2 (finding 3).
4. Findings 4 to 8 are clean-ups and can be handled now or in a follow-up issue.

## Unresolved questions
- What field does the real /v1/voice-design response use for the signature that `voice_design_signatures` expects, if any? Is it the candidate `id`?

## Resolution (author)

- 1 fixed: the undocumented `signature` field is no longer read or reported; docs no longer claim `fish voice-design` returns one. `--voice-design-signature` stays (it is a documented create field).
- 2 fixed: receipts count successful billable calls for a per-request rate, so a successful voice design settles at $0.01.
- 3 fixed: `--count` defaults to 2 (Fish's default), so the worker output cap sees it.
- 4 fixed: the response cap is one download's worth (base64 included), and a body too long for one string reports too large and still billed.
- 5 fixed: candidates carry a 1-based `number` used in file names and messages.
- 6 kept: a 200 with no candidates stays an uncertain receipt; that is the conservative side and Fish's no-bill claim cannot be confirmed from the response.
- 7 fixed: the clone timeout grows by 1 s per 100 KB of samples.
- 8 fixed: a sample with no extension is typed by its audio header.
