---
title: Replicate commands
description: Run any Replicate model through the direct API, generate images and video, and resume or cancel predictions by ID.
---

Replicate commands call the direct Replicate API (`https://api.replicate.com/v1`)
and require `REPLICATE_API_TOKEN` (`REPLICATE_API_KEY` is accepted as a
fallback). They are independent of `multix cloudflare generate-video`, which
reaches Replicate through Cloudflare AI Gateway.

## Run any model

```bash
# Official model (owner/name) — uses the model's predictions endpoint
multix replicate run black-forest-labs/flux-schnell --input '{"prompt":"a cyberpunk cat"}'

# Community model pinned to a version — uses POST /predictions with that version
multix replicate run owner/model:<version-id> --input @payload.json
multix replicate run owner/model --version <version-id> --input @payload.json

# Attach local files to model inputs (repeatable)
multix replicate run owner/model --input '{"prompt":"..."}' --file image=./photo.png
```

`--input` accepts inline JSON or `@path/to/file.json` and is sent unchanged,
so every model's own input schema works. Official models run without a
version; community models need `owner/name:version`, a bare version ID, or
`--version`.

## Images and video

```bash
multix replicate image "a futuristic city at dusk" \
  [-m <owner/name>] [--aspect-ratio 16:9] [-n 1] [--seed <n>] \
  [--output-format webp|jpg|png] [--input '{"go_fast":false}'] [--output <path>]

multix replicate video "a cinematic establishing shot" \
  [-m <owner/name>] [--image <path|url>] [--duration 5] [--aspect-ratio 16:9] \
  [--resolution 720p] [--seed <n>] [--input '{"draft":true}'] [--async]
```

| Command | Default model | Override |
| --- | --- | --- |
| `image` | `black-forest-labs/flux-schnell` | `-m` or `REPLICATE_IMAGE_MODEL` |
| `video` | `prunaai/p-video` (text-to-video, or image-to-video with `--image`) | `-m` or `REPLICATE_VIDEO_MODEL` |

Wrapper flags map to common input names (`prompt`, `aspect_ratio`,
`num_outputs`, `seed`, `output_format`, `duration`, `resolution`, `image`).
Use `--input` for any other field, `--image-key` when a model names its image
input differently, or `replicate run` for a fully custom schema.

`replicate image` converts saved images to WebP by default (`cwebp -q 85`).
The provider's original format is kept when you pass `--image-format original`
or `--no-webp`, set `MULTIX_IMAGE_FORMAT=original`, pass an explicit
`--output-format`, or give `--output` a non-`.webp` image extension (for
example `cat.png`). If `cwebp` is not on `PATH`, or a conversion fails
verification, the original file is kept with a warning. `replicate run` and
`replicate video` never convert.

## Async jobs: resume and cancel

Every run waits by default: submit, poll with back-off until a terminal status,
then download. `--async` prints the prediction ID and returns immediately.

```bash
multix replicate video "a slow pan over mountains" --async
# Prediction submitted: <id> (status: starting)

multix replicate status <id>                       # one-shot status (JSON)
multix replicate status <id> --wait --download     # resume without re-running
multix replicate cancel <id>
```

- Terminal statuses are `succeeded`, `failed`, `canceled`, and `aborted`.
  Only `succeeded` exits 0; the others exit non-zero with Replicate's error.
  A one-shot `status <id>` on a job that is still running exits 0.
- If any output file fails to download, the files that did download are kept,
  but the command exits non-zero and prints
  `multix replicate status <id> --download` to retry while the URLs are live.
- `--wait-timeout <ms>` bounds polling (defaults: run 10 min, image 5 min,
  video 15 min). A timeout prints the resume command; the job keeps running.
- `--prefer-wait <seconds>` sends `Prefer: wait=N` (an integer from 1 to 60)
  so short jobs can finish in the create request; if the job is still running,
  polling continues. The value is required, so
  `multix replicate image --prefer-wait "a cat"` is rejected rather than
  treating the prompt as the value.
- If submitting fails with a network error, timeout, or 5xx response, the
  prediction may still have been created, and it is billed while it runs.
  Replicate has no idempotency key, so check
  [your predictions](https://replicate.com/predictions) before retrying.

## Outputs

- Outputs may be a URL, a list of URLs, nested objects, or text. Every media
  URL is downloaded; text values are printed.
- Files are saved as `replicate-<id8>-NN.<ext>` in `MULTIX_OUTPUT_DIR`
  (default `./multix-output`), where `<id8>` is the first 8 characters of the
  prediction ID. The extension comes from the URL or the
  response content type.
- `--output <file>` saves a single output to that path (multiple outputs
  become `<file>-NN.<ext>`); `--output <dir>/` saves into a directory.
- `--no-download` prints the output URLs instead. Replicate output URLs
  expire (about an hour for API predictions), so download promptly.
- Downloads use `https://` only. URLs that point to `localhost` or to a
  loopback, private, link-local, or unspecified IP address are refused, and
  every redirect is checked the same way. Hosts other than
  `replicate.delivery` (for example a proxy behind `REPLICATE_BASE_URL`) are
  downloaded with a warning that names only the host.
- Each file is capped at `MULTIX_MAX_DOWNLOAD_MB` (default 2048 MB); a larger
  download is stopped and the partial file removed.

## Local files

`--image` and `--file key=path` accept a local path or an `https://` URL.
Local files up to 256 KB are sent inline as data URIs; larger files are
uploaded through the Replicate Files API. Files must be under 100 MB.

## Errors and privacy

- 401 points at the token, 404 at the model (or a missing version for
  community models), 422 at the model's input schema, and 429 honours
  `Retry-After`; network, 429, and 5xx errors are retried while polling.
- The token is never logged. `status` JSON omits prediction inputs and logs
  and strips signed query strings from output URLs; verbose logs redact them
  too.
