---
title: ToAPIs commands
description: Generate images and video through the ToAPIs aggregator (Seedance, Veo, Kling, Wan, gpt-image, Gemini image, Seedream, Flux and more) on one key, get ToAPIs' price quote, resume tasks and upload reference files.
---

ToAPIs commands call the [ToAPIs](https://toapis.com) API (`https://toapis.com`)
and require `TOAPIS_API_KEY`, created in the
[ToAPIs dashboard](https://toapis.com/dashboard/tokens). One key and one
balance reach image and video models from many vendors.

ToAPIs is a reseller (aggregator), not the model vendor. Its prices are its
own and can sit far below the vendor's list price. The cheapest image and Veo
variants (model IDs with `preview` or `vip` and similar names) likely come
through unofficial channels, so they may be less stable or be withdrawn.
Choose the model with that in mind.

| Variable | Purpose |
| --- | --- |
| `TOAPIS_API_KEY` | API key (required for every command except `quote`). |
| `TOAPIS_IMAGE_MODEL` | Default model for `toapis image` (default `doubao-seedream-4-5`). |
| `TOAPIS_VIDEO_MODEL` | Default model for `toapis video` (default `seedance-2-fast`). |
| `TOAPIS_BASE_URL` | API root override for mocks or proxies; see [Base URL overrides and trust](/reference/environment/#base-url-overrides-and-trust). |

## Models and quotes

```bash
multix toapis models                       # image, video and audio models this key can use (live)
multix toapis models --type video          # one type: image, video, audio or all
multix toapis quote -m seedance-2-fast --resolution 720p --duration 5
multix toapis quote -m gpt-image-2 --resolution 2K -n 2
```

- `models` lists the model IDs your key can use, live from ToAPIs.
  Prices are on the [ToAPIs pricing page](https://toapis.com/pricing).
- `quote` asks the public price endpoint behind the pricing page. It needs no
  key and charges nothing. It prints the list price and charge type, and an
  estimated total when the duration or image count is known. For token-billed
  models it also prints ToAPIs' per-second estimate. This endpoint is not in
  ToAPIs' API docs, so it may change without notice.

## Images

```bash
multix toapis image "a ceramic teapot on linen, studio light" \
  [-m doubao-seedream-4-5] [--aspect-ratio 16:9] [--resolution 2K] [-n 2] [--seed 7]

# Edit or reference: local files are uploaded first
multix toapis image "make it a watercolor" -m gpt-image-2 --image ./photo.png
```

## Video

```bash
# Text-to-video
multix toapis video "waves at dusk, slow pan" \
  [-m seedance-2-fast] [--duration 5] [--resolution 720p] [--aspect-ratio 16:9] [--audio | --no-audio]

# Image-to-video: first frame, optional last frame
multix toapis video "the camera orbits the statue" --first-frame ./first.png [--last-frame ./last.png]

# Reference images
multix toapis video "the product spins on a turntable" --image ./ref1.png --image ./ref2.png
```

- ToAPIs keeps each vendor's own request fields, so the same flag lands in a
  different field per model family. multix maps `--aspect-ratio`,
  `--resolution`, `--duration`, `--audio`, `--negative` and the image flags for
  you (for example `--resolution 1080p` becomes Kling's `pro` mode).
- `--param key=value` sends any other field as-is (repeatable; dotted keys
  nest, such as `metadata.watermark=false`; JSON values such as numbers and
  booleans are parsed). It is applied last and can override a mapped field,
  except the priced fields (`model`, `prompt`, `n`, `duration`, `seconds`,
  `resolution`, `mode`, `metadata.resolution`), which are refused so the cost
  estimate matches the run: use the matching flag.
- Seedance 2.x takes first/last frames or reference images, not both in one
  request.
- Which values a model accepts (durations, resolutions, counts) is up to
  ToAPIs and the model; check the model's page in the
  [ToAPIs docs](https://docs.toapis.com).

## Tasks, waiting and resume

Every generation is an async ToAPIs task. By default `image` and `video` wait
for it (`--wait-timeout`, default 5 min for images and 15 min for video) and
download the outputs. `--async` submits, prints the task ID, and exits.

```bash
multix toapis video "a lighthouse in a storm" --async
multix toapis status <taskId>                      # one-shot status (video by default)
multix toapis status <taskId> --kind image --wait  # wait, then download
```

`status` needs `--kind image` for an image task. A wait that times out prints
the `status ... --wait` command to resume; the task keeps running.

## Inputs and uploads

`--image`, `--first-frame` and `--last-frame` accept a public `http(s)://` URL
(passed through) or a local file. ToAPIs takes no base64 or `data:` URIs, so a
local file is uploaded to ToAPIs first and sent as the returned public URL.

```bash
multix toapis upload ./photo.png      # prints the public URL
```

Only media files are uploaded: images (`.jpg`, `.jpeg`, `.png`, `.webp`,
`.gif`, up to 30 MB), video (`.mp4`, `.webm`, `.mov`, up to 50 MB) and audio
(`.mp3`, `.wav`, `.m4a`, up to 50 MB). Anything else is refused before it
leaves the machine. An uploaded file is reachable by anyone with its URL.

## Outputs

- ToAPIs keeps outputs for 30 days, so multix downloads them as soon as the
  task finishes. `--no-download` prints the output URLs instead.
- Files are saved as `toapis-<kind>-<id8>-<stamp>.<ext>` in `MULTIX_OUTPUT_DIR`
  (default `./multix-output`). `--output <file>` saves a single output to that
  path; otherwise `--output` is a directory.
- The run prints the task ID and its settled cost.

## Costs

```bash
multix toapis video "waves" -m seedance-2-mini --resolution 480p --duration 4 --estimate
multix toapis image "a fox" -m gpt-image-2 --resolution 1K --max-cost 0.05
```

- `--estimate` and `--max-cost` price the run offline from ToAPIs list prices
  that multix records with their check date
  ([`src/providers/toapis/cost.ts`](https://github.com/mrgoonie/multix-cli/blob/main/src/providers/toapis/cost.ts)).
  A model without a recorded price is "unknown", never $0; use `quote` for it.
- Per-image and per-second models have a proven ceiling once the resolution,
  count or duration is set.
- Seedance 2.x bills by `usage.total_tokens` = width × height × (24 ×
  seconds + 1) / 1024 of the output. A 480p 4 s `seedance-2-mini` run was
  billed 40,594 tokens, $0.076642, matching the formula. Its ceiling is an
  estimate, not proven: other aspect ratios and reference video change the
  token count. Without `--resolution`, multix sends and prices 720p; without
  `--duration`, across 4-15 s.
- The receipt records the charge ToAPIs settles (`billing.cost_usd`).
- There is no balance command: an API key cannot read the account balance.
  Check it in the [ToAPIs dashboard](https://toapis.com/dashboard/tokens).

## Privacy

The API key is never logged, and `--verbose` logs uploaded file URLs
redacted. `--no-download` prints the full output URLs on purpose.
