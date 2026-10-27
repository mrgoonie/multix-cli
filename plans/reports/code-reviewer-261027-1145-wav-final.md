# Code review (final): PR #382 / issue #384, WAV placeholders and truncated-WAV coverage

Scope: `git diff origin/dev...HEAD` (c1afc5b, f7f509c). Files: src/commands/media/media-wav.ts, media-verify.ts, tests/unit/commands/media/media-wav.test.ts, media-quality-ffmpeg.test.ts, README.md, docs-site EN/VI media-and-documents.md, plans/reports/code-reviewer-261027-1130-*.md.

## Verification run
- `npx vitest run tests/unit/commands/media`: 6 files, 123 tests passed (ffmpeg suite ran).
- `npx tsc --noEmit`: clean. `biome check src/commands/media tests/unit/commands/media`: clean.
- `npm run build`, then `node dist/cli.js media verify <f> --profile audio --json` on files made with ffmpeg 6.1.1 and patched with a byte editor (scratchpad, not committed).

## Verdict
No blocker. The verdict logic (`truncated`) is unchanged apart from the exact placeholder set. GStreamer pipes pass, 2-4 GiB RIFF cuts fail, and the double-scaled coverage from the 1130 review is gone. There is one remaining false fail in the issue's own class (arecord pipes). There is also one wrong declared duration for WAVE_FORMAT_EXTENSIBLE with a compressed subformat; it affects metrics only.

## Medium

### M1. A complete arecord pipe capture still fails as truncated (false positive)
media-wav.ts:30. alsa-utils `arecord -t wav` writing to stdout caps the count at `max_filesize = 2147483648` (aplay.c:187, :3295-3296) and `begin_wave` writes data = 0x80000000 and RIFF = 0x80000024 (aplay.c:2756-2783). `end_wave` patches the header only if `lseek` works, so on a pipe (`arecord -f cd -t wav | tee x.wav`, ssh, or a STT pipeline) the header stays as written. aplay.c:2722 also has a 0x7FFFFF00 variant.
- Failing input: 4 s 44.1 kHz stereo PCM from ffmpeg, with data size set to 0x80000000 and RIFF size to 0x80000024. Result: `status: fail`, decode reason "WAV data chunk declares 2147483648 bytes but the file holds 705600 (truncated)", `coverage.media_duration_s: 12173.94`, `ratio: 0.00032`. The file decodes fully (3.9 s).
- The exact-set design (from the 1130 review's M1 option b) caused this. The issue asked for ">= 0x7FFF0000", which covered arecord, and so did c1afc5b. It is not a regression against `origin/dev` (dev's set {0, 0xFFFFFFFF, 0x7FFFF000} fails it too), but #384's stated goal is "do not fail valid streamed WAVs", and this writer is common.
- The exact set was a deliberate trade-off, so I am not deciding it here. Options:
  a) add 0x80000000 (and 0x7FFFFF00) to `PLACEHOLDER_SIZES`, with a unit test and a README/docs mention of arecord. A real cut RIFF WAV that declares exactly 2 GiB is about as unlikely as one declaring exactly 0x7FFF0000. Recommended.
  b) go back to the issue's threshold and lose 2-4 GiB RIFF detection.
  c) leave it as is and say in the docs that arecord pipes fail.

## Low

### L1. WAVE_FORMAT_EXTENSIBLE is assumed constant-rate whatever its subformat
media-wav.ts:31-32, :107-112. 0xFFFE is in `CONSTANT_RATE_FORMATS`, but the subformat GUID (fmt body offset 24, needs cbSize >= 22) is never read. ffmpeg writes EXTENSIBLE for every codec when sample_rate > 48000 or the layout is not mono/stereo (ADPCM IMA, AC3 5.1, EAC3 always). It writes a nominal `nAvgBytesPerSec` that can be far off.
- Failing input: `ffmpeg -f lavfi -i sine=d=4:r=96000 -c:a adpcm_ima_wav ima96.wav` (fmt tag 0xFFFE, subformat 0x0011, byteRate 16000). Rename its `fact` chunk to `JUNK` (a fact-less writer) and cut the file in half. `wav_data.declared_duration_s` is 12.096 instead of 4, `coverage.media_duration_s` is 12.096 and `ratio` is 0.165. The decode check reports `declared_duration_s: 12.096` and drops `declared_duration_estimated`, so the receipt states a wrong length as exact. EAC3 without fact gives 4.005333 (CBR, close but not exact).
- The verdict is unaffected (decode fails either way), and ffmpeg's own output always has `fact` for non-PCM, so this only bites with fact-less third-party writers. The code comment ("constant byte rate") is still wrong.
- Fix: for 0xFFFE with chunkSize >= 40, read `u16(body, 24)` from a 26-byte read and treat the format as constant-rate only when the subformat is 1 or 3. Add a unit test with an EXTENSIBLE PCM header and one with an EXTENSIBLE ADPCM header and no fact chunk.

### L2. A cut WAV without a header duration is still covered by ffprobe's bytes-left estimate
media-verify.ts:712-713. When `declared_duration_s` is null (non-PCM without `fact`, or A-law/mu-law tags 6/7 without `fact`, which are constant-rate but not listed), coverage falls back to `format.duration_s`.
- Failing input: `ffmpeg -f lavfi -i sine=d=4 -c:a adpcm_ms x.wav`, `fact` renamed, cut in half. Result: `coverage.media_duration_s: 2.78`, `ratio: 0.72` for a file that is 50% present. The decode check also shows `declared_duration_s: null, declared_duration_estimated: true` next to `declared_data_bytes: 89088`.
- The PR title ("cover a cut WAV by its declared length") and SKILL.md:549 ("`declared_duration_estimated: true` ... means no length was declared") are therefore not true for this case. Either scale by declared/present bytes only in this fallback (fact-less means ffprobe sized it from bytes), or document the gap.

### L3. A stale `fact` count wins over the PCM data size
media-wav.ts:107-109. For PCM, `fact` is optional and editors sometimes leave it stale, yet it is preferred over `declared / byteRate`.
- Failing input: 4 s PCM with an added `fact` of 352800 samples (8 s), cut in half. Result: `declared_duration_s: 8`, `ratio: 0.2375`. The data chunk says 4 s.
- ffmpeg's wavdec makes the same choice for a cut file (it uses `fact` when `data_end > file size`), so this is consistent with ffprobe. Informational. Preferring bytes/byteRate for tags 1/3 (and EXTENSIBLE PCM/float) would be more robust.

### L4. Docs and PR text accuracy
- `coverage.media_duration_s` now comes from the header for a truncated WAV, and `wav_data` gains `declared_duration_s`. Neither README, docs-site EN/VI nor SKILL.md mentions this. Both are public JSON (receipt, `media inspect`, rule input). The change is additive, but one sentence next to the truncation paragraph would cover it.
- The PR body says "the old value came out double-scaled (8 s instead of 4 s)". On `origin/dev` the adpcm/float coverage was 4 s (ffprobe uses `fact`) and the PCM case was 2 s; the 8 s value only existed in this PR's own first commit. The motivation should say that dev under-reported the PCM case (2 s), as the issue does.
- The PR body says the 1130 findings are "all fixed", but that report has no Resolution section, unlike the 1107 report. Add one.
- The docs placeholder list (README:900, EN:133-135, VI:130-132) matches the code and EN/VI agree. If M1 option a is taken, add arecord there.

### L5. Test gaps
- No test touches fmt tag 0xFFFE, so the extensible path is untested.
- No RIFX test reads `fmt`/`fact` (BE `u16`/`u32`).
- No test covers a `fact` placeholder value (0 or 0xFFFFFFFF) falling back to the byte rate.
- No test covers RF64 with a compressed format (`fact` = 0xFFFFFFFF, real count in ds64) giving `declared_duration_s: null`. I checked it by hand: verify then uses ffprobe's 4 s, which is correct.
- The existing tests are behavioural (they assert values, not just execution), and the ffmpeg-suite adpcm/float cases would fail on c1afc5b.

## Earlier reports: closure check
code-reviewer-261027-1130-wav-placeholder-coverage.md:
- H1 (double-scaled coverage for fact WAVs): closed. The duration now comes from `fact`/`fmt`, with no scaling. adpcm_ms and pcm_f32le cut tests were added, and I reproduced 4 s / ratio about 0.47.
- M1 (2-4 GiB RIFF lost): closed with option b (exact set); tests at media-wav.test.ts "keeps a RIFF data size between 2 and 4 GiB". The side effect is M1 above.
- M2 (docs): closed. The docs list the exact values. SKILL.md needs no blind-spot warning any more.
- L1 (decode declared null vs coverage 4): closed when a header duration exists. It remains in the L2 case above.
- L2 (present_bytes capped): accepted as designed.
- L3 (RF64 32-bit sizes >= 0x7FFF0000): closed by the exact set.

code-reviewer-261027-1107-wav-truncation.md (the 1115 report named in the brief does not exist in the tree or in history; 1107 is the earlier one): its Resolution section matches the code (0x7FFFF000, RIFF cross-check, ds64 size check, `looksLikeWave` gate, `.catch(() => null)` at media-inspect.ts:105). Items 5 and 9 (BW64, missing pad) were left open on purpose, and nothing in this PR changes them.

## Checked, no issue
- GStreamer header (data 0x7FFF0000, RIFF data+36) gives null, and the unit test covers it. espeak-style 0x7FFFF000/0x7FFFF024 gives null.
- RF64: the `known()` on `ds64DataSize` was removed from the data branch, but it is still applied when ds64 is parsed (line 88), so the behaviour is the same. RF64 PCM cut gives `declared_duration_s: 4`, correct.
- `truncated` still uses the uncapped `present`. The cap only affects the reported value. Complete files with trailing LIST/id3 report `present == declared`.
- Rounding: `Math.round(s*1e6)/1e6` is fine. Coverage `ratio` is still clamped to <= 1, and `declared && ...` guards against 0.
- The decode `measured` spread does not emit `declared_duration_estimated` together with the header value. Status precedence is unchanged.
- The VERIFY_ENGINE bump to /3 is in the cache key. No worker import of media-wav.ts, so no bundle impact.
- Concurrency and error boundaries: there is one fd per call, closed in `finally`, and errors become null in inspect. No new I/O on files that are not WAV.

## Recommended actions
1. Decide M1 (recommended: add 0x80000000 and 0x7FFFFF00 with a test and a docs mention).
2. L1: gate 0xFFFE on its subformat GUID and add an extensible test.
3. L2/L4: one docs sentence on `coverage` for truncated WAVs and on `wav_data.declared_duration_s`. Correct the PR body's "double-scaled" motivation and add a Resolution section to the 1130 report.

Status: DONE_WITH_CONCERNS
Summary: The PR closes all findings from the 1107 and 1130 reviews, and the tests, typecheck and lint pass. A complete arecord pipe WAV (data 0x80000000) is still a false fail, and EXTENSIBLE with a compressed subformat and no fact gets a wrong "exact" declared duration (12.096 s for 4 s); that one affects metrics only.

## Resolution

- M1: fixed. arecord's own source (alsa-utils `aplay/aplay.c`: `max_filesize` 2147483648 for WAVE, and `cnt = 0x7fffff00` when `cnt == -2`) confirms both values, so 0x80000000 and 0x7FFFFF00 are now placeholders. The RF64 `ds64` 64-bit sizes no longer go through the 32-bit list; only 0 and out-of-range values count as unknown there.
- L1: fixed. WAVE_FORMAT_EXTENSIBLE uses the format code from its SubFormat GUID, so only PCM and float get a byte-rate duration. Tests cover both subformats.
- L2: kept. Without a declared duration, coverage falls back to ffprobe; the check still fails the file as truncated. The docs now say so.
- L3: kept, informational. It matches ffmpeg's reader.
- L4: docs now describe the coverage source and `wav_data.declared_duration_s`. The PR body has been corrected.
- L5: the extensible format (RIFF and RIFX) and the arecord placeholders are covered. RF64 compressed formats share the RIFF fmt/fact code path.
