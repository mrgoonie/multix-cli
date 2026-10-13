# Code review: ffmpeg error tail (#183), commit 475893e

## Scope
- Files: src/commands/media/ffmpeg-runner.ts (+16/-3), tests/unit/commands/media/ffmpeg-runner.test.ts (new, 18 lines)
- Callers of runFfmpeg: optimize-video.ts:72, optimize-audio.ts:98, split-video.ts:62. There is no two-pass encode anywhere. optimize-video makes a single call, even with --target-size.
- Checks run: `npm run build` OK, `npm run lint` clean, `npm run typecheck` clean, `vitest tests/unit/commands/media` 47/47 pass.
- Ran the built CLI with ffmpeg 6.1.1 against generated media in the scratchpad. The scratchpad files are deleted.

## Verdict
The fix is correct. No blocking findings.

## Evidence
- Old behavior confirmed: on this build, ffmpeg's banner takes the first 11 lines of stderr and is well over 1000 characters (the `configuration:` line alone is), so `slice(0,1000)` kept only the banner.
- `media optimize --resolution abc`: the message now ends with `Invalid size 'abc'` ... `Error opening output files: Invalid argument`, and the command exits with code 1.
- `media optimize` to an .mp3 with `--bitrate zzz`: the message ends with `Conversion failed!`, and the cause lines are included.
- Successful runs of video optimize (with and without -v), audio to .m4a, and split (`-f segment`, chunks created) all work with `-hide_banner` placed first.
- Argument placement: `-hide_banner` is a global option, so putting it before `-i` is the canonical position. The callers' arrays all start with `-i <input>`. Nothing that is position-sensitive (like `-ss` before `-i` or `-f` before an output) is affected. The option has existed since ffmpeg 2.2, so it is safe on any supported ffmpeg.

## Blocking
None.

## Optional
1. **The debug command line leaves out `-hide_banner`.** runFfmpeg.ts:60 logs `ffmpeg ${args.join(" ")}`, but the process actually runs with `-hide_banner` prepended. Since the extra flag only hides the banner, a user who copies the logged command gets the same result. Still, logging the exact argv is more honest. Suggested fix: build `const argv = ["-hide_banner", ...args]` once, then use it for both the log line and the execa call.
2. **The tail is cut in the middle of a line.** The live output started with `…rsion   : 512`. The tail could start at the first `\n` after the cut point. This is cosmetic only.
3. **The tail can still be mostly stream metadata.** The 1000-character window holds about 15 lines of Input/Stream metadata before the 3-5 error lines. That is acceptable because the cause is present. Adding `-loglevel error` would shorten it further, but it would also remove the info-level log that `-v` shows on success. Leave it as is.
4. **The tests only cover the pure formatter.** Nothing asserts that runFfmpeg passes `-hide_banner` first or uses the `err.all` fallback. A `vi.mock("execa")` test asserting the argv and the thrown ProviderError message would lock in the behavior that actually changed. Other optional cases:
   - a log of exactly 1000 characters (should not get an ellipsis)
   - an empty or whitespace-only stderr
5. **A process failure with no stderr gives an empty message.** This was already true before the commit. If execa fails without stderr output (killed by a signal, or ENOENT after assertFfmpeg passed), the message is just `ffmpeg failed: `. One fix is to fall back to `err.shortMessage`. This is out of scope, so open a separate issue for it rather than widening this PR.
6. **Slicing by UTF-16 units can split a surrogate pair** in a non-BMP filename that sits exactly at the cut point. This is negligible.

## Verbose output change
With `-v`, a successful run still logs the full stderr at debug level. The only difference is that the version and configuration banner are gone. That does not matter: `multix check` already reports the ffmpeg version, and `ffmpeg -version` is in the docs. On failure, verbose mode never printed the full log, before or after this change. Only the error message carries it.

## magick-runner.ts
It has the same `slice(0,1000)`, but it does not matter. ImageMagick prints no banner, and its errors are short `magick: <reason> @ error/...` lines that fit well within 1000 characters. Only an unusually long run of warnings ahead of the error could push the cause out. No change is needed here. If consistency is wanted later, a shared tail helper is optional and not worth widening this PR. ImageMagick is not installed in this environment, so this was not run live.

## Docs
No update is needed. No doc (README, docs-site EN/VI, skill/SKILL.md) quotes the `ffmpeg failed:` text or the stderr-truncation behavior. The fix changes only the content of an error message. `fix(media)` is the correct commit type: it publishes a patch release with a changelog entry.

## Plan / issue follow-up
Issue #183's acceptance criteria are met: the banner is suppressed and the tail containing the cause is kept. Next, move the issue to `in review`, then `done` once the PR with `Closes #183` is opened.

Status: DONE
Summary: The fix is correct for all three runFfmpeg callers and was verified live: the error now shows the real ffmpeg cause, and success paths for video, audio and split are unchanged. There are no blocking findings, only optional polish (exact argv in the debug log, a runFfmpeg-level test).
Concerns/Blockers: none
