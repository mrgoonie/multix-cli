# Code review: Gemini Lyria music (`generate-music`, `music-live`)

- Commit: `ade8895` (branch `claude/relaxed-clarke-j0e5fj`), issue #527
- Reviewer: isolated code-reviewer, 2026-10-31 06:45 UTC
- Scope: 32 files, +2878/-15. Focus: `src/providers/gemini/{lyria,lyria-realtime}.ts`,
  `generators/{music,music-live}.ts`, `commands/{generate-music,music-live}.ts`, budget,
  capability registry, worker policy, tests, EN/VI docs.
- Checks run: `npx vitest run` on the 4 touched test files (61 passed), `npm run typecheck` (clean),
  plus a scratch probe (outside the repo) that drove `classifyError` and `LyriaRealtimeSession`
  directly. External facts checked against ai.google.dev music-generation, realtime-music-generation
  and pricing pages.

## Verdict

Solid structure and good test coverage of the happy paths. One High finding (an ambiguous paid
failure is reported to agents as "retry"), which defeats the "never re-sent" guarantee the commit
advertises. Four Medium findings in the RealTime path: frame trimming corrupts audio on unaligned
chunks, timed config changes silently reset other settings, and the signal and socket-error paths
skip `--output` and the agent envelope.

## High

### H1. An ambiguous `generate-music` failure is classified as retryable, which invites a second paid song
- `src/providers/gemini/generators/music.ts:102-110`
- Problem: on `HttpError` status 0 the generator re-wraps the error as a `ProviderError` whose text says
  "not re-sent". The text is fine. The classification is wrong: `classifyError` falls through to
  `classifyMessage`, which matches the inner text. Probe output:
  - `fetch failed` gives `NETWORK_ERROR`, `retryable: true`, exit 4, hint "Network failure: retry".
  - `Request timed out after 600000ms` gives `TIMEOUT`, `retryable: true`.
  - Raw 502/503/504 responses after a multi-minute generation are not wrapped at all. They surface as
    `PROVIDER_UNAVAILABLE` or `TIMEOUT`, both retryable, even though a gateway 5xx can follow a
    backend that already produced and billed the song.
- Failure scenario: an agent in `--json` mode gets `retryable: true` and follows the hint. It reruns
  the command and pays $0.08 again, possibly in a loop.
- Fix: follow the existing pattern in `src/providers/fal/run-helpers.ts:56-105` and
  `src/providers/fish/tts-client.ts:110-135`. For status 0, for 2xx bodies that could not be read
  and for gateway 5xx (`isRetryableServerStatus`), throw
  `new MultixError(msg, UNKNOWN_REMOTE_STATE, { cause })`. That code is non-retryable, exits 6 and
  carries the "check before resubmitting, or you may pay twice" hint. Add a test that asserts
  `classifyError(err).retryable === false` and `code === "UNKNOWN_REMOTE_STATE"`. The current test
  ("never re-sends the request after a dropped connection") only counts fetch calls, so it cannot
  see this problem.

## Medium

### M1. Trimming to whole frames per chunk misaligns all later audio when a chunk is not frame-aligned
- `src/providers/gemini/lyria-realtime.ts:443-449`
- Problem: each chunk drops `pcm.length % 4` trailing bytes. Those bytes are the first half of a
  frame whose second half starts the next chunk, so dropping them shifts every later sample.
  Probe: a 6-byte chunk followed by an 8-byte chunk delivered `[1,2,3,4,7,8,...]`, and
  `5,6` were lost. An odd remainder byte-swaps every sample and produces full-scale noise. A
  remainder of 2 swaps left and right.
- Failure scenario: the server (or a proxy that re-frames) sends one chunk of 4n+2 bytes. The
  rest of the recording is channel-swapped or static, and the WAV still looks valid.
- Fix: keep a carry buffer of the remainder and prepend it to the next chunk. Trim only against
  `room` at the end, where `room` is always a multiple of 4. Add a test with unaligned chunks.

### M2. Timed `config` changes send a partial config, which the server treats as "reset everything else"
- `src/providers/gemini/lyria-realtime.ts:461-462`, `:471-474`, `:200-205`
- Problem: Google's realtime docs say: "you need to set the whole configuration otherwise the other
  fields will be reset back to their default values." The session sends each `change.config` alone.
  `config: {}` is also accepted and sends an empty config, which resets every field.
- Failure scenario: `--bpm 80 --mute-drums --scale D_MAJOR_B_MINOR` with a file change
  `{at:30, config:{density:0.2}}`. At 30 s, drums return, scale and temperature revert, and
  `muteDrums` is lost. The docs claim "flags override it", which holds only for the initial config.
- Fix: keep an effective config, `effective = {...effective, ...change.config}`, and send the
  merged object. Send `RESET_CONTEXT` only when `bpm` or `scale` actually differs from the previous
  effective value; otherwise every merged config that carries bpm would reset the context. Reject
  an empty `config`. State the merge rule in the EN and VI docs.

### M3. Ctrl-C / SIGTERM skips `--output` and the agent envelope
- `src/providers/gemini/generators/music-live.ts:171-183`
- Problem: `onSignal` finalises the WAV and then calls `process.kill(process.pid, signal)`. The
  process dies on the default action, so:
  - The `--output` copy (`:198-203`) never happens.
  - `finalizeRun` in `agent-runtime.ts` never runs: no JSON envelope, no history entry, no receipt
    with the saved path.
- Failure scenario: the documented example `music-live ... --output live.wav`, stopped with Ctrl-C
  at 2 minutes. `live.wav` does not exist; the audio sits only under
  `gemini_music_live_<stamp>.wav`, which appears in one warn line. An agent harness that sends
  SIGTERM on its own timeout gets no envelope at all.
- Fix: copy to `--output` inside `onSignal` after `writer.finish()`. Then exit through
  `process.exit(128 + n)` as `src/providers/atlascloud/commands/output-claims.ts:209-216` does,
  so the overridden `process.exit` records the run. Alternatively, document that `--output` is
  written only when the recording finishes. The stdin-file helper uses the same re-raise pattern,
  but this path, unlike that one, produces a user deliverable.

### M4. A socket `error` after audio has arrived rejects instead of ending as `closed`
- `src/providers/gemini/lyria-realtime.ts:360-368`
- Problem: the `close` handler correctly treats `bytes > 0` as a partial success. The `error`
  handler fails regardless of bytes. WHATWG WebSockets (undici in Node 22) fire `error` before
  `close` when the connection is failed, for example an abnormal 1006 drop. `fail()` sets
  `settled`, so the `close` handler never gets a turn.
- Failure scenario: a network blip at minute 4 of a 10-minute recording. The command throws
  (exit 1 with an error classification, not the documented "partial kept, exit 1" result path).
  `--output` is not written, and `seconds`/`reason` are not printed.
- Fix: in the error handler, if `this.bytes > 0`, log the error at debug level and
  `finish("closed")`. Keep `fail()` for the zero-bytes case.

## Low

- **L1. Prompts-file validation gaps.** `lyria-realtime.ts:190-205`, `:119-149`. A `null` entry
  in `changes` throws a raw `TypeError` (probe: "Cannot read properties of null (reading 'at')"),
  which is classified `UNKNOWN` rather than `INVALID_INPUT`. Unknown keys inside a change object are
  silently accepted, although the module claims "unknown fields are refused". `mute_bass` and
  `muteBass` together are accepted, and the last one wins silently. Fix: check that each change is
  an object, reject keys outside `at|prompts|config`, and reject alias/camel duplicates.
- **L2. `--duration` range does not match its message.** `lyria-realtime.ts:181-186`, `:328`.
  The error says 1-600 but any value above 0 passes. A value such as 0.00001 rounds to 0 frames:
  the socket opens, the session "completes" on the first chunk and an empty WAV is saved (probe
  confirmed the value is accepted). Fix: require `>= 1`, as documented.
- **L3. WAV `response_format` shape is unverified.** `lyria.ts:116`. The official samples request
  WAV with `response_format: {"type": "audio"}` only. The code adds `mime_type: "audio/wav"`. If the
  API rejects the extra field, WAV requests fail with a 400 (not billed). If it ignores it, the
  result is the same as the docs. Byte sniffing already guards the saved extension. Fix: match the
  documented body, or confirm with a gated live smoke test.
- **L4. Images are read before the count check, and the total body size is unbounded.**
  `music.ts:58-82`. `readLyriaImages` loads and base64-encodes every image before
  `validateLyriaRequest` checks the count of 10. Ten 20 MB images make a JSON body of about 270 MB,
  far above any inline request limit. Fix: check the count first and cap the total inline bytes.
- **L5. A non-completed interaction loses its id.** `lyria.ts:170-174`. A `status` other than
  `completed` throws without `r.id`, even though `run.postUsage` already counted it as billed. Put
  the id in the message so the user can look it up.
- **L6. Filtered prompt text is logged.** `music-live.ts:156-159`. Up to 80 characters of a
  filtered prompt go to warn level. This is a fragment, not a full prompt, so it is acceptable
  under AGENTS.md, but consider the reason alone at warn and the text at debug.
- **L7. Blob messages can be reordered.** `lyria-realtime.ts:398-404`. A Blob message is read
  asynchronously, so a later string or ArrayBuffer frame can overtake it. The Node factory sets
  `binaryType = "arraybuffer"`, so only a custom factory reaches this path. Informational.
- **L8. Timed changes land late.** Changes fire on audio received, and the server generates ahead
  of what the client has received, so a change at `at` is heard somewhat later. Worth one line in
  the docs ("approximately at").
- **L9. Usage is recorded before parsing.** `music.ts:114` records `request.count` before parsing,
  so a failed or empty interaction shows $0.04/$0.08 actual. This is a deliberate, conservative
  choice and is commented.

## Verified as fine

- **Runtime neutrality:** `lyria.ts` and `lyria-realtime.ts` import only `core/errors.js`. Globals
  used (`atob`, `setTimeout`, `TextDecoder`) exist in Workers. No `node:*` imports.
- **Key leakage:**
  - The `?key=` URL exists only inside `start()`.
  - Socket error and close-reason text passes through `scrub()`, which removes the raw key, the
    URL-encoded key and any `[?&]key=` value, then truncates.
  - `guardExternalRun` gets `LYRIA_REALTIME_URL` without the key, so dry-run output and
    `run.externalRuns` are clean.
  - Debug messages never include the URL.
  - `generate-music` sends the key in a header.
  - The test "never puts the key in an error message" covers the socket error path.
- **No re-send or double session:**
  - `fetchJson` has no retry.
  - `withGeminiKey` rotates only on 429 or `RESOURCE_EXHAUSTED`, so only after a refusal.
  - RealTime failures are `ProviderError`, never `HttpError`, so they cannot trigger rotation or a
    second session.
  - The session is never reconnected.
- **Dry-run safety:** `recordGeminiMusicLive` calls `guardExternalRun` before
  `nodeWebSocketFactory()`, the WAV file is created after it, and the guard `realExit`s in dry-run.
  `generate-music` goes through the fetch-telemetry dry-run. Images and lyrics files are local reads.
- **WAV correctness:**
  - The 44-byte header from `wrapPcmInWav` has its sizes rewritten at offsets 4 and 40 by a
    positional `writeSync` at 0.
  - `finish()` is idempotent.
  - The WAV is finalised on complete, close, error-after-audio and signal.
  - The file is removed when 0 bytes were recorded.
  - 600 s × 192 000 B/s is about 115 MB, well under the uint32 limit.
- **Session state machine:**
  - `settled` guards every entry point.
  - The single timer is re-armed per chunk and cleared in teardown.
  - `STOP` is sent before `close(1000)`.
  - The setup timeout covers open plus `setupComplete`.
  - An idle stream with audio ends as `closed`; without audio it rejects.
  - A close before any audio rejects, and the empty file is deleted.
- **Pricing:** the Gemini pricing page lists Lyria 3.5 at $0.08 per song and Lyria 3 Clip Preview
  at $0.04 per song, with no free tier ("Not available"). Lyria RealTime has no listed price, and
  `music-live` stays unknown, so `--max-cost` refuses it with `BUDGET_UNPROVEN`. The estimate
  honours `GEMINI_MUSIC_MODEL` through `runtimeDefaults`.
- **Protocol (RealTime):** the setup, `clientContent.weightedPrompts`, camelCase
  `musicGenerationConfig`, `playbackControl` and `serverContent.audioChunks` / `filteredPrompt`
  messages match the SDK facts in the brief. 48 kHz stereo 16-bit PCM and the bpm/scale context
  reset match the docs. Weight "any value except 0" matches the validation.
- **Protocol (Interactions):** `POST /v1beta/interactions`, string `input` or a list of
  `{type:"text"}` and `{type:"image", mime_type, data}` items, at most 10 images, and audio taken
  from `steps[].type == "model_output"` content all match the music-generation docs.
- **Worker policy:**
  - `gemini music-live` is in `EXCLUDED_COMMANDS`.
  - The `generate-music` `fileOptions` (`image`, `lyrics-file`) match catalog option names.
  - `--image` has `default: []`, so `isRepeatable` treats it as multi-file.
  - `JOB_TIMEOUT_MS` (30 min) exceeds `MUSIC_TIMEOUT_MS` (10 min).
- **Docs:** EN and VI `commands/gemini.md`, `reference/environment.md` and
  `reference/for-ai-agents.md` changed together, and `llms.txt.ts` was updated. `skill/SKILL.md` and
  `skill/speech-production/SKILL.md` (`metadata.tasks` includes `music`) were updated, as was
  `.env.example`. Docs claims match the code apart from the items above:
  - The 1-600 duration range (L2).
  - The Ctrl-C example with `--output` (M3).
  - "flags override" the config (M2).

## Recommended order

1. H1: switch ambiguous failures to `UNKNOWN_REMOTE_STATE` and add a classification test.
2. M1: carry the frame remainder between chunks.
3. M2: merge timed configs and reset context only when bpm or scale changes.
4. M3 and M4: write `--output` and exit through `process.exit` on a signal; treat an `error`
   after audio as `closed`.
5. L1-L5.

## Unresolved questions

- Does the Interactions API accept `response_format.mime_type` for Lyria 3.5 WAV (L3)? This needs a
  gated live check.
- Does Lyria RealTime ever send chunks that are not frame-aligned? M1 is a latent defect whichever
  way this goes, but the answer sets its urgency.

## Resolution (implementer)

- H1 fixed: dropped connections and timeouts (unless the connection was never made) and 502/503/504 now raise `UNKNOWN_REMOTE_STATE` (`retryable: false`); tests assert the classification.
- M1 fixed: a partial trailing frame is carried into the next chunk; test checks byte-exact continuity.
- M2 fixed: timed config changes are merged into the config in effect and sent whole; `RESET_CONTEXT` only when bpm or scale changes.
- M3 fixed: the signal handler finalises the WAV, copies it to `--output`, sets `run.interrupted` and exits 128+n through the agent runtime.
- M4 fixed: a socket error after audio ends the recording as `closed`.
- Low fixed: `--duration` below 1, `null` or unknown-key entries in `changes`, and the image count is checked before images are read.
- Low kept: `response_format.mime_type: "audio/wav"` is a documented value of `AudioResponseFormat.mime_type` in `@google/genai` 2.32.0, and the saved file's extension follows the sniffed bytes either way. Usage recorded before parsing is deliberate. The 80-character filtered-prompt excerpt at warn level is kept so the user can see which prompt was filtered.
