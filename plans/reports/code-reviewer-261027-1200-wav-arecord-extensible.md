# Code review: a4afe73, arecord placeholders and WAVE_FORMAT_EXTENSIBLE subformat (PR #382 / issue #384)

Scope: `git show a4afe73` only. Files: src/commands/media/media-wav.ts, tests/unit/commands/media/media-wav.test.ts, README.md, docs-site EN/VI media-and-documents.md, plans/reports 1130 (Resolution) and 1145 (new).

## Verification
- `npx vitest run tests/unit/commands/media`: 6 files, 123 tests passed.
- `npm run typecheck`: clean. `biome check` on the two changed TS files: clean.
- bigint literal `0n`: needs target >= ES2020; tsconfig.json has `"target": "ES2022"`, `"lib": ["ES2022"]`, so it compiles (typecheck confirms). `BigInt(...)` and `readBigUInt64LE` were already in use.
- Probe script (scratchpad, not committed) calling `readWavDataLength` on hand-built headers:

| Input | declared_duration_s |
|---|---|
| RIFF, fmt 40, EXTENSIBLE, SubFormat PCM | 2 (correct) |
| RIFF, fmt 39 (odd, padded), EXTENSIBLE PCM | 2 (correct) |
| RIFF, fmt 18 or 25, tag 0xFFFE | null (conservative) |
| RIFX, fmt 40, EXTENSIBLE PCM, GUID Data1 byte-swapped to BE | null (wrong) |
| RIFX, fmt 40, EXTENSIBLE PCM, GUID bytes in canonical LE layout | null (wrong) |

## Verdict
No blocker. The verdict logic (`truncated`) is unchanged apart from the two new placeholders. The arecord fix is right, and so is the RF64 change. One small regression affects metrics only, in RIFX extensible files.

## Low

### L1. RIFX WAVE_FORMAT_EXTENSIBLE PCM/float lost its byte-rate duration (metrics-only regression)
media-wav.ts:101-102. `u16(body, 24)` reads the SubFormat with the file's byte order. In RIFX the first two bytes of the GUID are `00 00` if Data1 is written big-endian, and `01 00` (read as 0x0100) if the GUID is kept in its canonical byte layout. In neither case do you get 1 or 3, so `declared_duration_s` is null for any RIFX extensible PCM/float file. Before this commit 0xFFFE was in `CONSTANT_RATE_FORMATS`, so those files got `declared / byteRate`. ffmpeg's `parse_waveformatex` (libavformat/riffdec.c) always reads the GUID little-endian (`AV_RL32(subformat)`), even when `big_endian` is set.
- Impact: `wav_data.declared_duration_s` is null, and coverage falls back to ffprobe for a cut RIFX extensible PCM file. `truncated` and the decode verdict do not change. RIFX extensible is rare, and ffmpeg's wavenc does not write RIFX.
- Fix: read the SubFormat the way ffmpeg does, `body.readUInt16LE(24)`, whatever the magic. Add a RIFX extensible case to the `ext` test. The 1145 report's Resolution says "RIFX fmt/fact ... share the same code path as the tested cases"; that is not true for this read, so correct it.

### L2. SubFormat GUID base and cbSize are not checked
media-wav.ts:101-102. Only the first 16 bits of the GUID are read. ffmpeg uses the code only when GUID bytes 4-15 match the KSDATAFORMAT, ambisonic or "broken" base, and otherwise maps the whole GUID through `ff_codec_wav_guids`. A vendor GUID whose first two bytes are 01 00 or 03 00 would be taken for PCM/float, and the duration would come from a nominal byte rate. `cbSize` (offset 16) is not checked against 22 either, so a fmt with chunkSize >= 26 and cbSize 0 plus trailing junk gets read as a GUID. These are rare and metrics-only. Optional: also require `body.subarray(28, 40)` to equal the base `00 00 10 00 80 00 00 AA 00 38 9B 71` when chunkSize >= 40, and return null otherwise.

### L3. RF64 behaviour edges (accepted, informational)
- ds64 sizes now skip the placeholder list. ffmpeg's RF64 header writes zeros into ds64 when it cannot seek, and 0 still means unknown, so the main pipe case is kept. A writer that puts 0xFFFFFFFF or 0xFFFFFFFFFFFFFFFF in ds64 also works: the first is a real size by design, and the second is above MAX_SAFE_INTEGER, so null.
- In an RF64 `data` chunk whose 32-bit size is not 0xFFFFFFFF, `known(chunkSize)` still applies the 32-bit list. An RF64 file whose real data is exactly 0x80000000 bytes is therefore "unknown". This is the same trade-off as for RIFF, and harmless.
- Exactly-2-GiB RIFF cuts (data 0x80000000) are no longer detected. This is the documented trade-off taken for M1 option a.

## Checked, no issue
- `read(offset + 8, Math.min(chunkSize, 40))`: chunkSize >= 16 is guarded, so the length is 16..40. A short fmt (16/18) gives a 16/18-byte buffer, and `body.length >= 26` gates the GUID read, so 0xFFFE then gives null. An odd chunkSize reads only the chunk bytes and never the pad byte, and the walk still adds the pad at :129. If the fmt body runs past EOF, `read` returns null; the old 16-byte read would succeed only where the walk to `data` fails anyway, so `data` is never found and the result is null. That is not a regression.
- `u16`/`u32` for formatTag, sampleRate and byteRate keep the RIFX byte order (unchanged).
- ds64 is read with `readBigUInt64LE`. That is correct because RF64 is always little-endian, and ds64 is only parsed when `magic === "RF64"`.
- `size64` gives 0n -> null and > MAX_SAFE_INTEGER -> null. `riffSize` null means the riff-size cross-check is skipped, as before.
- Placeholders: 0x80000000 and 0x7FFFFF00 match alsa-utils aplay.c, as the 1145 report cites. arecord's RIFF value 0x80000024 is not a placeholder, but `declared === null` returns before it matters.
- Tests are behavioural. Each new case would fail on f7f509c: the arecord cases would give a non-null result, and ext-adpcm would give 2 because 0xFFFE was constant-rate.

## Docs
- README:900, docs-site EN:133-140 and VI:130-136 list the same six values and the same writers, and they match `PLACEHOLDER_SIZES`.
- The new coverage sentence (fact count, else data size / byte rate for PCM and float, also `wav_data.declared_duration_s`, else ffprobe) matches media-verify.ts:304-307 and :712. The VI text is a faithful equivalent of EN, with no missing clause.
- skill/SKILL.md:549 lists no placeholder values and does not mention `wav_data.declared_duration_s` or the coverage source. The values do not need to be there. The coverage-source sentence is optional for agents; it does not cause any drift.
- The commit adds a review report and a Resolution section under `plans/reports/` inside a `fix(media)` commit. That is allowed by AGENTS.md (plans/ is the reports home). The 1145 Resolution's RIFX claim is inaccurate (see L1).

## Recommended actions
1. L1: read the SubFormat code with `readUInt16LE(24)` regardless of RIFX, add a RIFX extensible test, and correct the 1145 Resolution line.
2. L2 (optional): check the GUID base before trusting the first 16 bits.

Status: DONE_WITH_CONCERNS
Summary: a4afe73 is correct for RIFF/RF64; tests (123), typecheck and lint pass, bigint literals compile under ES2022, and docs are accurate with EN/VI parity. One metrics-only regression: RIFX WAVE_FORMAT_EXTENSIBLE PCM now gets a null declared duration because the SubFormat GUID is read big-endian (ffmpeg reads it little-endian).
Concerns/Blockers: none blocking.

## Resolution

- L1: fixed. The SubFormat GUID is always read little-endian, as ffmpeg's `parse_waveformatex` does. A RIFX extensible PCM test covers this.
- L2: fixed. The format code is trusted only when bytes 2–15 of the GUID match the KSDATAFORMAT base. A vendor-GUID test covers this.
- L3: accepted trade-off, no change.
- The 1145 report's Resolution has been corrected for RIFX.
