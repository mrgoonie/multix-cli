---
title: Runway commands
description: Generate Gen-4.5 video and Gen-4 images with the Runway API, and check, resume, or cancel tasks by ID.
---

Runway commands call the Runway Dev API (`https://api.dev.runwayml.com`) and
require `RUNWAYML_API_SECRET`, created at
[dev.runwayml.com](https://dev.runwayml.com/). Runway bills in credits
($0.01 each).

Only Runway's own Gen-4 models are supported. An unknown model ID is refused
before any paid request is sent. `multix runway models` lists the supported
models, ratios, durations, and reference-image limits without calling the API
or needing a key:

```bash
multix runway models          # or --json
```

| Command | Default model | Override |
| --- | --- | --- |
| `video` | `gen4.5` (text-to-video, or image-to-video with `--image`); `gen4_turbo` is image-to-video only | `-m` or `RUNWAY_VIDEO_MODEL` |
| `image` | `gen4_image` (0–3 references); `gen4_image_turbo` needs 1–3 references | `-m` or `RUNWAY_IMAGE_MODEL` |

## Video

```bash
# Text-to-video (gen4.5)
multix runway video "a slow dolly shot through a neon market at night"

# Image-to-video: the image is the first frame
multix runway video "the camera pushes in" --image ./frame.png --ratio 960:960

multix runway video "<prompt>" [-m gen4.5|gen4_turbo] [--image <path|url>] \
  [--duration 5] [--ratio 1280:720] [--seed <n>] \
  [--public-figure-threshold auto|low] [--wait] [--no-download] [--json]
```

- Text-to-video accepts `1280:720` and `720:1280`. Image-to-video also
  accepts `1104:832`, `832:1104`, `960:960`, and `1584:672`.
- `--duration` is a whole number of seconds from 2 to 10 (default 5).
- A prompt is required, except for `gen4_turbo` image-to-video.

Video is billed per second, so `runway video` does not wait by default. It
submits the task and prints its ID together with the commands to check,
resume, and cancel it. `--wait` (or `--download`) polls until the task
finishes and saves the video.

## Image

```bash
multix runway image "a ceramic teapot on a linen tablecloth" --ratio 1024:1024

# Reference images: tag=path lets the prompt mention the image as @tag
multix runway image "@hero standing in @place at golden hour" \
  --ref hero=./person.png --ref place=https://example.com/street.jpg

multix runway image "<prompt>" [-m gen4_image|gen4_image_turbo] [--ratio 1280:720] \
  [--ref [tag=]<path|url>]... [--seed <n>] [--public-figure-threshold auto|low] \
  [--async] [--image-format webp|original] [--no-webp] [--output <path>] [--json]
```

- `--ref` repeats up to three times. A tag has 3–16 letters, digits, or
  underscores and starts with a letter.
- `--ratio` accepts the 16 output sizes listed by `multix runway models`.
- Images wait and download by default; `--async` submits and prints the task
  ID instead.
- Saved images are converted to WebP the same way as other image commands.
  `--image-format original`, `--no-webp`, `MULTIX_IMAGE_FORMAT=original`, or a
  non-`.webp` `--output` extension keeps Runway's format.

## Image inputs

`--image` and `--ref` accept a local file, an `https://` URL, a `data:` URI,
or a `runway://` URI from an earlier upload.

- Local JPEG, PNG, or WebP files are sent inline when the data URI fits in
  5 MB. Larger files, up to 200 MB, are uploaded to Runway's ephemeral
  storage, which keeps them for 24 hours.
- URLs must use `https://` with a public domain name (not an IP address or a
  local host) and be at most 2048 characters, because Runway fetches them
  itself. `http://` is refused.

## Tasks: status, resume, and cancel

```bash
multix runway video "a slow pan over mountains"
# Task submitted: <id>
#   Estimated cost: up to … credits (≈ $…); the final billed amount may be lower

multix runway status <id>                      # one-shot status (JSON)
multix runway status <id> --wait --download    # resume without paying again
multix runway status <id> --download           # fresh download of a finished task
multix runway cancel <id>                      # pending or running tasks only
multix runway cancel <id> --delete             # also delete a finished task and its outputs
```

- Creating a task prints Runway's estimated maximum cost; a finished download
  prints the credits charged.
- Polling waits at least 5 seconds between reads, as Runway asks.
  `--wait-timeout <ms>` bounds it (defaults: video and status 15 min, image
  5 min). A timeout prints the resume command; the task keeps running.
- `FAILED` and `CANCELLED` tasks exit non-zero with Runway's failure reason.
  A one-shot `status` on a running task exits 0.
- `cancel` refuses a finished task unless you pass `--delete`, because the
  same Runway endpoint deletes finished tasks and their outputs.
- Creates are retried only on 429. If submitting fails with a network error,
  timeout, 5xx, or an unreadable response, the task may still have been created
  and billed (Runway has no idempotency key), so check the
  [developer portal](https://dev.runwayml.com/) before retrying.

## Outputs

- Files are saved as `runway-<id8>-NN.<ext>` in `MULTIX_OUTPUT_DIR` (default
  `./multix-output`). `--output <file>` saves a single output to that path;
  `--output <dir>/` saves into a directory.
- Output URLs are signed and expire after 24–48 hours. Each `status` read gets
  fresh ones, so `multix runway status <id> --download` recovers a failed or
  late download. `--no-download` prints the signed URLs instead of saving.
- Downloads follow the same policy as other providers: `https://` only, no
  local or private addresses (checked on every redirect), at most
  `MULTIX_MAX_DOWNLOAD_MB` per file, and written through a `.part` file. Text,
  HTML, and JSON bodies are refused as error pages.
- `--json` prints a summary on stdout. Status JSON strips the signed query
  strings from output URLs; the secret is never logged.

## Remote MCP server

On the [remote MCP server](/guides/mcp-server/), the `runway` group uses the
`RUNWAYML_API_SECRET` saved in the dashboard. `runway video --image` and
`runway image --ref` take files through `inputs`; remote references cannot
carry a `tag=` prefix. Video duration is capped by the server's video limit.
Set the `wait` option on `runway video` if the job should return the video
rather than only the task ID.
