# Code review: WAV truncation detection (issue #374)

Status: DONE_WITH_CONCERNS
Summary: The fix detects a sample-aligned cut WAV/RF64/RIFX and fails `decode`. Verdicts for files that are not WAV are unchanged, the engine/rule_version bump invalidates cached receipts, and nothing reaches the worker bundle. There are no blockers. One medium false-fail risk: placeholder data sizes other than 0 and 0xFFFFFFFF, plus writers that are a few bytes off. There are also small doc and test gaps.

## Scope
- src/commands/media/media-wav.ts (new, 75 LOC), media-inspect.ts (+13), media-verify.ts (+30/-23)
- tests/unit/commands/media/media-wav.test.ts (new), media-quality-ffmpeg.test.ts (+55)
- README.md, skill/SKILL.md, docs-site EN + VI media-and-documents.md

## Verification run
- `npx vitest run tests/unit/commands/media`: 6 files, 118 tests passed (ffmpeg present, so the ffmpeg suite ran)
- `npm run typecheck`: clean. `biome check` on the touched files: clean.
- `npm ci --prefix worker && npm run check:mcp`: worker typecheck, tests and dry-run deploy passed; check-bundle reports 1 clean file (no node:* import)
- I ran the walker by hand (node type-stripping, in the scratchpad) on ffmpeg output:
  - piped RIFF (0xFFFFFFFF): null. Piped RF64 (ds64 size 0): null. RF64 file: correct. 24-bit 3-channel file: correct. Cut file: truncated.
  - data size 0x7ffff000 on a complete file: `truncated: true`, declared 2147479552. This is a false fail.
  - data size +8 on a complete file: `truncated: true`. This is a false fail.
- ffprobe prints "Estimating duration from bitrate" for a WAV whose declared data size exceeds the file. That is why the old check never fired: declared was null.

## Critical
None.

## High
None.

## Medium

1. False fail on legacy or other placeholder data sizes. media-wav.ts:20-21 and :60.
   - Only 0 and 0xFFFFFFFF count as "unknown length". SoX's own reader also treats `MS_UNSPEC = 0x7ffff000` as "Magic length sometimes used to indicate unknown or too large size" (sox src/wav.c, startread). Older SoX and some streaming servers write it.
   - Scenario: a streamed WAV whose header says 0x7ffff000 decodes cleanly. `media verify --profile audio` returns `fail` with "declares 2147479552 bytes but the file holds 352800 (truncated)". `media inspect` exits 1. I reproduced this.
   - Fix: add 0x7ffff000 to the placeholder set.
   - Optional: treat `declared > present` as truncated only when the RIFF size (or ds64 riffSize) also exceeds the file size. A placeholder writer leaves both fields as placeholders. A truncated file keeps a consistent RIFF size that also exceeds the file.

2. No tolerance for header size bugs. media-wav.ts:65.
   - `present < declared` fails a file that is 1 byte short. Some writers miscount the data size (I reproduced +8) or leave an odd data size without its pad.
   - Scenario: a complete file is reported as truncated by 8 bytes, which is less than one sample frame at 16-bit stereo.
   - Fix: decide whether a shortfall smaller than one block_align (from the `fmt ` chunk) should fail. Otherwise state the strict rule in the docs.
   - A cross-check against the RIFF size (item 1) catches the off-by-N writer, because its RIFF size usually matches the file.

## Low

3. Agent guidance about WAV is incomplete in skill/SKILL.md (+1 line).
   - SKILL.md says `declared_duration_estimated: true` means "no length was declared ... do not read a pass there as proof". README and docs-site also say a WAV piped out of ffmpeg declares no length; SKILL.md omits that.
   - A truncated WAV's receipt carries both `declared_duration_estimated: true` (ffprobe estimated it) and `declared_data_bytes`, so the two signals overlap.
   - Fix: add one sentence. For WAV, the header check ran exactly when `measured.declared_data_bytes` is present. Its absence on a WAV (piped) means a cut cannot be detected.

4. `media inspect` now exits 1 on a truncated WAV even without `--decode` (media-inspect.ts:102-106 push to `errors`, so `ok` becomes false). This is intended, but no doc says that inspect fails a truncated WAV. The worker job container runs `media inspect`; the change is additive and only affects the exit code. Add one clause to the docs-site inspect paragraph (EN + VI).

5. Reason precedence hides decode errors. media-verify.ts:315.
   - When `wav.truncated`, `reason` is only the truncation text. Decode errors and the timed-out/cancelled reasons are dropped, though `measured.error_count` and `completed` still carry them.
   - The status precedence (truncation → fail even after a timeout) is correct, because the header fact does not depend on the decode.
   - Optional: append the first decode error.

6. `coverage` is misleading for a truncated WAV. media-verify.ts:743-748.
   - `media_duration_s` comes from the bitrate-estimated `format.duration_s`, which ffprobe derives from the bytes present (3 s for a 4 s file cut by 1 s). So `coverage.ratio` is 1.0 while `decode` fails.
   - This predates the change for estimated durations, but the change now has the declared length (declared_bytes / byte rate) and does not use it. Informational.

7. Raw fs errors escape inspect. media-inspect.ts:102, media-wav.ts:28.
   - The file is resolved and hashed first, so ENOENT/EACCES needs a delete or chmod race. If it happens, `inspectSource` rejects with a plain Node error, not a ProviderError, so it is not added to `errors` like probe failures are.
   - There is no fd leak: `open` is outside `try` and nothing allocates between open and try; `finally` closes.
   - Optional: catch the error and return null, or report it as an error string.

8. The file changes between hash and read. media-wav.ts:30 uses `fh.stat().size`, not `src.bytes`. A file that grows after hashing can pass the header check. verify re-hashes at the end and marks the receipt `incomplete` (media-verify.ts:681-688), so the receipt is safe. inspect has no re-hash; that predates this change and is equally true of ffprobe and decode. No action needed.

9. Minor walker gaps (false negatives only, no wrong fail):
   - `BW64` (ITU-R BS.2088) magic is not recognised: media-wav.ts:40.
   - The ds64 body is read as 16 bytes without checking `chunkSize >= 16`: media-wav.ts:53.
   - A writer that leaves out the pad byte after an odd chunk misaligns the walk, which then usually returns null.
   - Huge or malformed chunk sizes are safe: `read()` returns null past EOF, buffers are fixed at 8 or 16 bytes, and MAX_CHUNKS=64 bounds the loop.
   - Chunks after `data` are counted in `present_bytes` (media-wav.ts:61). They cannot cause a false fail, but `present_data_bytes` can exceed the real sample bytes. The docs call it "sample bytes the file holds".

10. Extra open for every file. media-inspect.ts:102 opens every probed file (mp4, mkv, ...) to read 12 bytes, though `src.head` already holds the magic. Gating on `src.head` (RIFF/RIFX/RF64 + WAVE) skips the open. Negligible cost.

11. A fourth RIFF walker. RIFF walkers already exist in src/providers/fish/audio-check.ts:36, gemini/generators/speech.ts:203 and fal/speech-output.ts. They are runtime-neutral and work on buffers; this one needs random file access, so a separate module is defensible. Note it for DRY if a shared buffer walker appears later.

## Things checked with no issue found
- Verdict regression: for files that are not WAV, `wav_data` is null and the status/reason ternaries reduce to the previous code. The duration-based `truncated` is untouched. The `analysis && !analysis.completed` downgrade only touches `pass` checks, so a truncation fail survives. `analysis` is null only when `kind` is null, and judge returns before the decode block in that case.
- Cache: VERIFY_ENGINE `/1` to `/2` is part of the cache key (media-verify.ts:607-616), so stale `pass` receipts for truncated WAVs are not reused. `rule_version` "2" is applied in both decode branches.
  - Out of scope, worth an issue: `media check-receipt` (media-receipt.ts) does not look at `engine`, so an old `/1` pass receipt for a truncated WAV still vouches.
- Worker/MCP: nothing under worker/src imports src/commands/media or InspectReport. The worker only lists `media inspect`/`media verify` in cli-command-policy.ts and cli-catalog.json and runs them in the job container. The command flags did not change, so the catalog does not need regenerating. check-bundle is clean; `node:fs` in media-wav.ts does not leak.
- `wav_data` in InspectReport and the new `measured` keys are additive. The rule input (`inspect: report`) gains a field and the schema version is unchanged, which is acceptable for an additive field.

## Test quality
- Unit tests cover: a complete file, a cut file, pad bytes, trailing chunks, RIFX, RF64 via ds64, 0/0xFFFFFFFF, other forms (AVI), a short header and an empty file. The ffmpeg suite covers a real cut WAV, a piped WAV, the inspect `ok=false` result and the raw ac3 `estimated` marker. The assertions check behaviour; none of these are phantom tests.
- Missing:
  - placeholder 0x7ffff000 (pending the decision in item 1)
  - a chunk size that points past EOF before `data`
  - RF64 data 0xFFFFFFFF with no ds64
  - judge precedence when the decode timed out or was cancelled and the WAV is truncated (expect `fail`, not `unknown`)
  - `present_data_bytes` when a chunk follows `data`

## Docs
- README, docs-site EN/VI and SKILL.md agree with the code on the `decode` behaviour and on raw ac3/AAC/Xing-less mp3 being undetectable. The VI text matches the EN text.
- Gaps: items 3 and 4. Also, `wav_data` is null for more than "other formats and a WAV that declares no length": BW64, a data chunk not found within 64 chunks, and an unreadable header also give null.

## Recommended actions
1. Add 0x7ffff000 to the placeholder set. Consider requiring the RIFF size to also exceed the file before calling it truncated (items 1-2), and add tests for both.
2. Add the `declared_data_bytes` sentence to SKILL.md (item 3) and the inspect exit-code note to the docs (item 4).
3. Optional: catch the fs error in readWavDataLength, gate the call on `src.head`, and add the precedence test.

## Unresolved questions
- Product intent: should a shortfall smaller than one sample frame, or a RIFF-consistent off-by-N header, fail `decode`?
- Should `check-receipt` reject receipts from an older VERIFY_ENGINE? That would be a separate issue.

Status: DONE_WITH_CONCERNS
Summary: The fix works and causes no regression. The medium items are false-fail risks on placeholder or slightly-off WAV headers. The low items are a doc clarification for agents and minor robustness.

## Resolution (implementer)

- Items 1 and 2: 0x7FFFF000 is treated as a placeholder with 0 and 0xFFFFFFFF, and a WAV is called truncated only when the RIFF size (or the ds64 RIFF size) also exceeds the file. Regression tests cover both cases.
- Items 3 and 4: SKILL.md, README and the docs site now say when `declared_data_bytes` is present and that `media inspect` lists the truncation in `errors` and exits non-zero.
- Item 7: a read error after hashing yields `wav_data: null` instead of a raw Node error. Item 10: the file is opened only when its first bytes name a WAVE. Item 9: the ds64 chunk size is checked.
- Items 5, 6 and the remaining item 9 gaps only change wording or miss truncation; they are left as they are. The `check-receipt` engine question is tracked as its own issue.
