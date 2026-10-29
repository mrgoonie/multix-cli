---
title: fal.ai commands
description: Run any fal.ai queue model with local files and detached jobs, or use the image, video and text-to-speech commands with typed inputs and sensible defaults.
---

fal.ai commands require `FAL_KEY`. `run` works with any fal model id;
`image`, `video` and `tts` set sensible defaults and download media automatically.

```bash
multix fal run fal-ai/flux/schnell --input '{"prompt":"a cyberpunk cat"}'
multix fal run fal-ai/flux/schnell --input @input.json
```

`--input` accepts inline JSON or `@path/to/file.json`. By default the command
polls to completion and downloads any media URLs found in the result;
`--no-download` prints the result JSON instead, and `--output-dir <dir>` picks
the download folder (default `MULTIX_OUTPUT_DIR` or `./multix-output`).
Progress goes to stderr, so stdout holds only the result JSON, the receipt, or
the saved file paths.

## Local files

fal models take media as URLs fal can fetch. `--file field=path` uploads a
local file to fal storage first and writes its URL into the input at `field`,
so you do not have to host the clip yourself:

```bash
multix fal run fal-ai/mmaudio-v2 \
  --input '{"prompt":"soft rain on a window","duration":8}' \
  --file video_url=./shot.mp4

multix fal run fal-ai/hunyuan-video-foley \
  --input '{"text_prompt":"footsteps on gravel"}' \
  --file video_url=./shot.mp4 --detach
```

- Repeat `--file` for several fields. `a.b=path` sets a nested field,
  `field[]=path` appends to an array (after any URLs already in `--input`).
  A `--file` value replaces the same field from `--input`.
- `--input` is optional when `--file` gives the whole input.
- Only files you name are uploaded; the JSON input is never scanned for paths.
  Every file is checked before the first upload: it must exist, be readable,
  non-empty, an image, video or audio file (png, jpg, webp, gif, mp4, mov,
  webm, mkv, wav, mp3, m4a, flac, ogg, ...) and at most `FAL_MAX_UPLOAD_MB`
  (default 1024). The same path given twice is uploaded once.
- To upload without running a model, use `fal upload`. stdout is JSON only:

```bash
multix fal upload ./shot.mp4
# {"url":"https://v3b.fal.media/files/...","mime_type":"video/mp4","size_bytes":70180,"file_name":"shot.mp4"}
```

:::caution[Uploaded files are public by link]
A fal storage URL can be opened by anyone who has it, and fal decides how long
the file is kept: multix cannot set an expiry or delete it. Do not upload media
you would not share. The upload uses the same flow as the official
`@fal-ai/client` (`rest.fal.ai` initiate, then a PUT to a pre-signed URL; files
above 90 MB go up in 10 MB parts). `FAL_KEY` goes only to `https://rest.fal.ai`;
the pre-signed upload URL never receives it and is never printed.
:::

## Detached jobs (submit, then resume)

`--detach` returns as soon as fal has queued the job, without polling, and
prints a receipt:

```bash
multix fal run fal-ai/mmaudio-v2 --input @mmaudio.json --file video_url=./shot-01.mp4 --detach
```

```json
{
  "provider": "fal",
  "model": "fal-ai/mmaudio-v2",
  "request_id": "01a173ff-f807-7733-87ed-013873a72fb8",
  "status": "IN_QUEUE",
  "submitted_at": "2026-10-25T16:58:37.444Z",
  "input_hash": "sha256:675b…",
  "status_command": "multix fal status fal-ai/mmaudio-v2 01a173ff-…",
  "result_command": "multix fal result fal-ai/mmaudio-v2 01a173ff-… --download",
  "receipt_path": "/home/you/.multix/fal/requests/01a173ff-….json"
}
```

Run the two commands later, from any shell, to check and collect the result.
They only read: they never submit the job again, so they cost nothing extra.
Submit several shots this way, then collect them one by one.

With `--detach` the receipt is saved in
`~/.multix/fal/requests/<request_id>.json`; `--receipt <path>` saves it there
instead, and also works without `--detach` so a run that is killed while
waiting can still be resumed. Without either flag `fal run` writes no file, and
the request id is printed on stderr as soon as fal accepts the job. The receipt
is written atomically with mode 0600 right after fal accepts the job. It holds
the ids, the status at submit time and a SHA-256 of the input, never the input,
its URLs or the key. multix does not delete old receipts.

If the submit fails in a way that does not prove fal rejected it (the
connection drops before fal answers, a 5xx gateway error, or a success answer
without a usable request id), multix cannot tell whether fal queued the job. It
stops with `UNKNOWN_REMOTE_STATE` (exit 6 with `--json`) instead of
resubmitting: check
[your fal requests](https://fal.ai/dashboard/requests) before you submit again.
fal has no idempotency key, so multix never retries a submit by itself.

## Images

```bash
multix fal image "a cyberpunk cat" \
  [-m <model>] [--image-size square_hd] [-n 1] [--seed <n>] \
  [--negative-prompt <text>] [--output <path>] [--no-download] [-v]
```

Default model is `fal-ai/flux/schnell` (override with `-m` or `FAL_IMAGE_MODEL`).

## Video

```bash
multix fal video "a dancer under neon lights" \
  [-m <model>] [--image-url <https-url>] [--duration <n>] \
  [--aspect-ratio 16:9] [--seed <n>] [--no-download] [--wait-timeout 900000] [-v]
```

Without `-m`, the default model depends on `--image-url`:

- Text-to-video: `fal-ai/kling-video/v1.6/standard/text-to-video` (override with `FAL_VIDEO_MODEL`).
- Image-to-video (`--image-url` set): `fal-ai/kling-video/v1.6/standard/image-to-video` (override with `FAL_VIDEO_IMAGE_MODEL`).

## Speech (text-to-speech)

`fal tts` maps typed flags onto each model's own input schema, then uses the
same queue flow as `run` (one submit that is never retried, receipts with
`--detach`, polling, download).

```bash
multix fal tts "Xin chào các bạn" --voice Puck --style "warm and slow"
multix fal tts --text-file script.txt -m google/gemini-3.8-flash-lite-tts
multix fal tts "Hello" -m elevenlabs/tts/eleven-v4-turbo --format pcm_16000 --language en
multix fal tts "Hello" -m elevenlabs/tts/eleven-v4 --format opus_48000_64 --detach
```

Verified models (`multix fal voices` lists them; `multix fal voices <model>`
prints the typed inputs as JSON):

| Model | Text field | Voice | Style | Language | Format | Output |
|---|---|---|---|---|---|---|
| `google/gemini-3.8-flash-tts` (default) | `prompt` | 30 named voices (default `Kore`) | `--style` | — | — | wav |
| `google/gemini-3.8-flash-lite-tts` (low latency) | `prompt` | same | `--style` | — | — | wav |
| `elevenlabs/tts/eleven-v4` | `text` (≤ 5000 chars) | any name or voice id (default `Rachel`) | — | `--language` | `--format` (`mp3_*`, `pcm_*`, `opus_*`, `ulaw_8000`, ...) | by format |
| `elevenlabs/tts/eleven-v4-turbo` (low latency) | same | same | — | `--language` | same | by format |

- Pass the text once: a positional, `--text` or `--text-file` (UTF-8, up to
  1 MB; a BOM and one trailing newline are removed). Blank text is refused.
- A flag the model has no field for (`--style` on ElevenLabs, `--format` on
  Gemini), a voice outside the model's list, or a format outside its enum fails
  with `INVALID_INPUT` before anything is sent. `--input` adds other fields
  (`stability`, `seed`, ...); a field set by both a flag and `--input` is an
  error. Values given through `--input` meet the same checks as the flags: text
  length (counted in characters), the voice list, the `output_format` enum and
  the language code (`en`, `vi`, `pt-BR`).
- Gemini multi-speaker dialogue goes through `--input` instead of the text:
  exactly two `speakers` with distinct `speaker_id`s and voices from the list,
  and one or more `turns`, each naming one of them with non-empty `text`.
  `--voice` and a text are refused with a dialogue. A malformed dialogue is
  refused before it is queued, so it costs nothing; fal currently rejects even
  a well-formed one with HTTP 422 after queueing it
  ([#310](https://github.com/mrgoonie/multix-cli/issues/310)).

  ```bash
  multix fal tts --input '{"speakers":[{"speaker_id":"A","voice":"Kore"},{"speaker_id":"B","voice":"Puck"}],"turns":[{"speaker_id":"A","text":"Hi!"},{"speaker_id":"B","text":"Hello."}]}'
  ```
- Set the default model with `FAL_TTS_MODEL`.
- Other fal TTS endpoints work when you name their fields:
  `multix fal tts "hi" -m <model> --text-field input [--voice-field speaker --voice anna]`.
  multix never guesses a schema. `multix fal voices --live` lists fal's live
  text-to-speech catalog (no key needed) and marks the unverified ones.

The audio is saved as `fal-<request_id>-01.<ext>`, with the extension taken
from the bytes: WAV, MP3, Ogg/Opus, FLAC, M4A, AAC, WebM and AIFF are
recognised by their header, whatever the URL or Content-Type says. Raw formats
with no header (`pcm_*` → `.pcm`, `ulaw_8000` → `.ulaw`, `alaw_8000` →
`.alaw`) are named from the requested format. An empty file, an error page, a WAV
with a header but no samples, or bytes that are not the container fal declared
are refused and no file is left
behind. `fal result <model> <id> --download` applies the same checks to a
speech job; for a raw format add `--format <fmt>` (a `--detach` receipt's
`result_command` already includes it), or the headerless bytes cannot be named.

## Status and result

Use these to resume a job started elsewhere, or after a `run`/`image`/`video`
command times out — the timeout error includes the request ID for exactly
this purpose.

```bash
multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download] [--output-dir <dir>] [--format <fmt>]
```

`status` prints fal's queue status (`IN_QUEUE`, `IN_PROGRESS` or `COMPLETED`)
as JSON. A failed job shows up as an error from `result`.

`<model>` only needs to resolve to the correct fal "app id" (its first two
path segments, e.g. `fal-ai/kling-video`); the full model id used for `run`,
`image`, and `video` also works here.

## Notes

- Auth header is `Authorization: Key <FAL_KEY>`; base URL is
  `https://queue.fal.run` (override with `FAL_BASE_URL`).
- Submission uses the full model id; the queue's status/result endpoints are
  keyed by the app id (owner/alias) instead.
- The key is sent to a `status_url` / `response_url` from the submit response
  only when it has the same origin (scheme, host and port) as `FAL_BASE_URL`,
  or is `https://queue.fal.run` on the default port. Any other URL fails with
  a provider error naming the host, before the key is sent. A submit response
  without these URLs also fails with a provider error.
- Polling is bounded by `--wait-timeout` (a wall-clock deadline, in
  milliseconds) and retries network errors, 408, 429 (waiting for `Retry-After`, never past the deadline)
  and 5xx responses other than 501 and 505, on the status poll and on the
  result fetch after the job completes. Each request's own timeout is the time
  left before the deadline (at least 10 seconds, at most 120). A timeout or
  unrecoverable error prints the request ID so you can resume with
  `multix fal status` or `multix fal result`.
- Media extraction prefers known result fields (`images[].url`, `video.url`,
  `image.url`, `audio.url`) before falling back to a generic scan of the
  result payload.
