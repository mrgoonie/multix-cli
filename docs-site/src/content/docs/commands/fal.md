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
polls to completion and downloads any media URLs found in the result;
`--no-download` prints the result JSON instead.

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

Use these to resume a job started elsewhere, or after a `run`/`image`/`video`
command times out — the timeout error includes the request ID for exactly
this purpose.

```bash
multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download]
```

`<model>` only needs to resolve to the correct fal "app id" (its first two
path segments, e.g. `fal-ai/kling-video`); the full model id used for `run`,
`image`, and `video` also works here.

## Notes

- Auth header is `Authorization: Key <FAL_KEY>`; base URL is
  `https://queue.fal.run` (override with `FAL_BASE_URL`).
- Submission uses the full model id; the queue's status/result endpoints are
  keyed by the app id (owner/alias) instead.
- Polling is bounded by `--wait-timeout` (a wall-clock deadline, in
  milliseconds) and retries transient network/5xx errors. A timeout or
  unrecoverable error prints the request ID so you can resume with
  `multix fal status` or `multix fal result`.
- Media extraction prefers known result fields (`images[].url`, `video.url`,
  `image.url`, `audio.url`) before falling back to a generic scan of the
  result payload.
