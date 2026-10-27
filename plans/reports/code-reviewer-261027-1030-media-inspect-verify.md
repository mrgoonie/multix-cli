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
