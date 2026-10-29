---
title: Sume commands
description: Generate images and video (including lip-sync and captions) through the Sume API with one key, list Sume's model catalog and prices, check, resume or cancel jobs, and get Sume's price quote.
---

Sume commands call the Sume API (`https://api.sume.com`) and require
`SUME_API_KEY`, created in the [Sume app](https://app.sume.com). One key reaches
every image and video model in Sume's catalog. The catalog, not the CLI, decides
which models exist and which flags each one takes, so multix checks every flag
against the model's catalog row and refuses an unsupported one before anything
is uploaded or billed. There is no model fallback.

| Variable | Purpose |
| --- | --- |
| `SUME_API_KEY` | API key (required for `image`, `video`, `status`, `cancel` and `estimate`). |
| `SUME_IMAGE_MODEL` | Default model for `sume image` when `-m` is not given. |
| `SUME_VIDEO_MODEL` | Default model for `sume video` when `-m` is not given. |
| `SUME_BASE_URL` | API root override for mocks or proxies; see [Base URL overrides and trust](/reference/environment/#base-url-overrides-and-trust). |

There is no built-in default model: pass `-m <id>` or set the matching
`SUME_*_MODEL` variable. The model IDs on this page are examples; run
`multix sume models` for the current list.

## Models

```bash
multix sume models                  # every model, its modes, price range and supported flags
multix sume models --kind video     # one kind: image, video, lipsync, ...
multix sume models --refresh        # read the catalog from Sume now instead of the cache
multix sume models --json           # the full rows, with the catalog source and fetch time
```

`sume models` reads Sume's public catalog (`GET /v1/open/catalog`). It needs no
key and costs nothing. The catalog is cached in the multix cache directory for
`MULTIX_MODELS_TTL` seconds (default 24 hours). When Sume cannot be reached, a
cached copy up to 7 days old is shown and marked stale.

Each row shows the model's modes, its list price range per unit (per image or
per second), and what it supports: text input, image edit, first and end
frames, reference images, generated audio, durations, resolutions and aspect
ratios. Rows marked `(special route; not supported by multix)` use a Sume
endpoint multix does not call (for example a restyle route); `sume video`
refuses them.

## Images

```bash
multix sume image "a ceramic teapot on linen, studio light" -m nano-banana-2.1 \
  [--aspect-ratio 16:9] [--resolution 2K] [--quality <q>] [--image-size 1024x1024] \
  [--num-images 2] [--output-format webp]

# Edit: one or more input images (local files are uploaded first)
multix sume image "make it a watercolor" -m nano-banana-2.1 --image ./photo.png

# Wait for the job, then download the images
multix sume image "a red fox in snow" -m nano-banana-2.1 --wait [--output fox.png]
```

- `--aspect-ratio`, `--resolution`, `--quality`, `--output-format` and
  `--num-images` must be values or ranges the model's row lists. A flag the row
  does not list is refused with the values it accepts.
- `--image` repeats. A model that only edits (for example a layered-image
  model) needs at least one.
- `--param key=value` sets another request field the row lists (repeatable;
  dotted keys nest, such as `captions.style=bold`). Fields multix sets itself
  (`model`, `prompt`, media URLs) and fields with their own flag are refused.
- Prompts are at most 20000 characters.

## Video

```bash
# Text-to-video
multix sume video "waves at dusk, slow pan" -m veo-3.1 \
  [--duration 8] [--resolution 1080p] [--aspect-ratio 16:9] [--generate-audio | --no-generate-audio]

# Image-to-video: first frame, optional end frame and reference images
multix sume video "the camera orbits the statue" -m seedance-2 \
  --image ./first.png [--end-image ./last.png] [--reference-image ./style.png]

# Lip-sync: a face (image or video) and the speech; --duration is the audio's length
multix sume video -m kling-avatar-2.0 --image ./face.png --audio ./speech.mp3 --duration 12

# Wait for the job, then download the MP4
multix sume video "a lighthouse in a storm" -m veo-3.1 --wait [--wait-timeout <ms>] [--output clip.mp4]
```

- `--duration` is a whole number of seconds that the row lists, either as a set
  (such as 4, 6, 8) or a range.
- `--image` is the first frame and takes one value; `--end-image` needs
  `--image`; `--reference-image` repeats up to the row's limit.
- `--video` is a source video (video-to-video, video lip-sync, captions).
- `--audio` is only for lip-sync models, which need it together with
  `--image` or `--video` and `--duration`. `--generate-audio` is refused for
  them and for models without generated audio.
- A model that does not make video from text alone is refused without an input
  image or video, with the modes it supports.

## Jobs: async by default, status, resume and cancel

`sume image` and `sume video` do not wait by default. They submit the job,
log the amount Sume reserved, print the job ID with the commands to check,
resume and cancel it, then exit:

```text
Job submitted: <job_id>
  Check:  multix sume status <job_id>
  Resume: multix sume status <job_id> --wait --download
  Cancel: multix sume cancel <job_id>
```

`--wait` polls until the job finishes and downloads its outputs
(`--no-download` prints the output URLs instead). `--output`, `--download` and
`--no-download` need `--wait`. `--wait-timeout <ms>` bounds polling (defaults:
image 5 min, video and `status` 15 min). A timeout prints the resume command;
the job keeps running. Polling follows Sume's `next_poll_after_seconds` and
never runs faster than every 2 seconds.

```bash
multix sume status <job_id>                      # one-shot JSON summary
multix sume status <job_id> --wait --download    # resume without creating a new job
multix sume cancel <job_id>                      # cancel before generation starts
```

- `status` prints the job ID, status, the error when it failed, and output URLs
  without their signed query strings. It never prints the prompt or inputs.
  Only `--no-download` prints the signed URLs. Progress and hints go to
  stderr, so `multix sume status <job_id> | jq` parses.
- `failed` and `canceled` jobs exit non-zero, after their summary.
- `cancel` works only while the job is still queued. When generation has
  already started, Sume refuses the cancel and the job is billed when it
  completes; a job that already finished cannot be canceled.

## Inputs

`--image`, `--end-image`, `--reference-image`, `--video` and `--audio` accept:

- a public `https://` URL without credentials, whose host is not `localhost`
  or a private or loopback address. Sume fetches it itself;
- a local file, uploaded to Sume first (up to 2 GiB) through a one-time upload
  URL that never sees your key. Images: `.png`, `.jpg`, `.jpeg`, `.webp`,
  `.gif`; video: `.mp4`, `.mov`, `.webm`; audio: `.mp3`, `.wav`, `.m4a`,
  `.aac`, `.ogg`, `.flac`. The file type must match the flag.

`data:` URIs are refused. Every input is checked before the first upload, so a
bad value fails before anything is sent.

## Outputs

- Files are saved as `sume-<id8>-NN.<ext>` in `MULTIX_OUTPUT_DIR` (default
  `./multix-output`), where `<id8>` is the first 8 characters after `job_`.
- `--output <file>` saves a single output to that path (several outputs
  become `<file>-NN.<ext>`); `--output <dir>/` saves into a directory.
- Downloads use `https://` only, refuse private and loopback addresses, stop at
  `MULTIX_MAX_DOWNLOAD_MB`, and print `multix sume status <job_id> --download`
  to retry when one fails.

## Costs, refunds and limits

Sume bills in USD. On submit it reserves the job's price. The CLI logs that
amount (`usage.usd`) as reserved, but never counts it as spend. Once the run
sees the job complete (`--wait`, or `sume status` of a completed job), it
reads the job's captured charge (`usage_summary.captured_usd_cents`) and the
cost receipt reports that amount. A run that only submits gets a receipt
whose cost is unknown until a later run sees the job complete. Failed and
canceled jobs are refunded, so they record no spend. Refunded and released
amounts and the account balance are never counted as spend.

```bash
multix sume image "a fox" -m seedream-4-5-edit --num-images 2 --estimate     # pre-flight estimate, nothing sent
multix sume video "waves" -m veo-3.1 --duration 8 --max-cost 2              # refuse when the estimate exceeds $2
multix sume estimate "waves" -m veo-3.1 --duration 8                        # Sume's own quote (not billed)
```

- `--estimate` and `--max-cost` price the request from the cached catalog row:
  the matching price option times the billed units (images or seconds),
  rounded up to the cent. The ceiling is proven when exactly one option and the
  units are known, otherwise it is an estimated range.
- The estimate is unknown (never $0) when there is no cached catalog, the
  cached catalog is older than 24 hours, the model is missing from it, or a
  flag is invalid. Run `multix sume models --refresh` to refresh the cache.
- `sume estimate` asks Sume for its quote (`POST /v1/open/estimate`). The quote
  is shown as Sume returns it and is not used by `--max-cost`. Media must be
  `https://` URLs. The quote itself is free: it is not recorded as a charge,
  and `--max-cost` does not refuse it.
- Prices change; [Sume's API pricing](https://www.sume.com/pricing/api) is
  authoritative.

## Idempotency and retries

Every submit carries an `Idempotency-Key` (`multix-<uuid>` unless you pass
`--idempotency-key <key>`). A submit cut off by a network error, timeout or
5xx is retried up to twice with the same key, so Sume returns the job it
already created instead of charging twice. If the outcome is still unknown, or
the run is interrupted while submitting, the CLI prints the key: re-run the
same command with `--idempotency-key "<key>"` to get that job back, or check
your jobs in the [Sume app](https://app.sume.com). Refusals (400, 402, 403,
409, 422) are not retried.

## Sume's hosted MCP and multix

Sume runs its own MCP server: `https://mcp.sume.com/mcp` (OAuth) or
`https://api.sume.com/mcp` (API key). Use it when an MCP client should reach
Sume directly. multix is the command line (and agent) path: it adds flag
validation against the catalog before paying, cost pre-flight and receipts,
idempotent retries, resume hints and downloads. A local `sume mcp` command is
not released.

## Errors and privacy

- 401 points at `SUME_API_KEY`, 402 at the balance, 403
  `api_key_spend_limit_exceeded` at the key's spend limit, and 404 at the model
  or job. A 409 `idempotency_conflict` means the key was already used for a
  different request; it names that job.
- The API key, prompts and signed URLs (outputs and uploads) are never logged.
