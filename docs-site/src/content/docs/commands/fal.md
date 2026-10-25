---
title: fal.ai commands
description: Run any fal.ai queue model, or use the image/video convenience commands with sensible defaults.
---

fal.ai commands require `FAL_KEY`. `run` works with any fal model id;
`image` and `video` set sensible defaults and download media automatically.

```bash
multix fal run fal-ai/flux/schnell --input '{"prompt":"a cyberpunk cat"}'
multix fal run fal-ai/flux/schnell --input @input.json
```

`--input` accepts inline JSON or `@path/to/file.json`. By default the command
polls to completion and downloads any media URLs found in the result to
`MULTIX_OUTPUT_DIR` (or `--output-dir <dir>`); `--no-download` prints the
result JSON instead.

## Local files

`run --file key=path` sets the top-level input field `key` to a file. A local
path is checked (exists, readable, not empty) and uploaded to fal storage, and
the field gets the hosted URL; an `http(s)` URL or `data:` URI is passed through
unchanged. The flag is repeatable (once per key), and it overrides the same
key in `--input`. Nothing is uploaded unless you name it with `--file`.
With `--dry-run`, the request shown is the free upload initiate call, not the
model submit: nothing is uploaded or queued.

```bash
# Add audio to a silent clip with MMAudio
multix fal run fal-ai/mmaudio-v2 \
  --input '{"prompt":"rain on a tin roof","duration":2}' \
  --file video_url=./shot.mp4

# Foley for a clip with Hunyuan Video Foley
multix fal run fal-ai/hunyuan-video-foley \
  --input '{"text_prompt":"footsteps on gravel"}' \
  --file video_url=./shot.mp4
```

## Upload

```bash
multix fal upload <file> [--content-type <mime>] [--expires-in <ttl>] [-v]
```

Uploads one local file and prints JSON on stdout (logs go to stderr):
`url`, `file_name`, `mime_type`, `size_bytes`, plus `expires_in_s` when
`--expires-in` is set. Use the `url` in any fal input field such as
`video_url` or `image_url`.

- `--content-type` overrides the MIME type guessed from the file extension
  (a MIME type such as `video/mp4`, optionally with parameters).
- `--expires-in` asks fal to delete the file after `1h`, `1d`, `7d`, `30d`,
  `1y`, or a number of seconds; `never` sends no expiry. Without it, fal's
  default retention applies. multix never deletes uploaded files itself.

**Privacy:** a fal storage URL is readable by anyone who has it. Upload only
files you are willing to share that way, and treat the URL like the file.

Uploads (from `upload` and `--file`) always go to `https://rest.fal.ai`, which
receives `FAL_KEY` to start the upload; the bytes go to the signed upload URL
it returns, without the key, and redirects there are refused. Files over 90 MB
are sent in 10 MB parts. Network errors, stalled transfers (each attempt is
limited to 2 minutes plus 1 second per 64 KB) and 5xx responses (other than
501 and 505) are retried, up to 3 attempts per request. Uploads do not use
`FAL_BASE_URL`.

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

## Detached runs and receipts

```bash
multix fal run <model> --input <json> [--file key=path] --detach [--receipt <path>]
```

`--detach` returns as soon as the queue accepts the job. stdout is a JSON
receipt (schema `multix.fal-receipt/v1`) with the model, `request_id`, status,
queue position, submit time, an `input_hash` (sha256 of the input as
submitted; with `--file`, each run uploads afresh, so the hash differs) and
the `next` status/result commands. It never holds
the key, the input, or signed URLs.

The receipt is saved to `~/.multix/fal/requests/<request_id>.json` (directory
0700, file 0600, written atomically), or to `--receipt <path>`. The job is
already queued and billed at that point, so if saving fails the receipt is
still printed, with a warning: keep the `request_id`. `--receipt` needs
`--detach`; `--output-dir` and `--no-download` belong to `fal result`.

## Status and result

Use these to resume a detached job, a job started elsewhere, or a
`run`/`image`/`video` command that timed out — the timeout error includes the
request ID for exactly this purpose.

```bash
multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download] [--output-dir <dir>]
```

`result` only reads: it never submits the job again. If the job is still
queued or running, it fails with `JOB_PENDING` and the queue status; check
again with `status`.

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
- fal has no idempotency key, so multix cannot promise a job runs exactly
  once. If a submit gets no HTTP response (other than a DNS failure or a
  refused connection), a 5xx, or an answer without a request id, the job may
  exist and be billed: the command fails
  with `UNKNOWN_REMOTE_STATE`. Check your
  [fal request list](https://fal.ai/dashboard/requests) before submitting
  again.
- Media extraction prefers known result fields (`images[].url`, `video.url`,
  `image.url`, `audio.url`) before falling back to a generic scan of the
  result payload.
