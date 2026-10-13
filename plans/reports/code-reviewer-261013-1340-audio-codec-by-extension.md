# Code review: audio codec follows the output extension (issue #179)

## Scope
- Files: src/commands/media/optimize-audio.ts (+53/-17), tests/unit/commands/media/optimize-audio.test.ts (new, 61 lines),
  README.md, skill/SKILL.md, docs-site/src/content/docs/{,vi/}commands/media-and-documents.md (docs edits appeared in the working tree during the review and are included)
- Callers checked: src/commands/media/index.ts (optimize), src/commands/media/batch.ts (batch), detect-type.ts (AUDIO_EXTS)
- Verification run by reviewer: `vitest run tests/unit/commands/media` 32/32 pass; `biome check` on both files clean; ffmpeg 6.1.1 probes listed below

## Overall assessment
Correct, minimal fix that does what the issue asks. The codec map covers every extension in AUDIO_EXTS, so `media batch` (which keeps the input file name) no longer feeds an AAC stream into an mp3/flac/aiff/ogg container. Validation runs before `assertFfmpeg()` / `getMediaInfo()`, as the issue requires. No blocking findings.

## Critical issues
None.

## High priority
None.

## Medium priority
1. **libopus rejects bitrates above 256k (mono).** `--bitrate 320k --output a.opus` (or `.ogg`) fails in ffmpeg:
   `The bit rate 320000 bps is unsupported. Please choose a value between 500 and 256000.` The failure surfaces as a
   `ProviderError("ffmpeg failed: ...")` with the explanation in the stderr. This is not a regression (Opus output failed for every
   bitrate before the fix), and the default of 64k works. Optional: clamp the value or reject it with a ValidationError in `buildAudioArgs` for libopus. Fine as a follow-up issue.
2. **The behavior of `.wav` output in `media batch` changes.** Before the fix, `.wav` was the one non-AAC container that worked: ffmpeg wrote
   AAC inside WAV (exit 0, about 64 kbps, a non-standard file). It now writes 16-bit PCM at 16 kHz mono, which is 256 kbps, about 4x larger than before. This is the
   behavior issue #179 asks for and it is a standard, playable file, so it is the right call. Mention it in the PR body or commit text so the
   size change for batch users is not a surprise.

## Low priority
1. **libmp3lame silently caps the bitrate at 16 kHz.** At 16 kHz (MPEG-2 Layer III) the maximum is 160k, so `--bitrate 320k` produced a 160 kbps
   file with no error. AAC behaves the same way (64k and 320k both gave about 52 kbps at 16 kHz mono, unchanged from before). This is acceptable. The
   docs say `--bitrate` applies to lossy formats but do not say it is an upper target. A doc tweak is optional.
2. **`sampleRate` and libopus.** libopus accepts only 8/12/16/24/48 kHz. A sample rate of 22050 fails with "Specified sample rate 22050 is not supported".
   The CLI does not expose `sampleRate`, so only programmatic callers of `OptimizeAudioOptions.sampleRate` can hit this. No action needed now,
   but if a `--sample-rate` flag is added later, validate it per codec in `buildAudioArgs`.
3. **Output directory created before validation.** `index.ts` runs `fs.mkdirSync(dirname(output))` before `optimizeAudio()`
   validates the extension, so a rejected `--output new/dir/a.wma` leaves an empty `new/dir`. This existed before the change and is harmless.
4. **Encoder availability.** libmp3lame and libopus are external libraries. A minimal ffmpeg build without them fails with an ffmpeg
   "Unknown encoder" error, which `runFfmpeg` surfaces as a ProviderError. Standard distro and Homebrew builds include both. Informational only.

## Edge cases checked (scout)
| Case | Result |
|---|---|
| `.aac` (ADTS muxer) with `-b:a 64k -ar 16000` | OK, aac 16 kHz, honours -b:a |
| `.m4a` with -b:a | OK |
| libmp3lame 16 kHz at 8k / 64k / 320k | OK / OK / silently capped to 160k |
| libopus 16 kHz at 2k / 64k | OK (container reports 48000, which is normal for Opus) |
| libopus at 320k / 512k | ffmpeg error (Medium 1) |
| `-b:a` with pcm_s16le | ffmpeg ignores it silently, so omitting it for lossless codecs is cosmetic but correct |
| Upper-case extension (`A.MP3`) | handled by `toLowerCase()`, tested |
| No extension | ValidationError "(none)", tested |
| Map vs detect-type AUDIO_EXTS | identical set of 7 extensions plus `.opus`; batch never hits the rejection path for audio |
| Old behavior per container (aac) | .wav exit 0; .flac/.aiff/.ogg/.opus/.mp3 failed. The fix resolves every failing case |

## Conventions (AGENTS.md)
- `node:path` import is in the command layer (`src/commands/media`), not a provider client, so this is allowed. `worker/` does not import this file, so `check:mcp` is not needed.
- Kebab-case test file placed next to the existing `detect-type.test.ts`. No paid APIs and no ffmpeg calls in the unit tests.
- Docs are updated in README, skill/SKILL.md and docs-site in both English and Vietnamese. The Vietnamese example order differs slightly from English (audio example placed second instead of third), which is cosmetic.
- The `buildAudioArgs` export is new public surface within the module only and does not change the CLI contract.
- Suggested commit: `fix(media): pick audio codec from output extension` (publishes a patch, as appropriate). The `in review` label and issue claim are the author's responsibility and were not verified here.

## Test quality
The tests assert real behavior: the codec chosen per extension, the full argument vector for the lossy path, `-b:a` absent for every lossless
codec, and the ValidationError type and message. These are not phantom tests. One gap: no test asserts that `optimizeAudio` rejects
before running `assertFfmpeg`. That ordering is visible in the code and was e2e-verified (`.wma` → exit 1), so this is not blocking.

## Recommended actions
1. (Optional) Validate or clamp the libopus bitrate to 256k or less in `buildAudioArgs`, or open a follow-up issue.
2. Note in the PR body that the size of `.wav` batch output grows (AAC-in-WAV becomes PCM).
3. Proceed to PR.

## Metrics
- Typecheck/lint/build: pass (author-reported; biome re-run by reviewer on touched files: clean)
- Unit tests: 32/32 in tests/unit/commands/media
- Linting issues: 0

## Unresolved questions
- Should `.ogg` map to libopus (current) or libvorbis (the more conventional Ogg codec)? libopus is consistent with the issue text and is smaller at 64k, so libopus is fine unless a product preference says otherwise.

Status: DONE_WITH_CONCERNS
Blocking findings: none
