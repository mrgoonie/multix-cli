# Code review: `multix fal tts` (commit 250141d, issue #291)

Reviewer: isolated code-review agent. Scope: `git diff HEAD~1 HEAD` (31 files, +2142/-101).
Method: read the full source diff, the worker policy and test diff, and the helpers the diff relies on
(`detectExtension`, `extFromContentType`/`extFromUrl`, `downloadToFile`, `parseJsonInput`, the worker
`checkText`). I pulled fal's public OpenAPI schemas (keyless, free) for `google/gemini-3.8-flash-tts`
and `elevenlabs/tts/eleven-v4`, ran `multix models --json` from `dist/`, ran
`npx vitest run tests/unit/providers/fal/` (125 passed, 2 live tests skipped), and ran a tsx probe
against `buildTtsInput` / `chooseMediaExt` / `audioProblem`. I made no paid calls and edited no source.

## Verdict

No critical or security blockers. One medium gap against the issue's acceptance criteria
("validate model-specific fields before submit", "refuse blank audio"), plus a few low-severity edge cases.
Safe to merge once the medium items are fixed or accepted as follow-ups.

## Findings

### M1. Fields passed through `--input` skip all validation (Medium)
`src/providers/fal/tts-models.ts:240-343` (`buildTtsInput`). Only the flag values are validated. Whatever
comes in `extra` is merged in unchecked at line 342 (`{ ...extra, ...input }`). I confirmed each of these
with the probe:
- `--input '{"text":"<6000 chars>"}'` on ElevenLabs is submitted. `maxChars` is checked only for the
  positional or file text.
- `--input '{"output_format":"mp3_bogus"}'` is submitted. `expectedOutput` even becomes `mp3`.
- `--input '{"voice":"Nobody"}'` on Gemini is submitted. The voice list is enforced only for `--voice`.
- `--input '{"turns":"nope"}'` and `turns` without `speakers` are submitted. The live schema needs
  `turns[]` items `{speaker_id, text(min 1)}`, and `speakers` has exactly 2 entries, each with a
  `voice` from the same 30-voice list.

Failure scenario: an agent following the documented dialogue path (`--input` with `turns`/`speakers`)
makes a typo. fal accepts the job, it fails at result time, and the user is billed. The module header says
it exists to prevent exactly this.
Fix: validate the merged `input` rather than the flags. Run the same checks on the profile's own fields
whatever their source: text length, `voice` enum, `output_format` enum, language pattern. For Gemini,
check `turns` (a non-empty array of `{speaker_id: string, text: non-empty string}`) and `speakers`
(exactly 2 entries, voice enum, ids covering every `turns[].speaker_id`).

### M2. A header-only or zero-sample WAV passes as "usable audio" (Medium)
`src/providers/fal/run-helpers.ts:955-962` (`audioProblem`). Only a 0-byte body, a text body, or a
non-audio extension is refused. A 44-byte RIFF/WAVE header with an empty `data` chunk returns
`undefined` (confirmed by the probe), so it is saved and reported as success. Gemini runs with
`enable_safety_checker` on by default, so an empty clip from a filtered prompt is a plausible
"blank audio" case, and the issue explicitly asks to refuse those.
Fix: for `.wav`, parse the chunks and require a `data` chunk with size > 0. Failing that, require a
minimum byte count for headered formats, for example > 44 for WAV and > 1 frame for MP3.

### L1. Text-sniffing can reject valid raw audio (Low)
`run-helpers.ts:957`. `audioProblem` runs `detectExtension(head) === ".txt"` even when the declared
format is raw (`.pcm`, `.ulaw`, `.alaw`). Headerless audio whose first 4 KB are printable ASCII is
refused as "the body is text" and then deleted. Examples are A-law digital silence (`0x55`, "UUUU…")
or quiet 8-bit data. Probe: `chooseMediaExt` returns `.pcm` for `fileName: "output.pcm"`, yet
`audioProblem` rejects the same bytes. `chooseMediaExt` already trusts the declaration for raw formats,
so `audioProblem` should too.
Fix: skip the text check when `RAW_AUDIO_EXTS.has(ext)`.
A related gap: when fal declares nothing usable (`application/octet-stream`, no extension), raw bytes
can sniff as `.aac` or `.mp3` (probe: `0xFF 0xF1…` gives `.aac`), or fall back to `.bin`, which the
audio check then refuses. `buildTtsInput` already knows `expectedOutput` (`pcm`/`ulaw`/`alaw`). Pass it
to `downloadResultMedia` as a last-resort declared extension.

### L2. ElevenLabs length check counts UTF-16 units, not characters (Low)
`tts-models.ts:286`. `text.length` counts each astral character (emoji, some CJK) as 2. The probe
rejected 2600 emoji ("Text is 5200 characters") although the schema's `maxLength: 5000` counts code
points, so valid input is refused and the error overstates the length.
Fix: use `[...text].length`.

### L3. `field in extra` matches prototype keys (Low)
`tts-models.ts:246, 257, 279, 292`. `in` follows the prototype chain. With an untyped model,
`--text-field toString` (or `valueOf`, `hasOwnProperty`) passes `FIELD_RE`/`UNSAFE_FIELDS`. Then
`!text && !("toString" in extra)` is false, so no text error fires, and `{}` is submitted and billed
(probe output: `{"input":{}}`).
Fix: use `Object.hasOwn(extra, field)`.

### L4. Download staging name is not unique per process (Low)
`run-helpers.ts:1019`. The staging file is `fal-<id>-NN.download.part`, which is shared by concurrent
`fal tts` / `fal result --download` runs for the same request id. One run can rename or delete the other's
staged file. The rename fallback at lines 1033-1039 also deletes `filepath` for any rename error, not only
"target exists". `downloadToFile` already writes to a unique part file and has a stricter
`replaceFile` in `src/core/http-client.ts:109`.
Fix: add pid and random to the staging name, and reuse or export `replaceFile` instead of the local
copy.

### L5. `listFalModels` can loop forever on a misbehaving page (Low)
`src/providers/fal/catalog.ts:142-171`. If the API returns `has_more: true` with the same
`next_cursor` and no models, the `do/while` never ends.
Fix: stop when a page adds nothing or the cursor repeats, or cap the page count at
`ceil(limit/100) + 1`.

### L6. Duplicated queue flow (Low, maintainability)
`src/providers/fal/commands/tts.ts:589-618` copies the submit, `onAccepted`, receipt and detach block of
`commands/run.ts:74-104` line for line. Moving `persistReceipt` was a good first step. A shared
`submitWithReceipt(client, model, input, opts, logger)` would keep the never-retry/receipt behaviour in
one place.

### Informational
- Worker: `checkText` (`worker/src/jobs/run-argv-builder.ts:60`) rejects any value that starts with
  `@`, so remote TTS text like `"@team hello"` is refused. That is acceptable (it blocks
  `--input @/path` reads in the container), but it is worth a line in the MCP docs. `--text-file` via
  `inputs` is the workaround.
- `multix models` `inputs` still lists output and presentation flags (`--output`, `--no-webp`,
  `--no-thumb`, `--wait`, `--poll-interval`) for other providers. Harmless, but `NON_INPUT_OPTIONS`
  is only partly applied.
- The behaviour change for `fal run/image/video/result`: the extension now follows the sniffed bytes
  over the URL. I checked `detectExtension`. Text (`.txt`) is ignored in favour of the declared
  extension, and unknown types (glb, zip, mkv, avif, UTF-16) fall back to the declared extension. The
  only cosmetic regressions are `.m4v` → `.mp4` and `.opus` → `.ogg`. Nothing breaks.

## Checked and fine
- Profiles match fal's live OpenAPI: all 30 Gemini voice names and all 19 ElevenLabs `output_format`
  values are identical. The field names `prompt` / `style_instructions` / `turns` / `voice` and `text`
  (max 5000) / `voice` (free-form, default Rachel) / `output_format` / `language_code` are correct.
  Gemini `prompt` is nullable, so prompt-or-turns is right.
- Flags a model has no field for (`--style` on ElevenLabs, `--format`/`--language` on Gemini,
  `--text-field` on typed models, text plus `turns`) are rejected before submit. Setting a field both by
  flag and in `--input` is rejected.
- Text plus `--text-file` is rejected. The file is size-capped at 1 MB, the BOM is stripped
  (`tts.ts:520` has a literal U+FEFF), and empty files are refused.
- `submitFalRequest` is reused, so there is still a single, never-retried submit. The receipt is built in
  `onAccepted` and stores only `input_hash`, not the prompt. `--detach` prints the receipt. No key,
  signed URL or prompt is logged at info level. Download problems use `redactUrl`.
- `tts-models.ts` has no `node:*` imports. `catalog.ts` sends no fal key.
- `extractMediaRefs` keeps the old URL extraction semantics: known shapes first, then the generic scan.
  `extractMediaUrls` / `extractMediaUrlsGeneric` stay exported for compatibility.
- `fal run/image/video/result` only swapped to refs. Their exit codes and messages are unchanged.
- `multix models --json` shows `fal tts` as `task: speech`, `output: audio`, `async: true`, with typed
  `models`, `default_model` and `inputs`. `fal run` now correctly reports `async: true` (it has
  `--detach`). The new fields are additive.
- Worker policy: `fal tts` maps `text-file` to a downloaded input and marks `receipt` unsupported.
  `--output-dir` is forced by the server. `@` values are blocked globally. The catalog JSON includes
  `fal tts` and `fal models`. The argv-builder tests cover the positional `--` separator.
- The live test is gated on `MULTIX_LIVE_TESTS=1` and `FAL_KEY`. Unit tests use the fake fal/fetch.
- `FAL_TTS_MODEL` is registered in `project-env-names.ts`, `.env.example` and both docs locales.

## Recommended actions
1. M1: validate the merged input (including `turns`/`speakers`) before submit.
2. M2: refuse WAVs with an empty `data` chunk.
3. L1 to L3: one-line fixes (raw-format text-check skip, code-point length, `Object.hasOwn`).
4. L4 and L5: harden the staging name and the catalog pagination. L6 can be a follow-up issue.

## Unresolved questions
- What `content_type` / `file_name` does fal return for ElevenLabs `alaw_8000` / `ulaw_8000` /
  `pcm_*`? The tests assume `output.pcm`. `audio/alaw` is not in either MIME table. Answering this needs
  one paid call per format, which this review did not make.

## Resolution (author, after review)

All findings were fixed in the follow-up commit on the same branch:

- **M1**: `buildTtsInput` now validates the merged input (flags plus `--input`) through `checkTyped`. It checks text length, voice and format enums, the language code, a non-empty style, and the Gemini dialogue shape (exactly 2 speakers with known voices, distinct ids, and turns that name a speaker and have non-empty text). Voices are normalised to the endpoint's spelling. A live run showed that fal's Gemini endpoints reject even a well-formed dialogue upstream (HTTP 422). This is tracked in #310; `tts` warns before submitting a dialogue, and the docs say so.
- **M2**: `audioProblem` refuses a WAV that has no bytes after its `data` chunk header. It counts bytes rather than trusting the size field, because streaming writers leave that field at 0.
- **L1**: Raw formats skip the text check. `downloadResultMedia` takes `fallbackExt`, and `tts` passes the expected container, so headerless bytes with no declared type are named correctly. The A-law and µ-law MIME types were added.
- **L2**: Length is counted in code points.
- **L3**: Key checks use `Object.hasOwn`.
- **L4**: The staging name is unique per download (`randomUUID`), and the rename uses the shared `replaceFile` from `src/core/http-client.ts`.
- **L5**: `listFalModels` stops on an empty page or a repeated cursor.
- **L6**: The submit, receipt and detach code is shared as `submitOrDetach` in `run-helpers.ts` and used by `fal run` and `fal tts`.
