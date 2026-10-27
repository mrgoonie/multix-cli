# Code review: fal tts input checks (#315)

Scope: uncommitted diff on origin/dev (5e70a6d): src/providers/fal/speech-input.ts, speech-output.ts, speech-models.ts, src/capabilities/model-discovery.ts, three test files, docs-site fal.md (en, vi), skill/SKILL.md. About 355 lines added and 36 removed.

Checks run: `npm run build` OK, `npx vitest run tests/unit/providers/fal tests/unit/capabilities` 177 passed and 2 skipped, `npm run typecheck` clean, `biome check src tests` clean. I also ran a throwaway probe test (now deleted) against the source. No `node:*` imports were added to speech-input.ts or speech-models.ts. I compared the fal Gemini 3.8 and ElevenLabs v4 schemas with the live OpenAPI at fal.ai/api/openapi/queue/openapi.json.

## Findings

### Medium 1: explicit `null` fields, which fal's schema allows, are now refused
- speech-input.ts:180 (`dialogue = ... has(profile.dialogueField)`) and speech-input.ts:228 (`checkLanguage(extra[...])`).
- In the live Gemini schema, `prompt`, `speakers`, `turns` and `style_instructions` are all `anyOf [..., null]`. The ElevenLabs `language_code` is `anyOf [string, null]`. Payloads copied from the fal playground or written by other tools often include these nulls.
- Probe results:
  - `--input '{"prompt":"Hi","speakers":null,"turns":null}'` fails with `Omit the text when --input has "turns"`. Before this change it passed through, and fal accepts it.
  - ElevenLabs `--input '{"language_code":null}'` fails with `must be a language code ..., got null`. Before this change it passed through.
- This breaks inputs that used to work, which the brief asked to avoid.
- Fix: treat a `null` value as absent. For example, use `const present = (f) => has(f) && extra[f] !== null;` for the dialogue detection and the language/voice/format `--input` branches. Keep `null` in the forwarded `input`, or drop it. Add one test per field.

### Low 2: `speakers` without `turns` is not checked
- speech-input.ts:180-193. The checks only run when `turns` is present. Probe: `--input '{"speakers":[{"speaker_id":"a","voice":"Bogus"}]}'` with a text passes untouched, even though the schema says speakers is min/max 2 with a voice enum.
- Item 2 promises that `--input` values meet the voice enum. The spec defines a dialogue as "`turns` present", so this is arguably out of scope.
- Fix: run the speakers check whenever `speakers` is present and not null. Or refuse `speakers` without `turns`, since the fal prompt description says "For dialogue, omit prompt and provide speakers and turns instead".

### Low 3: extra keys in speakers and turns are passed through, but fal's schema forbids them
- speech-input.ts:139. SpeakerConfig and SpeechTurn are `additionalProperties: false`. Probe: `{speaker_id:"a",voice:"Kore",x:1}` is forwarded.
- If fal only fails these after queueing, as the code comment says it does for malformed dialogues, the job is still billed.
- Fix (optional): refuse keys other than `speaker_id`/`voice`, and `speaker_id`/`text`/`style_instructions`.

### Low 4: the language regex refuses some valid BCP 47 tags
- speech-input.ts:68 `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/`. Probe: `--language zh-Hant-TW` and `en_US` are refused. Before this change `--language` took any string.
- The only model with a language field is ElevenLabs, whose schema says ISO 639-1. So the practical impact is small, and the regex is already looser than that schema (it allows 3 letters and a subtag).
- Fix (optional): allow repeated subtags, `/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/`. Leave the underscore form refused.

### Low 5: a WAV with an empty `data` chunk followed by a trailing chunk is accepted
- speech-output.ts:129. Probe: 44-byte header with data size 0, then a 20-byte `LIST` chunk, gives `verified: true`. The size heuristic counts the trailing chunk as samples.
- This fails in the lenient direction, so it is not a regression. I recommend leaving it. If you want to tighten it: when the `data` size is non-zero and smaller than the remaining bytes, trust the declared size.

## wavDataOffset edge cases checked (no defect)
- Every pass advances by at least 8 bytes, so the loop always ends. A huge chunk size jumps past `head`, returns undefined and falls back to 44. Reads stay in bounds (`at + 8 <= head.length`). The DataView respects `byteOffset`, which matters for Buffer subarrays.
- An odd-sized chunk without padding (a common writer bug) makes the parser miss `data`. It then falls back to 44 and accepts the file. Probe: 59-byte file gives `verified: true`. So valid WAVs are not refused.
- A WAV no longer than 44 bytes cannot hold samples (12 RIFF + 24 fmt + 8 data), so the fallback cannot refuse a valid file. The streaming case (data size 0 with samples following) is accepted and tested.
- `readHead` now reads 512 bytes. `saveSpeechAudio` passes `downloaded.bytes`, and `fal result --download` uses the same function, so both paths get the check.

## Paging (item 4)
- readFal returns `truncated: true` on an empty page or a repeated cursor. listFalSpeechCatalog stops quietly, as it already did at maxPages. Both are tested.

## Unlisted-model path
- Unchanged. Without a profile there is no voice, language or dialogue check, and a non-string text from `--input` still passes (the test at speech-input.test.ts covers `speaker: "anything"`).

## Docs
- en and vi say the same thing. The claims match the code: two speakers, distinct ids, voices from the list, non-empty turns, text and `--voice` refused, and fal returning 422 (#310, still open, title confirmed by REST).
- "counted in characters" is accurate (code points). The language examples (`en`, `vi`, `pt-BR`) pass the regex. SKILL.md matches.
- Small nit: the vi line "...sẽ bị từ chối và không để lại file nào. `fal result <model> <id>" has not been rewrapped. Cosmetic only.

## Verdict
The change meets all four items with matching tests and no failing checks. Medium 1 should be fixed before merge: it refuses fal-valid payloads with null fields that passed before this change. The rest are optional hardening.

Status: DONE_WITH_CONCERNS
Summary: All four items are implemented and the tests, types and lint pass. One medium regression: `null` in `turns`/`speakers`/`language_code` from `--input`, which fal's schema allows, is now refused. The other findings are low.
