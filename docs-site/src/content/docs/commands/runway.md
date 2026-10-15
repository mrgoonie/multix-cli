---
title: Runway commands
description: Generate Gen-4.5 and Gen-4 Turbo video and Gen-4 images through the Runway API, and check, resume or cancel tasks by ID.
---

Runway commands call the Runway API (`https://api.dev.runwayml.com`, API
version `2024-11-06`) and require `RUNWAYML_API_SECRET`, created in the
[Runway developer portal](https://dev.runwayml.com/). Only Runway's own Gen-4
family is supported. Other models served by the Runway API, video-to-video,
upscaling and audio are not covered, and an unknown model is rejected before
anything is sent; there is no model fallback.

## Video

```bash
# Text-to-video (Gen-4.5)
multix runway video "a lighthouse in a storm, slow push-in" \
  [-m gen4.5] [--ratio 1280:720] [--duration 5] [--seed <n>]

# Image-to-video: the image is the first frame (Gen-4.5 or Gen-4 Turbo)
multix runway video "the camera orbits the statue" --image ./statue.png
multix runway video -m gen4_turbo --image https://cdn.example.com/still.jpg

# Wait for the task, then download the MP4
multix runway video "waves at dusk" --wait [--wait-timeout <ms>] [--output clip.mp4]
```

| Model | Modes | Ratios (`--ratio`, default `1280:720`) | Prompt |
| --- | --- | --- | --- |
| `gen4.5` (default) | text-to-video, image-to-video | text: `1280:720`, `720:1280`; image adds `1104:832`, `832:1104`, `960:960`, `1584:672` | Required |
| `gen4_turbo` | image-to-video only | `1280:720`, `720:1280`, `1104:832`, `832:1104`, `960:960`, `1584:672` | Optional |

- `--duration` is a whole number of seconds from 2 to 10 (default 5).
- `--seed` is an integer from 0 to 4294967295.
- Prompts are at most 1000 characters.
- Override the default model with `-m` or `RUNWAY_VIDEO_MODEL`.

`runway video` does not wait by default. It prints the task ID with the
commands to check, resume and cancel it, then exits:

```text
Task submitted: <id>
  Check:  multix runway status <id>
  Resume: multix runway status <id> --wait --download
  Cancel: multix runway cancel <id>
```

`--wait` polls until the task finishes and downloads the video
(`--no-download` prints the output URL instead). `--output`, `--download` and
`--no-download` need `--wait`; without it, use `runway status <id> --wait
--download` later.

## Images

```bash
multix runway image "a ceramic teapot on a linen tablecloth, studio light" \
  [-m gen4_image] [--ratio 1920:1080] [--seed <n>] [--output <path>]

# Reference images, cited in the prompt by tag
multix runway image "@hero standing in @place at sunset" \
  --reference ./hero.png --reference-tag hero \
  --reference https://cdn.example.com/street.jpg --reference-tag place

# Gen-4 Image Turbo needs at least one reference
multix runway image "@subject as a watercolor" -m gen4_image_turbo \
  --reference ./subject.jpg --reference-tag subject
```

| Model | References | Override |
| --- | --- | --- |
| `gen4_image` (default) | 0 to 3 | `-m` or `RUNWAY_IMAGE_MODEL` |
| `gen4_image_turbo` | 1 to 3 | `-m` or `RUNWAY_IMAGE_MODEL` |

- `--ratio` (default `1280:720`) is one of `1024:1024`, `1080:1080`,
  `1168:880`, `1360:768`, `1440:1080`, `1080:1440`, `1808:768`, `1920:1080`,
  `1080:1920`, `2112:912`, `1280:720`, `720:1280`, `720:720`, `960:720`,
  `720:960`, `1680:720`.
- `--reference` repeats up to three times. `--reference-tag` repeats too and
  pairs with the reference at the same position; a tag is 3 to 16 letters,
  digits or underscores and starts with a letter. Cite it in the prompt as
  `@tag`.
- `runway image` waits and downloads by default. `--async` returns the task ID
  immediately and cannot be combined with `--output` or `--download`.
- Saved images are converted to WebP like the other image commands; keep the
  original format with `--image-format original`, `--no-webp`,
  `MULTIX_IMAGE_FORMAT=original`, or an `--output` with a non-`.webp`
  extension.

## Tasks: status, resume and cancel

```bash
multix runway status <id>                      # one-shot JSON summary
multix runway status <id> --wait --download    # resume without creating a new task
multix runway cancel <id>                      # cancel a pending or running task
multix runway cancel <id> --delete             # delete a finished task and its outputs
```

- `status` prints the task ID, status, progress, `estimatedCost`, `cost`,
  `failure` and `failureCode` when present, and output URLs without their
  signed query strings. It never prints the prompt or inputs.
- Terminal statuses are `SUCCEEDED`, `FAILED` and `CANCELLED`. `FAILED` and
  `CANCELLED` exit non-zero; a one-shot `status` on a running task exits 0 and
  prints the resume command.
- `cancel` refuses a task that already finished unless you pass `--delete`,
  because deleting a finished task also removes its outputs.
- `--wait-timeout <ms>` bounds polling (defaults: video and `status` 15 min,
  image 5 min). A timeout prints the resume command; the task keeps running.
  Tasks are polled every 5 seconds or more, as Runway asks.

## Inputs

`--image` and `--reference` accept:

- a public `https://` URL with a domain name (no IP address or `localhost`),
  at most 2048 characters. Runway fetches it itself and does not follow
  redirects;
- a `data:image/jpeg`, `data:image/png` or `data:image/webp` URI up to 5 MB;
- a `runway://` URI from an earlier upload;
- a local `.jpg`, `.jpeg`, `.png` or `.webp` file. It is sent inline as a data
  URI when the encoded form fits in 5 MB, otherwise uploaded to Runway as an
  ephemeral upload (valid 24 hours, under 200 MB).

GIF and other formats are rejected.

## Outputs

- Files are saved as `runway-<id8>-NN.<ext>` in `MULTIX_OUTPUT_DIR` (default
  `./multix-output`), where `<id8>` is the first 8 characters of the task ID.
- `--output <file>` saves a single output to that path (several outputs
  become `<file>-NN.<ext>`); `--output <dir>/` saves into a directory.
- Runway output URLs expire within 24 to 48 hours, so download promptly.
- Downloads use `https://` only, refuse `localhost` and private or loopback
  addresses (every redirect is checked too), stop at `MULTIX_MAX_DOWNLOAD_MB`
  (default 2048 MB), and are written to a `.part` file that is renamed when
  complete.
- If any output fails to download, the files that did download are kept, but
  the command exits non-zero and prints
  `multix runway status <id> --download` to retry while the URLs are live.

## Cost and retries

Runway bills in credits (1 credit = $0.01). Before submitting, the CLI logs an
indicative list-price estimate: Gen-4.5 12 credits per second, Gen-4 Turbo 5
credits per second, Gen-4 Image from 5 credits, Gen-4 Image Turbo 2 credits.
Prices change; [Runway's pricing page](https://docs.dev.runwayml.com/guides/pricing/)
is authoritative. After the task is created the CLI logs Runway's own
`estimatedCost`, and when it finishes, the billed `cost`.

Creating a task is retried only on `429` (rate limit), when nothing was
created. If creating fails with a network error, timeout, 5xx response or an
unreadable success response, the task may still have been created and billed.
Runway has no idempotency key, so check your tasks and usage in the
[developer portal](https://dev.runwayml.com/) before retrying.

## Errors and privacy

- 401 points at `RUNWAYML_API_SECRET`, 402 at missing credits, and 404 at the
  model or task (which may belong to another organization, or have been
  canceled or deleted).
- The API secret is never logged, and log lines never carry signed output
  URLs.
- `RUNWAY_BASE_URL` overrides the API root for mocks or proxies and follows the
  same trust rules as the other `*_BASE_URL` settings; see
  [Base URL overrides and trust](/reference/environment/#base-url-overrides-and-trust).
