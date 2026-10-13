# Code review: audio optimize drops cover art, maps .mp4/.mka to AAC (#184)

- Commit: 6dcee44 vs 2a0478b, branch `claude/inspiring-wright-m5y337`
- Files: `src/commands/media/optimize-audio.ts`, `tests/unit/commands/media/optimize-audio.test.ts`,
  `README.md`, `skill/SKILL.md`, `docs-site/src/content/docs/{,vi/}commands/media-and-documents.md`
- LOC: +36 / -6
- Verdict: **approve**. Nothing blocks the merge.

## Verification

| Check | Result |
|---|---|
| `npm run build` | pass |
| `npx vitest run tests/unit/commands/media` | 43/43 pass |
| `npm run lint` / `npm run typecheck` | clean |
| Pre-fix reproduction (ffmpeg args without `-vn`, mp3 with an attached_pic) | `.ogg` output had `theora + opus`; `.m4a` output failed with "Nothing was written" (ipod muxer). Confirms the bug. |
| Post-fix matrix: `node dist/cli.js media optimize`, inputs {mp3+jpeg cover, m4a+jpeg cover, flac+png cover, plain wav} x outputs {mp3, m4a, aac, mp4, mka, opus, ogg, wav, aiff, flac} | 40/40 OK. Every output holds one audio stream, mono, the expected codec, 16 kHz (Opus reports 48000 because that is the Opus decode rate; this was the same before the change). |
| `media batch` on a directory of cover-art mp3/m4a/flac files | 3/3 OK, audio only |
| m4a with a mov_text subtitle track -> mka/mp4/ogg/mp3 | audio only, no failure |

Scratch fixtures under the session scratchpad were deleted afterwards.

## ffmpeg flags and ordering

`-i in -y -vn -c:a X [-b:a B] -ar R -ac 1 out`: `-vn` comes after `-i` and before the output path, so it
applies as an output option to the only output. That is correct. `-y` is global, so where it sits does not
matter. `-vn` also stops the auto-selected attached_pic stream (mjpeg/png) from being mapped, which was the
root cause. No `-map` is used, so the default "best audio" selection is unchanged.

## Blocking

None.

## Optional (non-blocking)

1. **Other containers that worked before #180 are still rejected.** Before #180 the code always passed
   `-c:a aac` and accepted any output extension. I checked AAC with the legacy args: `.mkv`, `.mov` and
   `.3gp` all mux successfully. After this commit `--input a.wav --output a.mkv` (or `.mov`) still fails
   with `Unsupported audio output extension`. The issue only names `.mp4`/`.mka`, so the commit meets the
   stated scope. The same reasoning ("worked before, rejected after") applies to these extensions too. You
   can either add `.mkv`/`.mov` (and maybe `.m4b`) -> `aac` to `AUDIO_CODECS`, or open a follow-up issue
   that says the narrowing is deliberate. Batch is not affected: `.mkv`/`.mov` are `VIDEO_EXTS`, so batch
   sends them to the video path.
2. **The new batch-extension guard test does not fail on the parent commit.** All seven `AUDIO_EXTS`
   (`.mp3 .wav .m4a .flac .aac .ogg .aiff`) were already mapped by #180. The test is useful as an
   invariant guard against future drift in `AUDIO_EXTS`, but it does not cover the `.mp4`/`.mka` change.
   That change is covered by the new `it.each` rows. No action needed. The issue asked for this test,
   and it ties `detect-type.ts` to the codec map correctly.
3. **Some overlap between the two lossless tests.** "keeps 16 kHz mono for lossless codecs" (full `toEqual`
   on `.wav`) overlaps with "omits -b:a for lossless and PCM codecs". It is harmless. The full-array
   assertion is what pins `-vn` on the lossless path, so keep it.
4. **Docs line length.** The EN docs-site line 53 and VI line 51 are now longer than the file's ~80-column
   wrap. This is cosmetic only, and `verify:docs` is unaffected.

## Docs accuracy and EN/VI parity

- README, SKILL.md, EN and VI docs-site all list the same mapping (`.m4a/.aac/.mp4/.mka` -> AAC). This
  matches `AUDIO_CODECS` exactly.
- "Embedded cover art is dropped" (EN) / "Ảnh bìa nhúng trong file bị bỏ, nên output chỉ chứa audio" (VI)
  are equivalent and accurate (verified empirically). README and SKILL.md need no Vietnamese counterpart.
- No other docs mention the codec list (grep for `m4a/aac`, `cover art` outside `plans/` and CHANGELOG).
- Docs correctly scope the mapping to audio input. A `video.mp4` input still goes through `optimizeVideo`,
  so the `.mp4` example right below in the docs stays accurate.

## Regression / scope

- No change to exported signatures. `buildAudioArgs` only gains an arg.
- The provider clients and `worker/` are not touched, so `check:mcp` is not needed.
- The commit type `fix(media)` will publish a patch, which is appropriate. The commit message has no
  plan/finding codes.
- No scope drift. Only the six expected files changed.

## Plan / issue follow-up

All four "Expected" items in #184 are done: `-vn`, the `.mp4`/`.mka` mapping, tests (including the
AUDIO_EXTS invariant), and docs in README/skill/EN/VI. I suggest a follow-up issue (or a small extension of
this PR) for `.mkv`/`.mov` (see optional finding 1).

Status: DONE
Summary: Fix is correct and empirically verified (cover art no longer leaks into .ogg or breaks .m4a; .mp4/.mka produce AAC); tests, lint, typecheck pass; docs are accurate with EN/VI parity. No blocking findings.
Concerns/Blockers: Optional only. `.mkv`/`.mov` audio outputs also worked before #180 and are still rejected.
