# Code review: native Fish Audio provider (issue #357)

Date: 2026-10-27 (UTC). Scope: uncommitted working tree in /workspace/multix-cli
(42 modified files + src/core/response-read.ts, src/providers/fish/**, tests/unit/providers/fish/**, docs-site fish pages).
Reviewer did not write the code; no source files were modified.

## Verification run

- `npx vitest run tests/unit/providers/fish tests/speech tests/unit/budget tests/unit/agent/fetch-telemetry.test.ts tests/unit/providers/openrouter`: 17 files, 354 passed, 2 skipped.
- `npm run typecheck`: clean. `npm run lint` (biome, 571 files): clean.
- `npm run check:mcp`: worker typecheck, tests and bundle check pass (no `node:*` in the bundle).
- `npm run build`, then `--dry-run --json` runs of `fish tts` (BOM text file, turns file) and `speech generate --provider fish` against dist/cli.js (dummy key, no network).
- Not run: `npm run verify:docs`, the full `npm test`.

## Findings

### Medium

**M1. `fish tts --text-file` sends the UTF-8 BOM to Fish in real runs.** `src/providers/fish/commands/tts.ts:98` and `src/agent/cost-preflight.ts:47-58`.
`fish tts` is a priced command, so `preflightCost()` runs on every invocation (`pricedCommands().includes(run.command)`). `textFileContent()` stores the raw file text, BOM included, in `run.textFile`. `readUtf8()` then returns `run.textFile.text` early, and the `.replace(/^﻿/, "")` on line 106 never runs.
Reproduced on the built CLI. A file containing `EF BB BF "Hello there"` dry-runs with `"body":{"text":"﻿Hello there"}` and `utf8_bytes: 14` (11 + 3).
Impact: an invisible character goes into a paid generation, adds 3 billed bytes, and may produce an audible artifact or confuse normalization. The unit test "reads --text-file without a BOM" passes only because it calls commander directly and skips the preflight, so it gives false confidence. `speech generate` hides the same issue because it calls `.trim()`, which strips U+FEFF. `fish tts` does not trim, and it should not, since the text is sent verbatim.
Fix: strip the BOM once in `textFileContent()` (`fs.readFileSync(path,"utf8").replace(/^﻿/, "")`), so the priced text and the sent text stay identical. Or strip it in the early-return branch of `readUtf8`. Add a test that sets `run.textFile` (or goes through `preflightCost`) before the command runs.

**M2. Sample rate is read but never checked, although README, SKILL.md and docs say it is.** `src/providers/fish/audio-check.ts:167-244` and `src/providers/fish/commands/tts.ts:318-333`.
`checkFishAudio` returns `sample_rate_hz` but never compares it to the requested rate. `runFishTts` copies it into the result without comparing either. Example: `--format wav --sample-rate 16000` comes back as a 44.1 kHz WAV, and the run reports success with `sample_rate_hz: 44100` and no warning. For `pcm`, nothing is verifiable, yet `duration_s` is computed from the assumed rate (`pcmRate`) and reported as `pcm_size` fact.
Request-side validation also accepts any integer from 8000 to 192000. Fish documents WAV/PCM at 8, 16, 24, 32 and 44.1 kHz, MP3 at 32 and 44.1 kHz, and Opus at 48 kHz. A value outside those lists is either a 4xx or is silently resampled, and the missing check would not catch the second case.
Fix: pass the expected rate (`input.sampleRate ?? format default`) into `checkFishAudio` for wav/mp3/opus, and add a problem (warning, or failure) when `sample_rate_hz` differs. Restrict `--sample-rate` per format to the documented list. Add tests for a mismatch.

**M3. Raw PCM can be falsely rejected as "text" after a paid generation.** `src/providers/fish/audio-check.ts:184-192`.
For `format === "pcm"`, `signatureOk = sniffed === undefined && problems.length === 0`, and `problems` includes the `looksLikeText` heuristic. That heuristic is true when the first non-whitespace byte is `<`, `{` or `[` (0x3C, 0x7B, 0x5B). For 16-bit LE PCM the first byte is the low byte of sample 0. Any non-silent opening sample whose low byte is one of those 3 values fails, about 1 in 85 requests whose first sample is not exactly zero (bytes 0x09, 0x0A, 0x0D and 0x20 are skipped first).
Impact: `runFishTts` throws ProviderError "not pcm audio" for valid audio that was already billed, which invites a paid retry. A JSON or HTML body labelled as such is already caught by the content-type check in `tts-client.ts:247`.
Fix: for pcm, do not use `looksLikeText` alone. Require a real JSON or HTML parse of the first bytes (for example, the decoded prefix parses as JSON or starts with `<!doctype`/`<html`), or skip the heuristic for pcm when the response MIME was `audio/*`. Add a test with PCM whose first byte is 0x5B.

**M4. Remote MCP callers cannot repeat `--voice` or `--dictionary` on `fish tts`.** `worker/src/jobs/cli-command-policy.ts:158-160`.
Both options use a custom `collect` parser with no array default. In `worker/src/cli-catalog.json` they are `variadic: false` with no default, so `isRepeatable()` (`worker/src/jobs/cli-catalog.ts:47-53`) returns false. `run-argv-builder.ts:116` then rejects an array with "--voice takes a single value".
Impact: over MCP, `<|speaker:N|>` multi-speaker text with several voices is impossible, and so are 2 or 3 pinned dictionaries. The docs advertise both. Only `--turns-file` works.
Fix: add `repeatable: ["voice", "dictionary"]` to the `fish tts` policy, as `scene`/`extra` policies already do, and add a worker test that prepares a run with two voices.

### Low

**L1. The turns file is read twice (preflight, then the command).** `src/agent/cost-preflight.ts:62-73` vs `src/providers/fish/commands/tts.ts:197`.
`--text-file` reuses the priced text, but `--turns-file` does not. If the file changes between the two reads, `--max-cost` approved a different byte count than the one sent. The window is small, but the PR claims `--max-cost` works for `--turns-file`.
Fix: cache the parsed turns text on `run` like `run.textFile`, or re-check the byte count against the estimate before sending.

**L2. `fish tts` without `--voice` sends no `reference_id`.** `src/providers/fish/tts-request.ts:362`.
Fish then picks an unspecified voice, while `speech generate --provider fish` defaults to Adrian (`speech-catalog.ts`, whose comment says a request without reference_id "gets an unspecified voice"). Two routes billed the same way give different voices.
Fix: default to `FISH_PUBLIC_VOICES.adrian` in `fish tts` too, or document that the native command sends no voice.

**L3. The façade does not integer-check `fish.chunk_length`.** `src/commands/speech/speech-adapters.ts:245`.
`num()` accepts 150.5, and `planFishTts` only range-checks it, so Fish gets a non-integer `chunk_length` (a 4xx, which costs nothing). The native CLI path uses `int()`.
Fix: check `Number.isInteger` in `planFishTts`.

**L4. A Fish 5xx error with a JSON body is reported as a plain HttpError (meaning not billed).** `src/providers/fish/tts-client.ts:237`.
The code assumes "Fish's JSON is a definite answer that nothing was generated". `isFishError` accepts any JSON object with `status`, `message` or `detail`, and some proxies emit such bodies too. Low risk because the POST is never retried, but the message tells the user it is safe to resend.
Fix: consider UNKNOWN_REMOTE_STATE for every 5xx, or restrict "definite" to 4xx.

**L5. Error snippets may echo request text.** `src/providers/fish/tts-client.ts:139-156`.
`fishErrorMessage` JSON-stringifies an array `detail`. Validation errors in that style often include the offending `input` value (the prompt), up to 500 chars, which then lands in HttpError messages and logs. That conflicts with "never log full prompts".
Fix: map `detail[]` to `loc`/`msg` only.

**L6. `voices list` never shows its pagination hint.** `src/providers/fish/voices-client.ts:84`.
Per the Fish docs, `has_more` is optional or null. With `has_more` null, the "more on --page" hint is never printed.
Fix: fall back to `total > page_number * page_size`.

### Nit

- `src/providers/fish/models.ts:43`: `FISH_VOICE_ID` is exported and never used.
- `src/providers/fish/commands/tts.ts:412-414`, plus README/SKILL ("one inline --dictionary-file"): the dictionary file also accepts reference dictionaries and up to 3 inline dictionaries. Align the help text, or reject references in the file.
- `src/providers/fish/audio-check.ts:116-121`: a Xing/Info header frame is counted as audio (+26 ms). Ignore it unless exact duration matters.

## Checks that passed (risk calibration)

- Model header: allowlist enforced in both the CLI (`parseFishModel`) and the client (`createFishSpeech`). The exact header value is sent, and `model_confirmed_by_response: false` is reported. Dry run shows only the `model` header value; Authorization stays hidden (test present).
- Pricing: drama-3 is $10/M until 2026-11-12T17:00Z, then $50/M. `upper_components` takes the max over nearby windows, so a ceiling just before the cutoff uses $50. s2.x and s1 are $15/M. s2.1-pro-free is an explicit $0 entry. An unknown model resolves to `unknown`, not $0, and `--max-cost` fails closed (test present). The estimate and the sent text match for `--turns-file` (dry-run verified: tags included, 37 bytes).
- No retry. Network failures map to UNKNOWN_REMOTE_STATE unless the codes prove the request was never sent. Oversize responses are aborted with a "still billed" note. Idle and overall timeouts are present. Cross-origin redirects are refused, so the key never leaves api.fish.audio.
- Runtime-neutral clients: no `node:*` in fish/*-client, tts-request, audio-check or core/response-read. Bundle check passes. The extraction of response-read from openrouter/speech-client behaves the same as before (re-exported names kept).
- Secret names: the order in `worker/src/provider-secret-names.ts` (ELEVENLABS, FISH, FAL) mirrors `src/providers/provider-keys.ts`. Commands are listed in `command-capabilities.ts` (`fish tts` as a task command, `fish voices list|get` as utilities).
- Worker fileOptions: `text-file`, `turns-file` and `dictionary-file` are all `file` kind, so callers supply https inputs and never write their own paths. `--output` uses the shared bare-name rule. No new path surface.
- Dictionaries: at most 3, references and inline never mixed, `latest`/`V<n>` rejected, phoneme markers rejected, unknown fields rejected. These match the documented schema.

## Test coverage gaps

1. No test runs `preflightCost` plus the command together for `fish tts --text-file` or `--turns-file`. This gap is how M1 got through. `fishTurnsText` has no direct test.
2. No sample-rate mismatch test (M2), and no PCM test with a first byte of `[`, `{` or `<` (M3).
3. No worker test for the `fish tts` policy (repeatable options, file inputs) (M4).
4. No test for the 3xx and cross-origin redirect paths of `createFishSpeech`.

## Unresolved questions

- Does Fish bill `<|speaker:N|>` tag bytes? The estimate counts them, which is a safe upper bound, but the docs could confirm.
- Does `s2.1-pro-free` ever bill (for example, when a free quota is exhausted)? If it does, a $0 ceiling would let `--max-cost` pass a paid run. The pricing page lists $0, so the entry follows the spec.
