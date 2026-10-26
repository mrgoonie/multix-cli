---
title: fal.ai commands
description: Run any fal.ai queue model with local files and detached jobs, use the image/video/text-to-speech convenience commands, or look up fal model ids.
---

fal.ai commands require `FAL_KEY`. `run` works with any fal model id;
`image`, `video` and `tts` set sensible defaults and download media
automatically, and `models` lists fal endpoint ids.

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

## Text-to-speech

```bash
multix fal tts "Hello from multix" \
  [-m <model>] [--text-file <path>] [--voice <name>] [--style <text>] \
  [--format <fmt>] [--language <code>] [--input <json|@file>] \
  [--detach] [--receipt <path>] [--no-download] [--output-dir <dir>] [-v]
```

fal's TTS endpoints do not share one input schema, so `tts` maps its flags onto
each endpoint's own fields and checks them before anything is queued (fal
accepts a malformed job and only fails it at result time, after billing):

| Model (`-m`) | Text field | `--voice` | `--style` | `--format` / `--language` | Returns |
|---|---|---|---|---|---|
| `google/gemini-3.8-flash-tts` (default), `google/gemini-3.8-flash-lite-tts` | `prompt` | one of 30 prebuilt voices (default `Kore`) | `style_instructions` | not supported | WAV |
| `elevenlabs/tts/eleven-v4`, `elevenlabs/tts/eleven-v4-turbo` | `text` (max 5000 chars) | any voice name or id (default `Rachel`) | not supported: use audio tags such as `[whispering]` in the text | `output_format` (default `mp3_44100_128`; `pcm_*`, `ulaw_8000`, `opus_*`, ...) / `language_code` | MP3 (or the chosen format) |

- Pass the text as the argument or with `--text-file` (UTF-8, up to 1 MB), not
  both. Gemini dialogue goes in `--input`, e.g.
  `--input '{"speakers":[...],"turns":[...]}'`, with no text argument:
  exactly two speakers, each with one of the 30 voices, and turns naming them.
  As of 2026-10-26, fal queues such a dialogue and then rejects it with HTTP
  422, so `tts` warns before submitting
  ([#310](https://github.com/mrgoonie/multix-cli/issues/310)).
- A flag the endpoint has no field for (for example `--format` on Gemini), an
  unknown voice or format, text over the limit, or a field set both by a flag
  and by `--input` fails with a validation error, and nothing is submitted.
- Any other fal TTS id runs untyped, with a warning: the text goes to
  `--text-field` (default `text`), `--voice` to `voice`, and every other field
  comes from `--input`. Check the model's schema on its fal page.
- The default model can be changed with `FAL_TTS_MODEL`.
- Audio is saved as `fal-<request_id>-NN.<ext>`, with the extension taken from
  the bytes (a WAV served as `audio.mp3` or from a URL without an extension is
  saved as `.wav`). Raw formats with no header (`.pcm`, `.ulaw`, `.alaw`) keep
  the name fal declared. An empty file, or a text, HTML or JSON body, is
  refused and removed, and the command fails with a
  `multix fal result <model> <request_id> --download` hint.
- `--detach`, `--receipt`, `UNKNOWN_REMOTE_STATE` and resuming with
  `status`/`result` work exactly as for `run`. The receipt holds ids and an
  input hash, never the text.

## Finding models

```bash
multix fal models --typed [--json]                       # offline: the TTS endpoints tts validates
multix fal models --category text-to-speech [--json]     # live catalog
multix fal models --query "gemini tts" [--limit 50] [--json]
```

The live list comes from fal's public catalog (`https://api.fal.ai/v1/models`).
It needs no key, and `FAL_KEY` is never sent to it. Rows `tts` knows field by
field are marked `typed`. `multix models --task speech --provider fal --json`
shows the same command for agents, with its inputs, `output: audio` and
`async: true`.

## Status and result

Use these to resume a job started elsewhere, or after a `run`/`image`/`video`
command times out — the timeout error includes the request ID for exactly
this purpose.

```bash
multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download] [--output-dir <dir>]
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
  milliseconds) and retries transient network errors and 5xx responses other than 501 and 505. A timeout or
  unrecoverable error prints the request ID so you can resume with
  `multix fal status` or `multix fal result`.
- Media extraction prefers known result fields (`images[].url`, `video.url`,
  `image.url`, `audio.url`) before falling back to a generic scan of the
  result payload. Each file is named by what its bytes are, then by the
  `content_type` / `file_name` fal returned, the URL, and the download's
  `Content-Type`, in that order.
