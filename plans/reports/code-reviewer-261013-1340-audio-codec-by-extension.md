# Code review: audio codec chosen by output extension (#179)

Commit 27fe412 (HEAD vs HEAD~1), branch claude/inspiring-wright-m5y337. Reviewed 2026-10-13 UTC.

## Scope
- src/commands/media/optimize-audio.ts (+49/-18), tests/unit/commands/media/optimize-audio.test.ts (new, 50 LOC)
- README.md, skill/SKILL.md, docs-site en + vi media-and-documents.md
- Callers checked: src/commands/media/index.ts (optimize), src/commands/media/batch.ts (batch, keeps input filename), src/commands/media/detect-type.ts (AUDIO_EXTS)

## Verdict
No blocking defects. The issue's case (wav -> mp3) is fixed and every AUDIO_EXTS input survives batch. Several optional hardening items below. One is a real gap: cover-art streams leak into the output, and this commit makes that reachable for .ogg.

## Empirical evidence (ffmpeg 6.1.1, `npm run build`, `node dist/cli.js`)
| Output | Result (codec, rate, channels) |
|---|---|
| .mp3 | mp3, 16000, 1, 64 kb/s |
| .m4a / .aac | aac, 16000, 1 |
| .ogg / .opus | opus, mono; ffprobe reports 48000 (Opus always decodes at 48 kHz; the encoder accepted -ar 16000) |
| .wav / .aiff / .flac | pcm_s16le / pcm_s16be / flac, 16000, 1, no -b:a |
| .MP3 | handled (extension is lowercased) |
| .mp4 | ValidationError, ffmpeg not run |

`media batch` over a dir with .aac .aiff .flac .m4a .mp3 .ogg .wav gave 7/7 succeeded, each with the expected codec. libopus at 16000 Hz is valid (Opus supports 8/12/16/24/48 kHz). libmp3lame at 16 kHz (MPEG-2 Layer III) is valid.
Lint is clean, typecheck is clean, and media unit tests pass (33/33).

## Blocking
None.

## Optional / non-blocking

### 1. [Medium] Attached cover art is carried into the output, and .ogg gains a Theora video track
No `-vn` / `-map 0:a`, so ffmpeg's default stream selection keeps the input's attached_pic. Tested with an mp3 that has a PNG cover:
- -> .ogg: output has **theora video + opus**. The new libopus mapping makes this possible: a "compressed audio" file now carries a video stream, and some players or Gemini uploads may treat it as video.
- -> .m4a: fails with `ipod: Could not find tag for codec h264`. This was already broken before the commit, since the old code also used aac to .m4a.
- -> .mp3 / .flac: png stream kept (harmless). -> .wav: dropped.
Fix: add `"-vn"` (and optionally `"-map_metadata", "0"`) to `buildAudioArgs`. Verified that `-vn` makes both the .m4a and .ogg cases produce audio-only output. Add a test asserting `-vn` is present. Also matches the "optimize for Gemini" intent. This could fit this PR, since the ogg case is new. Otherwise open a follow-up issue.

### 2. [Low] Behavior change: audio -> .mp4 (and .mka) is now rejected
HEAD~1 produced a valid AAC-in-MP4 for `--input a.wav --output a.mp4` (verified with the old args). It now throws. The test intentionally asserts `a.mp4` is rejected, and docs say "any other audio output extension is rejected". So the change is documented, but the commit message only describes it as fixing failures, not removing a working path. Either map `.mp4` (and `.mka`) to aac, or say so explicitly in the PR body. This is a `fix:` commit, so a release ships with the narrowed accepted set.

### 3. [Low] libopus rejects a high `--bitrate`
`--bitrate 320k` with .ogg/.opus fails (`libopus: Error while opening encoder`, mono max is 256k). The CLI then surfaces only the ffmpeg version banner as the error message (pre-existing runFfmpeg error formatting). mp3 and aac clamp silently. Low impact at the 64k default. Consider clamping or documenting it.

### 4. [Low] Test gaps
- No test ties `AUDIO_EXTS` (detect-type.ts) to the codec map. Batch relies on every input extension being a valid output extension. If someone adds `.wma`/`.aif` to AUDIO_EXTS, batch breaks silently per file. Suggest `it.each([...AUDIO_EXTS])("batch-safe: %s", ext => expect(() => build("a"+ext)).not.toThrow())`.
- The test title "rejects %s before ffmpeg runs" only exercises the pure builder. Nothing proves `optimizeAudio` throws before `assertFfmpeg`/`getMediaInfo`. The ordering in the code is correct (args are built first), so this is a naming/claim issue only.
- Only one full-argv assertion (mp3). The lossless case checks absence of `-b:a` but not that `-ar 16000 -ac 1` survive.

### 5. [Low] Docs wording
- "written lossless" is imprecise: output is still resampled to 16 kHz mono 16-bit. The codec is lossless, not the transform. Suggest "use a lossless codec (`--bitrate` is ignored)". The same wording is in README, EN and VI.
- "16 kHz mono" for .ogg/.opus: the streams decode and report at 48 kHz. Acceptable, but could note it.
- In `optimize`, `index.ts` runs `mkdirSync(dirname(output))` before the extension is validated, so a rejected output still creates the directory. This is pre-existing ordering and cosmetic.

### 6. [Info] Encoder availability
libmp3lame and libopus are external libraries. Minimal ffmpeg builds (some static/alpine builds) lack them and fail with "Unknown encoder". `aac`, `flac` and `pcm_*` are native. Optional: mention it in the check/setup hints. No action required.

## Docs parity (EN/VI)
EN and VI paragraphs match in content (codec list, lossless, bitrate ignored, rejection) and both add the same example. README and SKILL.md agree with the code's codec map. SKILL.md adds `[--bitrate 64k]`, which matches the CLI default.

## Architecture/conventions
- `node:path` import is in the command layer, which is allowed (providers stay node-free). The worker does not import this module.
- `buildAudioArgs` is a pure, exported, testable builder. No abstraction creep, and the change is scoped to the issue.

## Recommended actions
1. (Optional, this PR preferred) Add `-vn` to `buildAudioArgs` and a test for it.
2. (Optional) Add an AUDIO_EXTS round-trip test.
3. (Optional) Decide on .mp4/.mka and state the change in the PR body.
4. (Optional) Reword "lossless" in README/EN/VI.

## Unresolved questions
- Is dropping `--output x.mp4` for audio inputs intended product behavior, or should .mp4/.mka stay supported?

Status: DONE_WITH_CONCERNS
Summary: Fix is correct and verified end to end for all 8 mapped extensions and all 7 AUDIO_EXTS batch inputs; no blockers. Optional concerns: cover art leaks into outputs (Theora track in .ogg, -vn fixes it), .mp4 audio output silently removed, missing AUDIO_EXTS round-trip test.
