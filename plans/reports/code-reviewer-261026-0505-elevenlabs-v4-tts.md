# Code review: commit 6e9141c, ElevenLabs Eleven v4 / v4 Turbo TTS (issue #292)

Reviewer: separate review context that did not write the code. Base: origin/main (5151636).

## Scope
- Files: src/providers/elevenlabs/{models.ts,tts-request.ts,client.ts,commands/tts.ts}, tests/unit/providers/elevenlabs/{tts-request,tts-command,live}.test.ts, worker/src/cli-catalog.json, README.md, docs-site (en + vi), skill/SKILL.md
- LOC: +932 / -45
- Checks run:
  - `npx vitest run tests/unit/providers/elevenlabs`: 45 passed, 2 skipped (the live tests, which are gated)
  - `npm run typecheck`: clean
  - `npm run build`: ok
  - worker `test/cli-catalog.test.ts`: 6 passed (the catalog matches)
  - `npm run lint`: clean only with an uncommitted working-tree fix (see M1)
  - Dry runs: v4 `--style 0.0` and `--no-speaker-boost` are rejected; the default v4 payload has only stability and similarity_boost; v3 `--previous-text` is rejected; Flash `--style` warns and still sends it; v4 `--timestamps` hits `/with-timestamps`; `--voice abc/../x` is rejected.

## Overall assessment
The core change is correct and matches the issue:
- v4 and v4 Turbo get a strict payload.
- Legacy payloads are byte-identical when no new flags are passed (confirmed by test and dry run).
- Credits come only from the provider's `character-cost` header (`usage-extract.ts:160` already maps it).
- `tts-request.ts` has no `node:*` imports.
- Paid tests are gated behind `MULTIX_LIVE_TESTS=1` plus the key.

I found no critical defects. The one blocking item is CI hygiene: the committed tree fails lint. The other findings are behavior changes for legacy models that contradict the commit message's claim that existing invocations are unchanged, a non-durable failure path after billing, and test gaps.

## Critical
None.

## High
None.

## Medium

### M1. The committed test file fails `npm run lint` (Biome format). CI will fail.
- **Where:** tests/unit/providers/elevenlabs/tts-command.test.ts:87-89
- **Evidence:** `git show 6e9141c:<file> | npx biome check --stdin-file-path=...` exits 1 ("contents aren't fixed"). The working tree has an uncommitted fix that collapses the `toContain(...)` onto one line, and `npm run lint` passes only with that fix.
- **Failure scenario:** the PR is pushed from the commit, not the working tree, and the lint job goes red.
- **Fix:** commit the working-tree change, or amend the commit with it.

### M2. `--timestamps`: a malformed or unexpected 200 body loses already-billed audio, and the error is unclassified.
- **Where:** src/providers/elevenlabs/commands/tts.ts:93-103
- **What happens:** `JSON.parse(bytes.toString("utf8"))` runs after the request has been billed.
  - A non-JSON 200 (a proxy or CDN body, a truncated stream, or a future change to the response) throws a raw `SyntaxError`. `exitWithError` then classifies it as an unknown error, not a `ProviderError`.
  - The bytes are discarded, so the user pays and gets nothing on disk.
  - A missing `audio_base64` raises a `ProviderError`, but that path also persists nothing.
- **Fix:** wrap the parse in try/catch and throw `ProviderError("ElevenLabs /with-timestamps returned non-JSON ...", "elevenlabs")`. Optionally save the raw body to `<stamp>.with-timestamps.raw` before throwing, so the paid output is recoverable.
- **Tests:** add a command test for each case (non-JSON body, and JSON without `audio_base64`).

### M3. The claim "Older models keep their previous payload ... existing invocations are unchanged" is not fully true.
`buildTtsRequest` now hard-fails inputs that earlier versions sent to the API:
- **Language code** (tts-request.ts:67, 157-162): `--language-code pt-BR`, `zh-CN` and other BCP-47 tags now throw for every model. Before this change they were passed through. Confirmed with `--model eleven_flash_v2_5 --language-code pt-BR --dry-run`, which fails with INVALID_INPUT.
- **Voice settings** (tts-request.ts:72-78): non-numeric or out-of-range `--stability`, `--similarity-boost` and `--style` now throw on legacy models. Before, `parseFloat` produced NaN, which was sent as `null`, and the API applied its default.
- **Output format** (tts-request.ts:99-103): any `--format` outside the hardcoded list now throws, including a valid format ElevenLabs adds later. Unknown *models* only get a warning, so the two policies are inconsistent.
- **Text length** (tts-request.ts:150): the limit uses `o.text.length` (UTF-16 code units), which overcounts emoji and other astral characters. Text that is within the API's limit can be rejected locally.

These are defensible hardening choices, and the voice-id regex in particular closes a path-injection hole in the endpoint. But they are behavior changes the commit message and docs deny. Options:
- (a) Keep the checks and reword the commit message and docs: "validation of malformed values is new for all models".
- (b) For non-strict models, downgrade the language-code shape and unknown-format checks to warnings, matching the unknown-model policy.
- (c) Accept `^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$` for the language code.

For text length, count code points (`[...o.text].length`) or only warn when the two counts disagree.

## Low

### L1. Error message order on strict models.
- **Where:** tts-request.ts:132
- **What happens:** `values[key]()` runs before the strict-model check. `--model eleven_v4 --style abc` therefore reports "--style must be a number" instead of "--style is not used by eleven_v4".
- **Fix:** check caps and explicitness before parsing the value.

### L2. The audio-tag heuristic gives false positives.
- **Where:** tts-request.ts:68 (`/\[[a-z][a-z ,'-]{0,40}\]/i`)
- **What happens:** it matches ordinary bracketed prose such as "[sic]" or "[citation needed]" and markdown link text, so Flash, Turbo and multilingual_v2 users see a spurious warning. It is only a warning, so the impact is low.

### L3. Docs gaps.
- The docs-site model table (en and vi) omits `eleven_flash_v2` and `eleven_turbo_v2`.
- README's "Text length per request" line omits their 30,000 limit.
- "Every `tts` run prints the characters ..." is only true when the header is present. The code correctly prints nothing when it is absent.

### L4. A redundant write with `--timestamps`.
- **Where:** tts.ts:115
- **What happens:** when `--output` resolves to the same directory and stem as `dest`, the alignment file is written twice. This is harmless.
- **Separately:** writing a sidecar next to the user's `--output` copy is a new side effect, which is documented.

### L5. The narrowing of `charged` is fragile.
- **Where:** tts.ts:86-90, 118
- **What happens:** `let charged: string | null = null` is assigned inside a callback. TypeScript narrows it to `null` at the later check, so inside the `if` it is typed `never`. Runtime behavior is correct.
- **Cleaner alternative:** have `apiPostBinary` return the headers, or use a `{ value }` holder object.

## Verification gaps (tests)
- No test for `--timestamps` with a non-JSON body or a missing `audio_base64` (M2).
- No command-level test that legacy-model warnings reach stderr. The only command test with a legacy model asserts `stderr` is empty.
- No offline test that `--json` reports `usage.credits` from `character-cost` on the TTS path. Only the paid live test covers it. A stubbed-fetch run through `installAgentRuntime`, or an `extractUsage` unit test if one does not already exist, would close this.
- No test that explicit-vs-default detection treats a default value passed explicitly (`--style 0.0`) as explicit at the commander level. The dry run confirmed it works today.
- Capability-table values I could not confirm against the provider, because they are outside the stated ground truth: v3 max 5,000; v3, Flash and Turbo ignoring style and speaker boost; multilingual_v2 ignoring `language_code` rather than rejecting it; v4 Turbo at 0.5x character cost.

## Edge cases checked (no issue found)
- Default invocation without new flags: the multilingual_v2 payload is unchanged, with no warnings.
- `--no-speaker-boost` explicitness via `getOptionValueSource("speakerBoost")`: works, and the default source is "default".
- Unknown model id: sent unchecked with a warning, and `--clone-strength` is passed through.
- `Object.hasOwn` guards against `constructor` and other prototype keys.
- The alignment file is written with `fs.writeFileSync` on the default `fs` object. That object is wrapped by output-file-tracker, so the alignment file appears in the `--json` outputs.
- `/with-timestamps` bodies larger than MAX_JSON_BYTES skip body parsing in telemetry, but header credits are still recorded.
- MCP: `elevenlabs tts --output` follows the generic `OUTPUT_FILE_OPTION` policy, and the sidecar lands in the job's output directory.
- `extFromFormat` now maps `wav_*`, `opus_*` and `alaw_*` correctly. sfx, music and voice-changer still use the old list, so they are unaffected.

## Recommended actions
1. Commit the Biome format fix (M1). This blocks CI.
2. Make the post-billing failure path in `--timestamps` durable and classified, and add tests (M2).
3. Decide on M3: either reword the commit message and docs, or relax the legacy-model hard failures, at least for language codes.
4. Optional: L1-L3.

## Unresolved questions
- Does the API reject (400) or ignore `language_code` for `eleven_multilingual_v2`? If it rejects it, the "ignored ... still sends it" warning is inaccurate and an error would be the better choice.
- Should ElevenLabs output formats added later be allowed through with a warning, the same way unknown models are?
