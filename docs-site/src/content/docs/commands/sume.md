---
title: Sume commands
description: Generate images and video with any model in Sume's live catalog, price a run before sending it, and check, resume, download or cancel jobs by ID.
---

Sume commands call Sume's native REST API (`https://api.sume.com`) directly.
multix does not use Sume's hosted MCP server. Generation needs `SUME_API_KEY`,
created as described in [Sume authentication](https://www.sume.com/docs/authentication).
The key is sent only to the Sume API; keep it server-side.

## Models

```bash
multix sume models                       # every model: id, kind, modes, list price
multix sume models --kind video          # image | video | lipsync | captions
multix sume models --mode image-to-video
multix sume models --model kling-3       # the full catalog entry, as JSON
multix sume models --refresh             # reread instead of using the cached copy
```

Models come from Sume's public catalog (`GET /v1/open/catalog`), which needs
no key and costs nothing. multix publishes no model list and no default model
of its own: pass the exact catalog id with `-m`. Ids are never rewritten or
guessed, and an unknown id is refused before anything is sent.

The catalog is cached in `~/.multix/cache/models/sume-catalog.json` (or under
`MULTIX_CACHE_DIR`) with the same rules as [`multix models --live`](/reference/for-ai-agents/):

| State | Meaning |
| --- | --- |
| `fresh` | Read just now. |
| `cached` | A copy younger than `MULTIX_MODELS_TTL` (default 24 hours). |
| `stale` | The live read failed; a copy younger than 7 days is used, with a note. |
| `unavailable` | No usable copy. `sume image` and `sume video` send nothing. |

Every listing shows the catalog URL, the time it was read and its state.

## Images

```bash
multix sume image "a red fox in snow" -m seedream-v4 \
  [--aspect-ratio 1:1] [--resolution 2K] [--quality high] \
  [-n 2] [--output-format png] [--output <path>]

# Image edit: local files are uploaded first, https URLs are passed through
multix sume image "make the sky purple" -m seedream-v4 --image ./photo.png
```

## Video

```bash
# Text-to-video and image-to-video (first and last frame)
multix sume video "a lighthouse in a storm" -m kling-3 --duration 5 [--aspect-ratio 16:9]
multix sume video "the camera orbits the statue" -m kling-3 \
  --image ./first.png [--end-image ./last.png] [--generate-audio | --no-generate-audio]

# Reference media, video-to-video and lipsync, where the model supports them
multix sume video "..." -m <id> --ref-image a.png --ref-image b.png [--ref-video v.mp4] [--ref-audio s.mp3]
multix sume video "..." -m <id> --video ./source.mp4
multix sume video "a podcast studio" -m infinitalk --image ./face.png --audio ./speech.mp3 --duration 12
```

Each flag is checked against the model's catalog entry before anything is
sent: its capabilities (`text_to_video`, `image_to_video`, `end_frame`,
`reference_*`, `video_to_video`, `lipsync`, `audio`), its listed resolutions,
aspect ratios and durations, and its `request_fields` (required, omitted, and
minimum or maximum values). A flag the model does not take is refused.

Media inputs are public `https://` URLs or local files. A local file is
uploaded through Sume's pre-signed upload URL (at most 2 GiB; images, video and
audio only). The upload URL is a secret and is never printed.

Not supported: models served by their own route (the `sume-remix-*` models),
models that require a field multix does not map (for example captions styles,
dubbing languages or presets; refused as a schema mismatch), webhooks, sync
mode, and batch requests.

## Jobs

Generation is asynchronous. By default the command waits for the job (images
up to 5 minutes, video up to 20; `--wait-timeout <ms>`), then saves the
artifacts as `sume-<job id>-NN.<ext>` in the output directory.

```bash
multix sume video "..." -m kling-3 --async           # print the job id and exit
multix sume status <jobId>                            # one status read (JSON)
multix sume status <jobId> --wait --download          # resume: wait, then save
multix sume result <jobId> [--no-download]            # save (or print URLs of) a finished job
multix sume cancel <jobId>                            # only before generation starts
```

- `--no-download` prints the artifact URLs instead of saving them.
- `--output` is a file for one artifact, a file stem for several, or a
  directory. Resuming into the same place keeps files already saved.
- A stopped wait leaves the job running and billed. The run prints the resume
  command; do not resubmit.
- Status reads retry with backoff after network errors, 429 (honouring
  `Retry-After`) and 5xx.

## Idempotency and failures

Each generate request is sent once, with an `Idempotency-Key` header (a new
UUID, or `--idempotency-key <key>`). multix never resends it on its own. If the
connection breaks, or a gateway answers 5xx without Sume's error body, the job
may exist: the run fails with `UNKNOWN_REMOTE_STATE` and names the key. Send
the same command again with `--idempotency-key <key>`: Sume returns the
original job instead of charging twice.

| Answer | Code | Charged |
| --- | --- | --- |
| 401 | `INVALID_KEY` | No |
| 402 `insufficient_funds`, 403 `api_key_spend_limit_exceeded` | `QUOTA_EXCEEDED` | No |
| 429 | `RATE_LIMITED` | No |
| A failed or canceled job | `JOB_FAILED` | Refunded |

## Cost

```bash
multix sume video "..." -m kling-3 --duration 5 --estimate
multix sume video "..." -m kling-3 --duration 5 --max-cost 1.00
```

- With `SUME_API_KEY`, `--estimate` and `--max-cost` price the exact request
  with Sume's non-billable `POST /v1/open/estimate`. The quote, rounded up to
  the cent, is a proven ceiling.
- Without a key, or when that call fails, the catalog list price per image or
  per second is used, with the catalog URL and read time. It is an estimate,
  not a cap, so `--max-cost` refuses unless `--cost-policy estimate` is given.
- Local files are not uploaded to price a run.

Sume reserves a job's price at submit, captures it when the job completes, and
refunds it when the job fails or is canceled. After a job ends, multix reads
the job's final usage ledger: the receipt shows the captured charge, or `$0`
for a refund. The reservation is never counted as spend, the account balance
is never recorded as usage, and an unknown charge stays unknown, not `$0`.
