---
title: fal.ai commands
description: Run any fal.ai queue model, upload local media, queue jobs without waiting, or use the image/video convenience commands.
---

fal.ai commands require `FAL_KEY`. `run` works with any fal model id;
`image` and `video` set sensible defaults and download media automatically.

```bash
multix fal run fal-ai/flux/schnell --input '{"prompt":"a cyberpunk cat"}'
multix fal run fal-ai/flux/schnell --input @input.json
```

`--input` accepts inline JSON or `@path/to/file.json`. By default the command
polls to completion and downloads any media URLs found in the result;
`--no-download` prints the result JSON instead.

## Local files

Models take media as URLs (`video_url`, `image_url`, `audio_url`, ...).
`--file field=path` uploads a local file to fal storage (the same upload flow
as the official `@fal-ai/client`) and puts the returned URL at `field` in the
input. It works on `run` and `submit`, can be repeated, and takes a dotted
path for nested fields (`refs.0.image_url`). A value that is already an
`http(s)://` URL or a `data:` URI is used as given. Only files you name are
uploaded; the JSON input is never scanned for paths.

```bash
multix fal run fal-ai/mmaudio-v2 \
  --input '{"prompt":"rain on a tin roof","duration":8}' \
  --file video_url=./shot.mp4
```

To get a URL by itself (JSON on stdout, progress on stderr):

```bash
multix fal upload ./shot.mp4 [--expires-in 1d]
# {"url":"https://v3.fal.media/files/...","file_name":"shot.mp4","mime_type":"video/mp4","size_bytes":1234}
```

- Anyone with the returned URL can read the file. fal keeps it for its own
  default retention unless `--expires-in` asks for deletion after `1h`, `1d`,
  `7d`, `30d`, `1y` or a number of seconds; multix does not delete uploads.
  Do not upload media you may not share with fal.
- Files must be readable, non-empty and at most 2 GiB. They are streamed from
  disk, never loaded whole; files over 90 MB go up in 10 MB parts. The content
  type comes from the extension (`application/octet-stream` when unknown).
- The key goes only to `https://rest.fal.ai` to start the upload; the bytes go
  to the signed upload URL fal returns, without the key. Signed URLs are never
  printed. Network errors and 5xx/429 responses are retried up to 3 times.
- Every path and field is checked before the first upload, so a typo fails
  before any file leaves the machine. A numeric segment under a missing field
  creates a list (`refs.0.image_url` gives `{"refs":[{"image_url":…}]}`).

## Queue without waiting

`submit` takes the same `--input` / `--file` flags, returns as soon as fal
accepts the job and prints a JSON receipt:

```bash
multix fal submit fal-ai/hunyuan-video-foley \
  --input @foley.json --file video_url=./shot.mp4 [--receipt ./shot.job.json]
```

```json
{
  "schema": "multix.fal.job/v1",
  "provider": "fal",
  "model": "fal-ai/hunyuan-video-foley",
  "request_id": "...",
  "status": "IN_QUEUE",
  "submitted_at": "2026-10-25T16:00:00.000Z",
  "input_hash": "sha256:...",
  "status_url": "https://queue.fal.run/...",
  "response_url": "https://queue.fal.run/...",
  "uploaded_fields": ["video_url"],
  "receipt_path": "/home/me/.multix/fal-jobs/<request_id>.json"
}
```

The receipt is saved before it is printed, in `~/.multix/fal-jobs/` (override
with `MULTIX_FAL_JOBS_DIR`), with mode 0600. It holds no key and no input,
only a hash of the input. `run` saves the same receipt right after its submit,
so a run that is killed or times out can also be collected later.
`multix fal jobs [--limit 20]` lists saved receipts, newest first.

Submitting is never retried. When the submit gets no usable answer (the
connection fails, a timeout, a 5xx from fal or its gateway, or a success
response without a request id), the command fails with `unknown_remote_state`
(error code `UNKNOWN_REMOTE_STATE`, not retryable): fal may have queued and
billed the job, so check [your fal requests](https://fal.ai/dashboard/requests)
before submitting again.

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

## Status and result

Use these to collect a `submit`ted job, to resume a job started elsewhere, or
after a `run`/`image`/`video` command times out — the timeout error includes
the request ID for exactly this purpose. They never submit anything, so they
are safe to repeat.

```bash
multix fal status [<model>] <requestId>
multix fal result [<model>] <requestId> [--download] [--output-dir <dir>]
```

The model can be left out when a receipt for the request was saved on this
machine (in the remote MCP runner each job starts empty, so pass the model
there). `status`
reports fal's queue status (`IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`); `result`
fails while the job is still running. Both update the saved receipt.

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
  result payload.
