# Code review: offline media QA commands (issue #253)

Scope: uncommitted changes. 11 new files in src/commands/media/, plus media/index.ts, command-capabilities.ts, error-classify.ts, worker cli-command-policy.ts and cli-catalog.json, ci.yml, and the tests.
Gates: build, typecheck and lint pass. The 114 targeted tests pass. check:mcp passes.
Every finding below was reproduced with dist/cli.js and ffmpeg 6.1.1, except where marked (reasoning).

## Blocker

1. **A `%` in the input file name makes ffmpeg judge different bytes from the ones hashed. The receipt then vouches for the wrong file.**
   - Where: media-source.ts:86 (`ffInput`). The image2 demuxer expands `%03d` even with the `file:` prefix.
   - Repro: `thumb%03d.png` is all black (sha 13fad1…). `thumb000.png` is a test pattern. `media verify 'thumb%03d.png' --profile thumbnail` returned `pass` with black_percent=8. The receipt carries the black file's sha256, so check-receipt would vouch for a blank thumbnail.
   - Fix: pass `-pattern_type none`. ffprobe accepts it for every format. ffmpeg rejects it for non-image2 inputs ("Option pattern_type not found"), so add it there only when the probe's format_name includes image2, or force `-f image2 -pattern_type none` in that case. Alternatively, refuse input paths that contain `%`. Apply the same fix in media-frames.ts. Add a test.

## Major

2. **A rule timeout is not enforced when the rule's child keeps stdout open.**
   - Where: media-rule.ts:81-93.
   - Repro: a `.sh` rule running `sleep 40` with `--rule-timeout 2` took 41 s. execa kills only `sh`, then waits for the pipe to close.
   - Related: a backgrounded grandchild (`(sleep 37 >/dev/null &)`) outlives the run, after its cwd has been deleted.
   - Fix: spawn `detached: true` (its own process group) and kill `-pid` on timeout or cancel. On Windows, use `taskkill /T /F`. Also bound the wait for the streams after the kill.

3. **A video track that is shorter than the audio passes as complete.**
   - Where: media-verify.ts:265-277. `decoded_s` is the maximum over all output streams.
   - Repro: a file with 2 s of video and 4 s of audio passes camera-footage. Black and freeze checks cannot see the 2 s with no video frames.
   - Fix: compare each mapped stream's end time (or the probe's stream duration_s) with the container duration. Fail or warn on a gap larger than max(0.5 s, 2 frames).

4. **False "truncated" failures.**
   - Where: media-verify.ts:265-270. The check uses the format duration, which is (a) estimated from bitrate for raw mp3/adts and (b) the length of the longest stream, even when that stream is not mapped.
   - Repro (a): an intact VBR mp3 written without a Xing header reported "decoded 20 s of a declared 24.25 s (truncated)" and failed.
   - Repro (b): `--profile audio` on a video with 4 s of video and 2 s of audio failed as truncated.
   - Fix: take `declared` from the mapped streams' duration_s, and do not assert truncation for raw elementary formats (mp3, aac/adts, ac3) unless there are decode errors. Otherwise report the result as unknown or warn.

5. **`media frames` fails on any video whose container is longer than its video track.**
   - Where: media-frames.ts:80 (`probe.duration_s ?? video.duration_s`).
   - Repro: the 2 s video / 4 s audio file failed with "could not extract a frame at 2.5 s: Output file is empty".
   - Fix: prefer `video.duration_s`, then the format duration.

6. **Ctrl-C does not run cleanup, and the comment claiming it does is false.**
   - Where: media-quality-commands.ts:45-59 (`cancellable`).
   - What happens: `process.once` removes the listener before it runs, so execa's signal-exit sees no other listeners and re-raises SIGINT. Node exits 130 at once. No ffmpeg process was leaked (verified), but `finally` blocks never run.
   - Repro: SIGINT during `media frames --count 100` left `<out>/.frames-XXXX/` holding 11 PNGs. Rule temp cwds are left behind the same way.
   - Effect: the `ValidationError("Cancelled")` path is dead code, and the cancel test only covers the library path.
   - Fix: use `process.on` and remove the listeners in `finally`, then re-raise or set exit code 130 after cleanup. Or clean up in an exit hook, as stdin-file.ts `trackTempDir` does.

## Minor

7. **Missing-binary classification matches text in user-controlled messages.**
   - Where: error-classify.ts:251-253.
   - Repro: `--profile-file ffmpeg-missing.json` (the file does not exist) was reported as BINARY_MISSING, exit 3, with the hint "Install the missing tool". The regex matches the user's path plus "ENOENT".
   - Fix: throw a dedicated error class or code from assertFfmpeg/assertFfprobe instead of matching text.

8. **check-receipt crashes on malformed receipts.**
   - Where: media-receipt.ts:154-181.
   - Repro: a receipt without `profile` gave "Cannot read properties of undefined (reading 'id')". A receipt containing JSON `null` gave "reading 'schema'". Both exit as UNKNOWN.
   - Also: `status` is not checked against its enum.
   - Note (by design): receipts are not signed. A hand-made `{schema, status:"pass", source.sha256}` passes check-receipt. Document that a receipt proves byte identity, not integrity of the verdict.

9. **The verify cache is trusted without checks.**
   - Where: media-verify.ts:568-584.
   - The cache key covers only the rule entry file's hash. Changes to modules the rule imports, or to its interpreter version, do not invalidate the cache.
   - A cache entry is accepted after only a schema and sha check, so a shared or poisoned `--cache-dir` can supply a `pass`.
   - Fix: document both limits, and re-check that the entry's engine, profile.sha256 and rule hashes equal the current ones.

10. **A black hold also reports a freeze.**
    - Repro: a 2 s black tail produced both a black failure and a freeze failure.
    - Effect: an intended fade-out needs both `--allow-black` and `--allow-freeze`.
    - Fix: either treat a freeze range inside a declared black range as intentional, or document this in the help text.

11. **`numberFlag("")` returns 0.**
    - Where: media-quality-commands.ts:31.
    - Effect: `--loudness ""` becomes a 0 LUFS target.
    - Fix: reject empty or whitespace-only values.

12. **Output paths containing `%` break `media frames`.**
    - Where: media-frames.ts:109 and :152.
    - Repro: `--output-dir '.../100%done'` failed with "Conversion failed!".
    - Fix: use `-update 1` with a `file:` prefix for single-frame output, or escape `%` as `%%` in the image2 input and output paths.

## Nits

- **Timeout budget:** `--timeout` applies to each ffmpeg/ffprobe call separately, so verify or inspect --decode can take about twice the given time. Remote callers can also pass an unbounded `--timeout` (reasoning).
- **Cache hit fields:** a cache hit returns the original `generated_at` and the original `rules[].file` paths.
- **Hash timing (reasoning):** the bytes are hashed, then decoded, then re-hashed. A file swapped out and back between the two hashes is not detected. Acceptable.

## Checked and confirmed OK

- **Process spawning:** ffmpeg and ffprobe are spawned with argv only (no shell), with `-protocol_whitelist file` and a `file:` prefix. URLs and protocols are refused.
- **Text inputs:** text files, playlists and concat lists never reach ffprobe.
- **Filter values:** all values put into filter strings are zod-validated numbers, so filters cannot be injected.
- **Rule environment:** rules see only PATH (and PWD); verified by dumping the environment.
- **Timeout or cancel never passes:** a timed-out or cancelled decode is reported as unknown or incomplete, never `pass`.
- **Incomplete receipts:** they are not cached.
- **Changed source:** a source that changes during verification forces incomplete.
- **Unknown values:** ffprobe values that are missing or N/A stay null.
- **Platform targets:** profiles carry no platform targets; loudness is checked only when requested.
- **A/V sync:** it is listed as not measured.
- **Worker policy:** it blocks `rule`, `cache-dir` and `receipt-out`.
- **Job container:** it ships ffmpeg.

## Test gaps

There are no tests for:
- a `%` in the input name;
- a video track shorter than the container;
- raw VBR mp3 duration;
- a rule whose grandchild holds the pipe;
- CLI-level SIGINT cleanup;
- malformed receipts;
- classifier false positives on paths.

## Resolution (author)

1. Fixed: a `%` in the input path gets `-pattern_type none` (ffprobe always; ffmpeg when the input is image2); `media frames` runs ffmpeg with the staging directory as cwd and relative names, so a `%` in `--output-dir` is not a pattern either. Tests: `thumb%03d.png`, `frames 100%`.
2. Fixed: rules lead their own process group (POSIX) and the group is killed on timeout, cancel and after the rule exits; Windows uses `taskkill /T`. Test: a rule whose child holds stdout times out in ~1 s and leaves no child.
3. Fixed: new `track_lengths` check for video profiles fails when the picture ends before the sound (warns for the reverse).
4. Fixed: truncation is judged against the decoded streams' durations, and not asserted for raw formats whose duration ffprobe estimates (`declared_duration_estimated`). Tests: audio profile on a short-video file, VBR mp3 without Xing.
5. Fixed: `media frames` samples the video stream's duration.
6. Fixed: the signal listener stays registered for the run, so execa does not re-raise and `finally` cleanup runs; a second Ctrl-C exits at once. Smoke test: SIGINT during `frames --count 100` leaves no staging directory.
7. Fixed: `MissingBinaryError` (code `BINARY_MISSING`) replaces text matching.
8. Fixed: malformed receipts (null, no profile, unknown status) are rejected as invalid input; docs say receipts are unsigned.
9. Documented: only the rule's own file is hashed; the cache dir is trusted local state.
10. Fixed: `--allow-black` ranges also cover freeze findings.
11. Fixed: an empty number flag is invalid.
12. Fixed with 1.

## Re-review

Commit: 471395f. Reviewed by a separate agent that did not write the fix.
Gates: build, typecheck and lint pass; the 122 targeted media and classifier tests pass.
Each finding was reproduced with dist/cli.js and ffmpeg 6.1.1. For the regressions, the old behaviour was confirmed by building 471395f^ separately.

### Per finding

| # | Verdict | Evidence |
|---|---|---|
| 1 | Resolved | `thumb%03d.png` (black) next to `thumb000.png` (pattern): verify now hashes and judges the black file (black_percent=100, fail). `j%d.jpg`, `100%.png`, `v%03d.mp4`, `a%03d.mp3` and `w%d.wav` all verify. ffprobe accepts `-pattern_type none` for mp4, mkv, mp3 and wav. ffprobe 4.4 only warns about unused demuxer options, so older ffprobe is not a regression. ffmpeg gets the flag only for image2 inputs; without that guard it fails with "Option pattern_type not found". |
| 2 | Resolved | A rule running `sleep` with `--rule-timeout 2` finishes in 2.65 s. Backgrounded (`&`) and subshell grandchildren are killed after the rule exits. A rule that escapes with `setsid` still survives; it is local user code, so this is not a trust boundary. See new finding N3 for parent-exit cases. |
| 3 | Partly resolved | mp4: 2 s of video with 4 s of audio now fails `track_lengths`. **Not resolved for mkv or webm.** ffprobe reports stream `duration=N/A` there (only `tags.DURATION`), so the check is skipped and `shortv.mkv` and `shortv.webm` still pass camera-footage. See N2. |
| 4 | Partly resolved | (a) A VBR mp3 without a Xing header passes. (b) `--profile audio` on an mp4 with a short audio track passes. **(b) is not resolved for mkv:** `shorta.mkv --profile audio` still fails with "decoded 2.0 s of a declared 4.023 s (truncated)", because the stream durations are null and the check falls back to the format duration. (a) introduced regression N1. |
| 5 | Partly resolved | mp4: frames sample over 2 s. **mkv still fails** with "could not extract a frame at 2.514 s", for the same null stream duration (N2). |
| 6 | Resolved | SIGINT and SIGTERM (to the pid, and to the whole group) during `frames --count 100` leave no staging dir and no ffmpeg. SIGINT during a rule leaves no rule temp dir and no rule process. Before the fix, SIGINT to the pid left the rule's `sleep` and its temp dir behind. See N4 and N5 for side effects. |
| 7 | Resolved | `--profile-file ffmpeg-missing.json` now gives INVALID_INPUT, not BINARY_MISSING. Note: `assertMagick` (magick-runner.ts:16) still throws a ValidationError and is classified INVALID_INPUT. That behaviour predates this feature and is not a regression; switching it to MissingBinaryError would be a follow-up issue. |
| 8 | Resolved | These receipts are all rejected as INVALID_INPUT with no crash: `null`, `{data:null}` in an envelope, a bare string, a receipt without `profile`, and one with an unknown status. The docs now say receipts are unsigned. |
| 9 | Resolved (documented) | README, docs-site (en/vi) and SKILL.md say only the rule's own file is hashed and that the cache dir is trusted local state. VERIFY_ENGINE was not bumped, which is fine because the feature has not shipped (147906b is not on origin/main). |
| 10 | Resolved | camera-footage with a black tail and `--allow-black 4-6`: black and freeze both pass as intentional. A red still at 6-9 s right after an allowed black range at 4-6 s still fails freeze. The allowed range covers only freezes contained in it. |
| 11 | Resolved | `--loudness ""` and `--loudness " "` are now invalid. |
| 12 | Resolved | `--output-dir '.../o2 50%d' --sheet` writes 4 frames and sheet.png. |

### New findings

**N1. Major (regression): a truncated mp3 with a Xing/Info header now passes `decode`.**
- Where: media-verify.ts:206 (`RAW_FORMATS`) and :267-272.
- Cause: `estimated` is true for every `mp3` (and `aac`, `ac3`, …) container, so `declared` becomes null and truncation is never asserted. libmp3lame, LAME and ffmpeg write a Xing/Info header by default, so most mp3 files do have an exact duration.
- Repro: take a 24 s VBR mp3 written by ffmpeg (Xing present) and cut it to half its bytes with `head -c`. The new build returns `pass` with decoded_s=11.9, declared_duration_s=null, declared_duration_estimated=true and error_count=0. The old build returned `fail`: "decoded 11.9 s of a declared 24.03 s (truncated)".
- Signals available: ffprobe reports 24.03 s for that file and warns "filesize and duration do not match (growing file?)". It warns "Estimating duration from bitrate, this may be inaccurate" only for files without a header.
- Impact: a cut-off download or upload of an mp3 gets a `pass` receipt. This is exactly the failure verify exists to catch.
- Fix: mark the duration as estimated only when ffprobe says so.
  - Run the probe with `-v warning` (or a second, stderr-only pass) and set the flag when stderr matches `Estimating duration from bitrate`.
  - Treat `filesize and duration do not match` as truncation evidence.
  - Keep the bitrate-only exemption for adts aac, which has no header.
  - Add a test with a cut mp3 that has a Xing header.

**N2. Medium: mkv and webm have no per-stream `duration`, so the fixes for 3, 4b and 5 do not apply to them.**
- Where: media-probe.ts:154 and :169 (`duration_s: num(s.duration)`).
- Repro (ffmpeg-muxed `.mkv`/`.webm`, 2 s video + 4 s audio, and the reverse):
  - `track_lengths` is skipped and camera-footage passes.
  - `--profile audio` on the reverse file fails as truncated.
  - `media frames` fails at 2.51 s.
- Fix: in `normaliseStream`, when `duration` is N/A, fall back to parsing `tags.DURATION` (`HH:MM:SS.fffffffff`, written by the Matroska muxer). Add mkv fixtures to the tests for 3, 4 and 5.

**N3. Low (regression): a detached rule outlives the CLI when the parent dies from a signal it does not handle.**
- Where: media-rule.ts:118 (`detached: posix`) together with media-quality-commands.ts:59-60.
- Cause: execa skips its `cleanup` for detached children. The rule's own process group no longer receives the terminal's SIGHUP or Ctrl-C. Only SIGINT and SIGTERM are handled.
- Repro: a `.sh` rule running `sleep` with `--rule-timeout 60`.
  - SIGHUP to node: the `sleep` survives and the `multix-rule-*` temp dir is left behind. Before the fix, closing the terminal killed the whole foreground group.
  - SIGKILL to node: the same leak, but it also leaked before the fix.
- Fix:
  - Add `SIGHUP` to the signals `cancellable` listens for.
  - In runRule, register a `process.on("exit")` hook that synchronously calls `process.kill(-pid, "SIGKILL")` while the rule is running. `exit` also fires on the second-signal `process.exit`.
  - SIGKILL cannot be handled. Document that limit.

**N4. Low/Medium: a cancel is reported as INVALID_INPUT with exit code 2.**
- Where: media-quality-commands.ts:63 and :66 (`throw new ValidationError("Cancelled")`).
- Effect: SIGINT and SIGTERM now end with `{"code":"INVALID_INPUT","message":"Cancelled","hint":"Fix the flagged input; nothing was billed…"}` and exit code 2. Before the fix they ended with 130/143. Agents and CI read exit 2 as a usage error, and the hint is wrong.
- Fix: after cleanup, remove the listeners and re-raise the signal with `process.kill(process.pid, signal)`. Or set `process.exitCode = 130/143` and use a dedicated cancelled error that does not go through INVALID_INPUT.

**N5. Low: the first Ctrl-C is ignored while the source is hashed.**
- Where: media-quality-commands.ts:55-60, and media-source.ts:37 (`hashFile` takes no signal).
- Cause: the listener now replaces Node's default exit, and hashing does not watch the abort signal.
- Repro: an 8 GB file, SIGINT 1 s into verify. The process exited 43 s later, after the full hash. The same happens for the second hash at media-verify.ts:692.
- Fix: pass the AbortSignal to `hashFile` and stop between chunks. `stream.pipeline(..., { signal })` or a per-chunk `signal.throwIfAborted()` would do.

**N6. Info: the post-exit `killTree()` (media-rule.ts:155) sends SIGKILL to the process group whose ID was the rule's pid, after that pid has been reaped.**
- Linux does not reuse a pid while it is still a live process-group ID, so this is safe while grandchildren exist. When none remain, the call hits a stranger only if the pid has already been recycled as a new group leader. That is negligible, but worth a comment.
- Windows (by design, per the code comment): grandchildren are killed only on timeout or cancel, not after a normal exit. I could not run Windows here.

### Checked and confirmed OK (fix-specific)

- **Other commands:** the signal listeners are removed in `finally`, so other commands keep Node's default signal behaviour.
- **Second signal:** a second signal exits at once. execa's cleanup still reaps non-detached ffmpeg.
- **AAC priming:** `track_lengths` passes normal mp4s whose audio is a few tens of ms longer (ok.mp4, full mkv). Audio that is shorter than the video gives only a warning. Images never run the check, since only `media: "video"` profiles do.
- **Cut faststart mp4:** half the bytes still fails decode ("decoded 4.48 s of a declared 10 s", plus 3 decode errors), because `declared` comes from the stream durations in the moov at the front. A cut mkv still fails.
- **adts aac:** a cut adts aac still fails, but only through its decode errors. A cut on a frame boundary would pass, and that limit was there before the fix.
- **Contact sheet:** `media frames` runs ffmpeg with its cwd in the staging dir, and the input stays an absolute `file:` path.

### Test gaps still open

- a truncated mp3 with a Xing header (N1);
- mkv or webm with unequal tracks (N2);
- a CLI-level SIGHUP during a rule (N3);
- the exit code of a cancelled run (N4).

Status: DONE_WITH_CONCERNS
Summary: 8 of 12 findings are fully resolved (1, 2, 6, 7, 8, 10, 11, 12) and 9 is resolved by documentation. 3, 4 and 5 are fixed for mp4 but not for mkv or webm. The raw-format exemption brings a Major regression: a truncated mp3 with a Xing header now passes.

## Re-review resolution (author)

- N1 (truncated Xing mp3 passed): fixed. The format-name list is gone; a duration counts as estimated only when ffprobe (now run at `-v warning`) prints "Estimating duration from bitrate", exposed as `format.duration_estimated`. A 6 s Xing mp3 cut in half now fails `decode`; the VBR mp3 without a Xing header still passes with `declared_duration_estimated: true`.
- N2 (mkv/webm stream durations): fixed. A stream without `duration` falls back to its `DURATION` tag, so findings 3, 4b and 5 now hold for Matroska too (test: `short-video.mkv` fails `track_lengths`, passes `decode` under `--profile audio`, and `media frames` samples only the picture's 2 s).
- N3 (SIGHUP): fixed. SIGHUP is handled like SIGINT/SIGTERM, so closing the terminal cancels the run and kills the rule's process group through the abort path.
- N4 (cancel reported as INVALID_INPUT): fixed. After cleanup a cancelled CLI run exits with 128 + the signal (130, 143, 129) and prints "Cancelled" on stderr; the smoke test asserts 130. The library API still returns an `incomplete` receipt when cancelled mid-run, and it skips the post-run re-hash since the receipt is incomplete anyway.
- N5 (Ctrl-C ignored while hashing): fixed. `hashFile` takes the abort signal (`createReadStream({ signal })`), so the source and rule hashes stop on the first Ctrl-C.
- N6: accepted as documented; no Windows runner was available to test grandchild cleanup after a normal exit.

Evidence: lint and typecheck clean; `npm test` 125 files passed (8 skipped), 2202 tests passed; `check:mcp` 393 tests passed and the bundle is clean; `verify:docs` 0 errors, 8/8 passed; the worker catalog is unchanged.
