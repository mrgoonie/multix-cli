# Code Review: 344b828 feat(gemini): accept piped stdin via --files - (issue #24)

## Scope
- Commit: 344b828 only (parent = Gemini key-rotation branch, not reviewed)
- Files: src/core/stdin-file.ts (new, 170 LOC), src/providers/gemini/commands/{analyze,transcribe,extract}.ts, tests/unit/core/stdin-file.test.ts, tests/smoke/cli.test.ts, README.md, docs-site EN/VI gemini.md, skill/SKILL.md
- LOC: +417 / -37
- Method: the tree at 344b828 was extracted into a scratch directory (the shared worktree is now on another branch and has uncommitted changes, so it was not touched). Ran tsc, biome, vitest unit and smoke, and CLI probes against the built dist/cli.js.

## Verification results (at 344b828)
- `tsc --noEmit`: 0 errors
- `biome check src tests`: clean (191 files)
- `vitest run tests/unit/core/stdin-file.test.ts`: 24/24 pass
- `vitest run tests/smoke/cli.test.ts` (after `npm run build`): 11/11 pass
- Commander probes:
  - `--files a.txt - --prompt x`, `--files=-` and mixed inputs all parse correctly. Commander 12 treats a bare `-` as a value, not an option.
  - `--stdin-ext` without `-` is rejected.
- Empirical probes (details in the findings):
  - An open stdin pipe that never sends data hangs forever.
  - SIGINT/kill during the read leaves `multix-stdin-*` directories behind.
  - UTF-16LE text is detected as `.mp3`.
  - HEIC, AVIF and `mif1` are detected as `.mp4`.
  - Control-byte binary is detected as `.txt`.

## Overall Assessment
The core design is sound:
- Stdin is streamed to disk, not buffered.
- The temp directory is made with mkdtemp (0700 on POSIX) and the file is opened with 0600.
- The extension override is validated against a strict regex, which blocks path traversal.
- The single-`-` rule and the `--stdin-ext`-without-`-` rule are validated before stdin is read.
- Labels are applied consistently in the logs and in all output formats.

The cleanup guarantee claimed in the commit message and docs ("removed after the run, also on errors and process exit") does not hold for signals. Magic-byte detection has realistic false positives that silently send the wrong MIME type. No Critical issues.

---

## Critical Issues
None.

---

## High Priority

### H1. Stdin contents are left in the temp directory on Ctrl+C, SIGTERM or kill
- **Where:** src/core/stdin-file.ts:93-122 (no hook while reading) and :163 (`process.once("exit", cleanup)` only)
- **Failure scenario:**
  1. Ctrl+C during a long Files API upload or processing poll (videos can take minutes), or `timeout`/CI cancellation sending SIGTERM.
  2. Node's default signal handling terminates without emitting `exit`, so the listener never runs.
  3. During the stdin read itself there is no hook at all. The `try/catch` cleanup only covers thrown errors.
  4. Verified: spawning the CLI, writing 1 MB to stdin and sending SIGINT before EOF leaves `multix-stdin-XXXXXX/input` in TMP.
  5. The piped data may be sensitive (the issue explicitly asks to avoid exposing it) and can be gigabytes.
  6. This contradicts the docs ("deleted after the run") and the commit message.
- **Fix:**
  1. Register cleanup immediately after `mkdtempSync`, before the read loop.
  2. Add one-shot handlers for `SIGINT`, `SIGTERM` and `SIGHUP` that run cleanup and then exit 128+signo (or re-raise with `process.kill(process.pid, sig)` after removing the handler).
  3. Remove the handlers in `cleanup()`.
  ```ts
  const dir = fs.mkdtempSync(...);
  const onSignal = (sig: NodeJS.Signals) => { cleanup(); process.kill(process.pid, sig); };
  const cleanup = () => { /* idempotent rm + process.off("exit"...) + process.off(sig, onSignal) */ };
  process.once("exit", cleanup);
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(s, onSignal);
  ```
  4. TerminateProcess on Windows (and SIGKILL) cannot be caught. Optionally sweep stale `multix-stdin-*` directories older than 24h at the next run, and soften the docs wording.

---

## Medium Priority

### M1. A non-TTY stdin with no writer hangs forever
- **Where:** src/core/stdin-file.ts:86-91, :102
- **Failure scenario:**
  1. `isTTY` is falsy for any non-console stdin, not only for real pipes. Two common cases:
     - agent or CI harnesses that spawn the CLI with an inherited, never-closed pipe (the issue comes from AgentKit, and `skill/SKILL.md` advertises `--files -` to agents);
     - Git Bash/mintty on Windows, where stdin is a pipe, not a console.
  2. Running `multix gemini analyze --files -` without piping blocks indefinitely, with no output.
  3. Verified: a child process with stdin `pipe` and no data printed nothing and had not exited after 3s.
- **Fix:**
  - If no first chunk arrives within about 2-5s, print a one-line stderr hint: "waiting for piped data on stdin (Ctrl+D / Ctrl+Z to end)…". A hard first-byte timeout is optional and could be configurable.
  - At minimum, document that `-` blocks until EOF.

### M2. ftyp brand mapping sends HEIC, HEIF and AVIF images as `video/mp4`
- **Where:** src/core/stdin-file.ts:40-46
- **Failure scenario:**
  1. `cat IMG_0001.HEIC | multix gemini analyze --files -` is a common iPhone photo case.
  2. Brands `heic`, `heix`, `mif1`, `msf1` and `avif` hit the `return ".mp4"` default (verified).
  3. task-resolver maps `.mp4` to `video/mp4`. The image is sent inline as video, or uploaded and then polled as video.
  4. Result: a Gemini 400 or processing failure, while `.heic` (`image/heic`) is already supported in MIME_MAP.
- **Fix:**
  - Map `heic`/`heix`/`heim`/`heis` to `.heic`, and `mif1`/`msf1`/`heif` to `.heif`.
  - For `avif`/`avis` (and `jp2 `, `crx `) return `undefined`, which falls back to `.bin` and asks the user for `--stdin-ext`, instead of defaulting to mp4.
  - Restrict the mp4 default to known video brands (`isom`, `iso2`-`iso6`, `mp41`, `mp42`, `avc1`, `dash`, `M4V `, `M4P `, `f4v `) and treat everything else as unknown.
  - Optional: map `M4B ` to `.m4a`. `3g2*` currently maps to `.mp4` (acceptable) but should be `.3gpp`.

### M3. UTF-16LE text is detected as MP3
- **Where:** src/core/stdin-file.ts:48-52 (frame-sync check `(b1 & 0xe0) === 0xe0` runs before the text check)
- **Failure scenario:**
  1. UTF-16LE begins with the BOM `FF FE`. Since `0xFE & 0xE0 === 0xE0`, it returns `.mp3` (verified).
  2. On Windows (this project's primary dev platform) UTF-16LE text files are common: PowerShell 5.1 `>` redirection, Notepad "Unicode", `reg export`.
  3. `cat notes.txt | multix gemini extract --files -` then sends text as `audio/mp3`.
- **Fix:**
  - Check BOMs first: `FF FE` and `FE FF` mean UTF-16 text. Return `.txt` after transcoding, or return `undefined` so the user passes `--stdin-ext`.
  - Tighten MPEG audio detection: require a valid layer (`(b1 & 0x06) !== 0`) and a valid bitrate/sample-rate index in byte 2 (`(b2 & 0xf0) !== 0xf0 && (b2 & 0x0c) !== 0x0c`). Note that FF FE 00 would still pass the layer check, so the BOM check is required.

### M4. A cleanup failure throws away results the user already paid for, and is unguarded in the exit hook
- **Where:**
  - analyze.ts:101, extract.ts:98, transcribe.ts:102 (`cleanup()` before `formatResults`)
  - src/core/stdin-file.ts:94, :156-160
- **Failure scenario:**
  1. On Windows, Defender or the search indexer often holds a fresh file briefly. `fs.rmSync(..., { force: true })` ignores only ENOENT, not EBUSY/EPERM.
  2. `cleanup()` throws before `formatResults`. All Gemini responses for the batch are lost, and cli.ts prints `Error: EBUSY ... C:\Users\...\multix-stdin-xxx\stdin.pdf`, which leaks the temp path.
  3. `done = true` is set before the rm, so the exit hook will not retry.
  4. If the throw instead happens inside the `exit` listener, Node prints a stack trace.
- **Fix:**
  - Use `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })` wrapped in try/catch. Log at debug only, without the path.
  - In the commands, wrap the loop and `formatResults` in `try { … } finally { cleanup(); }` so output is never blocked by cleanup and the success path does not rely on the exit hook.

### M5. Stdin size is unbounded, and large inputs are loaded twice into memory downstream
- **Where:** src/core/stdin-file.ts:102-109 (no cap); src/providers/gemini/client.ts:92 and :99 (`readFileSync` + `Buffer.concat`)
- **Failure scenario:**
  1. Streaming to disk is correct (memory bounded to the 4 KB head plus chunk size).
  2. However, `uploadFile` then reads the whole temp file and copies it into a multipart body, about 2x the input size in RAM.
  3. `ffmpeg … -f mp4 - | multix gemini analyze --files -` of a 1.5 GB video means about 3 GB RSS. Above about 2 GB (the Files API limit) it ends in OOM, a Buffer size error, or a 400 only after the whole upload.
  4. An accidental `cat /dev/urandom |` fills TMP. On distros where /tmp is tmpfs, "disk" is RAM.
  5. The `readFileSync` path predates this commit, but stdin makes arbitrarily large, unknown-size inputs much more likely.
- **Fix:**
  - Abort the read with a ValidationError once `size` exceeds the Files API limit (2 GB). Stop reading and clean up.
  - Follow-up issue: stream the multipart upload (resumable upload protocol) instead of `readFileSync`.

### M6. Docs overstate the guarantees and omit Windows and fallback behaviour
- **Where:** docs-site/src/content/docs/commands/gemini.md:20-23 (VI mirror :20-23), README.md:142-143, skill/SKILL.md:353
- **Problems:**
  - "The temporary copy is private and is deleted after the run": false on Ctrl+C or kill (H1). "Private" relies on POSIX modes; on Windows it relies on %TEMP% being per-user (true by default, not if TMP is overridden).
  - "set it with `--stdin-ext` when detection cannot tell": detection can also be silently wrong (M2, M3).
  - Undetected input becomes `.bin`, which maps to `application/octet-stream`, which Gemini rejects. This is undocumented.
  - `--stdin-ext` values not in MIME_MAP (e.g. `xyz`, `mkv`) also silently become octet-stream.
  - In Windows PowerShell, `cat photo.png | multix …` (Get-Content) re-encodes binary as text. The PNG arrives as mangled UTF-8 and is detected as `.txt`. The README and skill examples use `cat`. Recommend a note: use Git Bash/cmd (`type file | …`) or pass the path directly. Exact PowerShell 7.4 native-pipe semantics were not verified here.
  - A literal file named `-` now needs `./-`. This is a small behaviour change worth one sentence.
- **Fix:** reword to "removed when the command finishes or exits with an error"; mention the octet-stream fallback, the list of accepted `--stdin-ext` values, and the PowerShell caveat. Update EN and VI together.

---

## Low Priority

### L1. Temp paths leak into results despite the header comment
- **Where:** src/providers/gemini/client.ts:144, :146 (`File processing failed: ${filePath}`, `Processing timeout: ${filePath}`); also any fs error message (`ENOENT … stdin.mp4`)
- **Scenario:** a stdin video that fails Files API processing puts `/tmp/multix-stdin-AbC123/stdin.mp4` into `error` in json/csv/markdown output. This contradicts stdin-file.ts:7-8 ("temp paths are never logged") and the issue's requirement.
- **Fix:** have client errors use `path.basename(filePath)`, or have the commands replace `filePath` with `label` in caught error messages.

### L2. Text detection and prefix-only signatures give false positives
- **Where:** src/core/stdin-file.ts:28-39, :53, :57-65
- **Scenario:**
  - Text starting with `ID3` (e.g. "ID3 tag notes") becomes `.mp3` (verified); `GIF8`, `%PDF-`, `OggS`, `fLaC` and `FORM…AIFF` are similar.
  - Arbitrary control-byte binary without NUL that is valid UTF-8 becomes `.txt` (verified: `01 02 03 04 05 7F 10`).
  - `stream: true` hides a truncated trailing sequence, which is intended.
- **Fix:**
  - Strengthen the signatures: `ID3` + version byte 2-4 + flags; `GIF87a`/`GIF89a`.
  - In `looksLikeText`, reject a high ratio of C0 controls other than `\t\n\r\f`.

### L3. Container mislabels and gaps
- **Where:** src/core/stdin-file.ts:47
- **Scenario:**
  - EBML is mapped to `.webm` unconditionally, so Matroska (`matroska` DocType) is sent as `video/webm`.
  - BMP (`BM`, in IMAGE_EXTS/MIME_MAP), MPEG-TS (`0x47` sync) and MPEG-PS (`00 00 01 BA`) are not detected and fall back to `.bin`.
- **Fix:** check the EBML DocType string in the head (`webm` vs `matroska`; return undefined for matroska since `.mkv` has no MIME mapping). Add `BM` → `.bmp` and `00 00 01 BA` → `.mpeg`.

### L4. Unchecked `writeSync` return and non-exclusive open
- **Where:** src/core/stdin-file.ts:100, :107
- **Scenario:**
  - `fs.writeSync` performs a single write syscall and returns the bytes written. A short write (e.g. near ENOSPC) silently truncates the file while `size` counts the full length.
  - `"w"` (no O_EXCL) is safe only because the directory is private.
- **Fix:** open with `"wx"`, and loop on `writeSync` until the whole buffer is written (or use `fs.createWriteStream` with `stream/promises.pipeline`, which also handles backpressure).

### L5. `--stdin-ext` help text and validation
- **Where:** analyze.ts:30, extract.ts:28, transcribe.ts:31; stdin-file.ts:67-73
- **Scenario:**
  - Transcribe's help suggests `.md` as the example (the docs use `mp3`).
  - Any 1-10 alphanumeric extension is accepted, even when it maps to octet-stream.
  - The three commands repeat the option text verbatim.
- **Fix:**
  - Use a per-command example (`.mp3` for transcribe).
  - Warn when `getMimeType("x" + ext)` is octet-stream.
  - Optional: a shared `addStdinOptions(cmd)` helper.

### L6. Stdin is consumed before cheap preconditions are checked
- **Where:** analyze.ts:50 / extract.ts:48 / transcribe.ts:51
- **Scenario:** with no GEMINI_API_KEY, a multi-GB pipe is fully written to disk, then every file fails with "GEMINI_API_KEY is not set" (smoke test confirms this ordering).
- **Fix:** check key availability before `resolveFileInputs` (low cost, good UX).

### L7. Label collisions
- **Where:** stdin-file.ts:165-167
- **Scenario:** `--files stdin -` (a real file named `stdin` plus a pipe) produces two results both labelled `stdin`.
- **Fix:** label piped input `-` or `<stdin>`, which cannot collide with a relative path, or document the collision.

---

## Edge Cases Found by Scouting
- Commander 12: a bare `-` is a value (verified mixed, last-position and `--files=-` forms). No variadic problem.
- `mkdtempSync` gives 0700 on POSIX; Windows ignores modes and relies on per-user %TEMP% ACLs.
- The `exit` listener is added per call and removed on cleanup, so it does not leak across calls (unit tests call `resolveFileInputs` repeatedly).
- Issue #24 says "commands that currently take file paths". `multix doc convert --input <files...>` also uploads to Gemini but was not changed. Scope question for the lead.

## Test Gaps
1. No detection tests for the false-positive classes above:
   - UTF-16LE/BE BOM
   - HEIC/AVIF/mif1 ftyp
   - Matroska vs WebM
   - text starting with `ID3`/`RIFF`
   - control-byte binary
   The `it.each` titles use `%#` (indexes), which makes failures hard to read. Use `%s` with the expected extension.
2. Nothing proves cleanup on signals, or on the success path of a real command. The smoke test only covers the error path where `process.exit(1)` fires the exit hook.
3. No test that a thrown `cleanup()` (e.g. mocked `rmSync` EBUSY) does not suppress results.
4. No POSIX-only assertion of file mode 0600 / dir 0700 (`it.skipIf(process.platform === "win32")`).
5. No test for the open-pipe/no-data behaviour (M1), or for TTY rejection through the CLI (only via the injected `isTTY` object).
6. No CLI-level test for `--stdin-ext` parsing, the invalid-ext error, or a label in csv/markdown output with mixed inputs.
7. "removes the temp directory when reading fails" scans the shared `os.tmpdir()`. This is fine today, but it is fragile if another test file starts creating `multix-stdin-*` concurrently. Inject a tmp root instead.

## Recommended Actions (priority order)
1. H1: register signal and early cleanup hooks before reading; soften the docs wording.
2. M4: move `cleanup()` into `finally` after `formatResults`; add `maxRetries` and try/catch in cleanup.
3. M2 + M3: fix ftyp brand mapping and BOM / MPEG-sync detection; add regression cases.
4. M1: add a stderr "waiting for stdin" hint when no data arrives quickly.
5. M5: cap stdin at the Files API limit; open a follow-up issue for a streaming upload.
6. M6: docs corrections (EN + VI + README + SKILL).
7. L1-L7 as convenient; L1 is a one-line fix and matches the issue's explicit requirement.

## Metrics
- Type coverage: tsc strict clean; no `any` introduced (one `as unknown as StdinLike` cast for process.stdin, acceptable)
- Tests: 24 unit + 2 new smoke, all passing; behaviour gaps listed above
- Lint: 0 issues

## Plan / Task Follow-ups
- Issue #24 requested items:
  - `--files -`: done.
  - Temp materialization: done.
  - Extension detection: done, with accuracy gaps (M2, M3).
  - Cleanup: partial, missing on signals (H1, M4).
  - Avoid logging paths: partial (L1).
- Not ready for the `in review` → `done` transition until H1 and M4 are addressed and docs are corrected.

## Unresolved Questions
1. Should `doc convert --input` also accept `-` under issue #24, or should a separate issue cover it?
2. Should an open pipe with no data be a hard timeout error, or only a hint (agent UX vs. slow producers such as `ffmpeg`)?
3. Should piped input be labelled `stdin` (current) or a collision-proof `<stdin>`/`-`? This is a user-facing output contract.

Status: DONE_WITH_CONCERNS
Summary: The commit is functionally correct for the happy path and passes tsc, biome and all tests, and commander handles `-` correctly. However, piped data stays in the temp directory on Ctrl+C/SIGTERM (verified), a cleanup failure can discard paid results, and magic-byte detection silently mislabels HEIC/AVIF as mp4 and UTF-16LE text as mp3 (both verified). The docs overstate the cleanup guarantee.
