# Code review: `multix fal tts` / `multix fal voices` (issue #291)

Reviewer: isolated code-reviewer agent (did not write the code). Date: 2026-10-26.

## Scope
- Reviewed the uncommitted diff (33 files, +2314/-32). During the review the author committed it as
  `ed0a2b1 feat(fal): add typed text-to-speech with verified audio output`. `git diff HEAD~1 -- src worker/src/jobs`
  matches the diff I reviewed byte for byte, so the findings apply to that commit.
- Focus: src/core/audio-kind.ts, src/providers/fal/{speech-models,speech-input,speech-output,run-helpers,request-receipt,models}.ts,
  src/providers/fal/commands/{tts,voices,result,run,index}.ts, src/commands/agent/models-command.ts,
  worker/src/jobs/cli-command-policy.ts, the tests and the docs.

## Verification run
- `npm run typecheck`: pass. `npx biome check src tests worker/src`: clean.
- `MULTIX_DISABLE_HOME_ENV=1 npx vitest run tests/unit`: 88 files passed, 5 skipped (1453 tests passed, 14 skipped).
- worker `npm run typecheck` and `test/cli-catalog.test.ts`: pass.
- `npx tsx src/cli.ts models --json`: the `fal tts` row is speech, with default, 4 models, `async`, and `list: multix fal voices`.
- I wrote a probe script in the scratchpad that calls `resolveAudioExt` and `buildSpeechRequest` directly. Its results are quoted below.
- No paid calls. The live test is gated on `MULTIX_LIVE_TESTS=1` plus `FAL_KEY`.

## Overall
The structure is sound. The queue flow is reused and is not reimplemented. The submit path never retries and the receipts are shared. The runtime-neutral files have no `node:*` imports. The CDN download sends no auth header, and errors pass URLs through `redactUrl`. I found no key leaks and no logging of full prompts. The defects are in the audio-naming edge cases the feature promises to handle, and in download hardening that other providers already apply.

## Critical
None.

## High
None.

## Medium

### M1. `fal result --download` loses the requested raw format, so it mislabels or refuses PCM, mu-law and A-law audio
- Location: src/providers/fal/commands/result.ts:53-55 (calls `saveSpeechAudio` without `expectedExt`). Also src/providers/fal/speech-output.ts:89-96.
- Scenario: run `multix fal tts "Hi" -m elevenlabs/tts/eleven-v4 --format ulaw_8000 --detach`, then `multix fal result <model> <id> --download`. fal may serve the file with `content_type: application/octet-stream` and an extensionless URL, which is the shape the unit test at tts-command.test.ts:130 uses. In that case `declared` is undefined and frame-sync sniffing stays on. Mu-law silence is `0xFF 0xFF ...`.
  The probe showed `resolveAudioExt([ff ff ff ff], {ref:{url:".../out"}})` returning `{"ext":"mp3","verified":true}`. The raw mu-law is saved as a "verified" `.mp3`. That is the mislabelling the feature claims to prevent.
  Raw PCM that does not sniff is saved as `.bin` with a warning, or is refused (see M2).
- The docs at docs-site/.../commands/fal.md:165-172 say raw formats "are named from the requested format" and that `fal result --download` "applies the same checks". That is not true on the resume path.
- Fix options:
  1. Add `--format <fmt>` (or `--receipt <path>`) to `fal result` and pass `expectedExt: expectedAudioExt(profile, format)`.
  2. Or, for a verified profile that has a `formatField`, call `sniffAudioKind` with `frameSync: false` when no format is known. The model's raw formats are the only headerless outputs it can produce, and every compressed format it offers (mp3 with ID3, Ogg) has a real header.
  Add a test for detach, then `result --download`, with `pcm_16000` and `ulaw_8000` and an octet-stream response.

### M2. `looksLikeText` refuses valid raw PCM, mu-law and A-law, and deletes the paid output
- Location: src/core/audio-kind.ts:46-53 and src/providers/fal/speech-output.ts:87.
- Scenario: headerless samples can begin with any byte. If the first byte is `<`, `{` or `[`, or whitespace followed by one of them, the file is treated as an error page. The probe showed `resolveAudioExt([0x7b,1,2,3], {expected:"pcm"})` and `[0x20,0x0a,0x3c,0]` both throwing "fal returned text". The generation has already been paid for. The file is deleted. `fal result --download` runs the same check, so the CLI cannot recover the audio; only `--no-download` plus a manual fetch works.
- Fix: when `declared` is a raw format, do not use a single-byte heuristic. Either:
  - skip the text check and rely on the response Content-Type (refuse only `text/*` and `application/json`), or
  - require a real text signature, for example the first 64 bytes all being printable ASCII or UTF-8 and starting with `<!`, `<html`, `<?xml`, `{"` or `[{`.
  Add a test with PCM whose first byte is 0x7b.

### M3. A format taken from `--input` is not validated, but it becomes the output file extension (path escape)
- Location: src/providers/fal/speech-input.ts:124-126. The value flows through speech-models.ts `expectedAudioExt` and into speech-output.ts:105 and :160.
- Scenario: `--format` is validated against `profile.formats`. The `--input '{"output_format": ...}'` branch is not. The probe ran `buildSpeechRequest({model: eleven-v4, text:"hi", extra:{output_format:"../../../tmp/evil"}})`. That gives `expectedAudioExt` = `"../../../tmp/evil"`, and resolveAudioExt with unsniffable bytes returns ext `"../../../tmp/evil"`. `path.join("/out", "fal-req-01.../../../tmp/evil")` resolves to `/tmp/evil`.
- Today this is blocked only because fal's enum validation rejects the submit. For the MCP worker, which runs caller argv and relies on `nameOptions`-style rules to keep values out of file names, that is a remote API acting as the trust boundary. A model whose schema later relaxes the enum, or a proxy or mock, removes it.
- Fix: in `buildSpeechRequest`, validate `extra[formatField]` against `profile.formats` exactly as `--format` is validated. As defence in depth in `resolveAudioExt`, accept `expected` only when it matches `/^[a-z0-9]{1,5}$/`, the same rule `extOfName` uses. Optionally assert that `path.dirname(dest) === outDir` before the rename.

### M4. Speech downloads bypass the download size cap and URL validation that other providers apply
- Location: src/providers/fal/speech-output.ts:133 (`downloadToFile(ref.url, { dest: tmp })`).
- Scenario: atlascloud, runway, replicate, gemini omni and heygen all pass `maxBytes: maxDownloadBytes()` (`MULTIX_MAX_DOWNLOAD_MB`) and/or a `validateUrl` (https-only or output-host checks). The new speech path is a new call site, but it passes neither.
  - A result URL that streams without end, or a large wrong file, fills the disk. That matters in the worker container, where output limits are per job.
  - An `http://` or internal-address URL in the result (from an unlisted model whose output echoes caller input, via the `extractMediaUrls` fallback) is fetched without checks.
- Fix: pass `maxBytes: maxDownloadBytes()` and a `validateUrl` that requires https, reusing an existing helper such as heygen's `requireHttps`. If the generic `downloadResultMedia` should get the same treatment, track that in a separate issue; it is a pre-existing gap.

## Low

### L1. The rename of the temp file is not guarded, so a failure leaves a `.download` file behind
- Location: src/providers/fal/speech-output.ts:161.
- Scenario: `fs.renameSync(tmp, dest)` runs outside any try. On Windows, re-running `fal result --download` while the earlier file is open in a player raises EPERM or EBUSY. The `.download` temp file stays in the output dir, and in the worker it would be collected and uploaded as an output. `http-client.ts` already has `replaceFile` to deal with this.
- Fix: wrap the call in try/catch that removes `tmp`, and reuse or export `replaceFile`.

### L2. `field in extra` checks the prototype chain, and `__proto__` passes `FIELD_RE`
- Location: src/providers/fal/speech-input.ts:34, 66, 82.
- Scenario 1: `--text-field toString` gives `"toString" in {}` = true, which raises the misleading error "--text and --input both set toString".
- Scenario 2: `--text-field __proto__` makes `input["__proto__"] = text` set the prototype instead of a property. `JSON.stringify` drops it, so the request goes out with no text and fal rejects it after a round trip.
- Fix: use `Object.hasOwn(extra, field)`, and reject `__proto__`, `constructor` and `prototype` in `fieldName`. Alternatively, build `input` with `Object.create(null)` and copy it into a plain object.

### L3. Text set through `--input` skips the length and blank checks; `--voice-field` equal to `--text-field` silently overwrites
- Location: src/providers/fal/speech-input.ts:72-86, 88-101.
- Scenario 1: `--input '{"text":"<6000 chars>"}'` on ElevenLabs is submitted, and fal rejects it after the HTTP round trip. The flag path catches this locally.
- Scenario 2: `--text-field x --voice-field x --voice v` sends `x = v`. The text is lost with no error.
- Scenario 3: for Gemini, `--text` together with `--input '{"turns":[...]}'` sends both `prompt` and `turns`, and their precedence is undocumented.
- Fix: apply `maxTextChars` and the blank check to `extra[textField]` when it is a string. Refuse a `voiceField` equal to `textField`. Refuse `--text` together with the dialogue field, or document which one fal uses.

### L4. Downloads with extensionless URLs are now renamed for image, video and `fal run`, and no test covers it
- Location: src/providers/fal/run-helpers.ts:270-288, 310-317.
- This changes the file names that `fal image`, `fal video` and `fal run` produce when the URL has no extension: for example `.png` instead of `.bin`. The change is reasonable, but it falls outside the TTS scope and has no test.
- If `renameSync` fails, the catch block removes the original `.bin` and logs "Download failed", although the download succeeded.
- Fix: add a unit test for an extensionless URL with `image/png`, and one for a URL that already has an extension staying untouched. In the catch, only report a download failure when the download itself failed.

### L5. `fal voices --live` has no timeout and prints catalog strings unsanitised
- Location: src/providers/fal/speech-models.ts (`listFalSpeechCatalog`, `fetchFn(url, ...)`) and src/providers/fal/commands/voices.ts:99-100.
- Scenario 1: a stalled catalog response hangs the command indefinitely. There is no `AbortSignal.timeout`, and a page can contain up to 5x100 entries.
- Scenario 2: `endpoint_id` and `display_name` come from a remote JSON response and are written to the terminal as they are, so control or escape sequences pass through.
- Fix: pass `signal: AbortSignal.timeout(...)`, and strip C0/C1 control characters before printing in text mode.

### L6. The worker's output content types do not cover the new audio extensions
- Location: worker/container/job-outputs.mjs:17-36.
- `.flac`, `.aac`, `.aiff`, `.pcm`, `.ulaw` and `.alaw` outputs from `fal tts` upload as `application/octet-stream`. Opus (`.ogg`), mp3, wav and m4a are covered.
- This is informational. If it is changed, the change must follow the container-first rollout rule in AGENTS.md.

## Informational / checked, no action needed
- The `multix models` change counts `--detach` as `async`, which also marks the `fal run` row `async: true`. That is correct, since `fal run --detach` exists, and the test at tts-command.test.ts:329 covers it.
- Moving `persistReceipt` into request-receipt.ts is behaviour-preserving for `fal run`.
- The worker policy entry for `fal tts` routes `--text-file` through `inputs` and blocks `--receipt`. `--input @path` is already refused globally (run-argv-builder.ts:60), and `--output-dir` is forced.
- Receipts store the full `input`, including the spoken text, under `~/.multix/fal/requests/`. This matches `fal run` and nothing is logged at info level.
- Docs cover all the required surfaces: EN and VI command pages, EN and VI environment pages, README, skill/SKILL.md and .env.example. Apart from the M1 claim, the EN page is consistent with the code.

## Recommended actions (priority order)
1. M3: validate `output_format` from `--input` and sanitise `expected` in `resolveAudioExt`. This is a one-line regex plus a list check.
2. M1 and M2: make raw-format handling robust on the `fal result` path and against false positives from the text check, and add tests for both.
3. M4: add `maxBytes` and `validateUrl` to the speech download.
4. L1, L2 and L3: small hardening changes in the same files.
5. L4: add a test for the rename by Content-Type in `downloadResultMedia`.

## Metrics
- Typecheck: 0 errors (root and worker). Lint: 0 issues.
- Tests: 1453 passed, 14 skipped. The new suites are speech-input, tts-command and audio-kind; tts-live is gated.
- Coverage: not measured. No test covers M1 (result with a raw format), M2 (raw bytes that look like text) or L4.

## Unresolved questions
- What does fal actually return in `audio.content_type` and `file_name` for ElevenLabs `pcm_*`, `ulaw_8000` and `alaw_8000`? If it always sends `audio/pcm` or `audio/basic`, or a `.pcm` file name, M1 shrinks to the extensionless octet-stream case. Only a live run can settle this.
- Should Gemini `--text` together with `turns` be refused, or does fal define a precedence between them?

## Resolution (author)

Fixed and covered by tests:

- **M1:** `fal result` accepts `--format <fmt>`, validated against the model's format list. A `--detach` receipt's `result_command` includes it when a format was requested. A live check of ElevenLabs `ulaw_8000` shows fal returns `file_name: output.ulaw` and `content_type: audio/basic`, so real results already name the raw type. `--format` covers bare URLs as well.
- **M2:** the text and error-page check is skipped when the declared type is raw (pcm, ulaw or alaw).
- **M3:** `output_format` passed through `--input` is checked against the model's formats. Every extension, including the expected one, must match `^[a-z0-9]{1,5}$`.
- **M4:** the audio download now uses `maxBytes: maxDownloadBytes()` and `checkUrlSafety` on every redirect hop.
- **L1:** a failed rename removes the `.download` file.
- **L2:** fields are checked with `Object.hasOwn`, and `__proto__`, `constructor` and `prototype` are refused as field names.
- **L3:** text passed through `--input` gets the blank and length checks. `--voice-field` equal to `--text-field` is refused.
- **L4:** a failed rename keeps the `.bin` download instead of reporting a failure. A test covers the extensionless rename in `fal run`.
- **L5:** the catalog fetch has a 30 s timeout and strips control characters.

Left as is:

- **L3:** Gemini `prompt` together with `turns` is passed through; fal's schema allows both, and multix does not guess which one wins.
- **L6:** worker content types are informational, with no behaviour change needed for this issue.
