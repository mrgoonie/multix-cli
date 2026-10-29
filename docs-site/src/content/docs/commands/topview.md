---
title: TopView commands
description: Make product marketing videos, talking avatars, product avatar videos and product shots with the TopView Legacy API, and run API Platform models such as Seedance, Wan and GPT Image 2.
---

TopView has two separate APIs, and multix supports both. They use different
keys and different balances, and neither key works on the other API.

| | Legacy API | API Platform |
| --- | --- | --- |
| Host | `https://api.topview.ai` | `https://platform-backend.topview.ai` |
| Credentials | `TOPVIEW_API_KEY` and `TOPVIEW_UID`, both under API Settings at [topview.ai/api-settings](https://www.topview.ai/api-settings) | `TOPVIEW_PLATFORM_API_KEY`, created under API keys at [platform.topview.ai](https://platform.topview.ai) |
| Billing | Credits of your topview.ai plan | A separate USD balance |
| Commands | `url-to-video`, `materials-to-video`, `m2v-export`, `video-avatar`, `product-avatar`, `product-anyshoot`, `status`, `upload`, `credit` | `models`, `run`, `prediction` |

`TOPVIEW_BASE_URL` and `TOPVIEW_PLATFORM_BASE_URL` override the API roots for
mocks or proxies. They follow the same trust rules as the other `*_BASE_URL`
settings; see
[Base URL overrides and trust](/reference/environment/#base-url-overrides-and-trust).

Neither API has a cancel endpoint, so there is no `topview cancel` command. A
submitted task runs to completion and is billed.

Only endpoints in TopView's API reference are used. TopView's marketing pages
also mention `/v1/url2video`, `/v1/materials2video`,
`/v1/product_avatar/task/submit` and `/v1/product_anyshoot/task/submit`. These
are not in the API reference, so multix never calls them.

## Legacy API

### Marketing video from a product URL or materials

```bash
# TopView reads the product page itself
multix topview url-to-video https://shop.example.com/p/mug \
  [--aspect-ratio 9:16] [--language en] [--video-length-type 1] \
  [--avatar-id <id>] [--voice-id <id>] [--caption-id <id>] \
  [--logo ./logo.png] [--music ./music.mp3] [--target-audience "..."]

# From your own images and videos (--file repeats)
multix topview materials-to-video --file ./front.jpg --file ./demo.mp4 \
  --product-name "Ceramic mug" --product-description "Hand-glazed, 350 ml"
```

- `--aspect-ratio` is one of `9:16` (default), `3:4`, `1:1`, `4:3`, `16:9`.
- `--video-length-type` is `1` (30 to 50 s, default), `2` (15 to 30 s), `3`
  (30 to 45 s) or `4` (45 to 60 s).
- `--product-name` and `--product-description` are optional for
  `url-to-video`. `materials-to-video` requires both.
- `--preview` asks TopView for preview videos first. Export the one you want
  with `multix topview m2v-export <taskId> <scriptId>`. TopView bills the
  export (5 credits) after it completes. Without `--preview`, TopView returns
  the final video directly.
- The product URL must be `http://` or `https://`. multix sends it as-is and
  TopView fetches it.

### Talking avatar video

```bash
multix topview video-avatar --avatar-id <id> --tts-text "Welcome to our store"
multix topview video-avatar --image ./face.jpg --audio ./speech.mp3
multix topview video-avatar --video ./me.mp4 --tts-text "..." --voice-id <id>
```

- Pass one avatar source: `--video <file>`, `--image <file>` or
  `--avatar-id <id>`. A public avatar is the default. Add `--custom-avatar`
  when the id is one of your custom avatars.
- Pass one audio source: `--audio <file>`, or `--tts-text <text>` with
  `--voice-id`. A public `--avatar-id` has a default voice, so it does not need
  `--voice-id`. `--voice-speed` is 0.8 to 1.2.
- `--mode-type 0` is Avatar 1 (default) and `1` is Avatar 2. `--caption-id`
  applies to public avatars only.

### Product avatar video (three paid stages)

`product-avatar` runs TopView's Product Avatar V3 chain. Each stage is a
separate paid task:

1. Remove the background from the product image.
2. Place the product into an avatar image (image replace).
3. Animate that image into a talking video (image to video).

```bash
multix topview product-avatar --product-image ./bottle.png \
  --avatar-id <public product avatar id> \
  --image-edit-prompt "Put the bottle in the person's right hand" \
  --mode avatar4 --tts-text "Meet our new serum" --voice-id <id>
```

- Stage 2 needs one avatar, `--avatar-id <id>` or `--template-image <file>`.
  The default `--generate-image-mode auto` requires `--image-edit-prompt`.
  `--generate-image-mode manual` requires `--location` instead (see
  [Placement](#placement---location)).
- Stage 3 requires `--mode avatar2|avatar4|avatar4Fast`. For the script, pass
  `--tts-text` with `--voice-id`, or `--audio <file>` (up to 28 s for
  `avatar2`, 120 s for the others). `--caption-id` is optional.
- The command always waits for each stage before it starts the next.
  `--wait-timeout` applies to each stage separately (default 30 min).
- Each stage logs its task ID and the command that resumes from the next
  stage. After a failure, resume with the output of the last successful stage
  instead of starting over:

```bash
multix topview status remove-bg <taskId> --wait          # shows bgRemovedImageFileId
multix topview product-avatar --bg-removed-file-id <fileId> <stage 2 and 3 flags>

multix topview status product-avatar-replace <taskId> --wait   # shows imageIds
multix topview product-avatar --replace-image-id <imageId> <stage 3 flags>
```

- multix never resubmits a stage on its own. If a submit fails in a way that
  may still have created the task (network error, timeout, 5xx), the chain
  stops. Check `multix topview credit` before you retry.
- Stage 2 can return several images. For `avatar4` and `avatar4Fast`, the
  first image with a face is used. TopView allows only `avatar2` for an image
  without a face.

### Product photos (AnyShoot)

```bash
# A model wearing or holding the product
multix topview product-anyshoot --mode try-on --product-image ./shirt.png \
  --template-id <id> --template-mask ./template-mask.png [--product-mask ./mask.png] [--count 4]

# The background-free product in a new scene
multix topview product-anyshoot --mode background --product-image ./bottle-nobg.png \
  --prompt "on a marble counter, morning light" \
  --location "[[0.3,0.3],[0.7,0.3],[0.7,0.8],[0.3,0.8]]" [--aspect-ratio 1:1] [--similarity natural]
```

- `try-on` needs a template (`--template-id` or `--template-image`) and
  `--template-mask`. `--count` is 1 to 4 images (default 1).
- `background` needs a background-free product image, one scene source
  (`--template-id`, `--template-image` or `--prompt`) and `--location`.
  `--similarity` is `natural` (default) or `creative`.
- `--product-file-id <fileId>` reuses a file you already uploaded, for example
  the `bgRemovedImageFileId` of a `remove-bg` task.
- A flag that belongs to the other mode is rejected.

### Placement (`--location`)

`--location` is a JSON array of four `[x, y]` points, clockwise from the top
left. The coordinates are normalized to the canvas: `[0, 0]` is the top-left
corner and `[1, 1]` the bottom-right corner. See TopView's
[location parameter reference](https://docs.topview.ai/reference/location-parameters-document-v3).

### Async tasks, status and resume

Every Legacy command except `product-avatar` returns as soon as the task is
created. It prints the task ID and the commands to check and resume it:

```text
Task submitted: <taskId>
  Check:  multix topview status <kind> <taskId>
  Resume: multix topview status <kind> <taskId> --wait --download
  Cancel: not available (the Legacy API has no cancel endpoint; the task runs to completion and is billed)
```

`--wait` polls until the task finishes and downloads the result
(`--no-download` prints the URLs instead). `--output`, `--download` and
`--no-download` need `--wait`.

```bash
multix topview status <kind> <taskId>                     # one-shot JSON summary
multix topview status <kind> <taskId> --wait --download   # resume without a new task
```

- The kinds are `m2v`, `video-avatar`, `remove-bg`, `product-avatar-replace`,
  `product-avatar-video`, `anyshoot-try-on` and `anyshoot-background`.
- `status` writes only its result to stdout: the JSON summary, or the list of
  saved files with `--download`. Progress, cost and next-step hints go to
  stderr. A failed task exits non-zero. An unknown status counts as still
  running.
- Tasks are polled every 3 seconds or more. A timeout prints the resume
  command, and the task keeps running.

### Uploads and credits

```bash
multix topview upload ./product.png   # {"fileId": "...", "name": "product.png", "format": "png"}
multix topview credit                 # remaining plan credits and recent API tasks (free)
```

- Legacy tasks take TopView file IDs, not URLs, so multix uploads every file
  flag through TopView's presigned upload flow. The upload URL must be a
  public `https://` address. TopView headers are never sent to it. Uploads are
  free.
- File flags accept a local file or a public `https://` URL. multix downloads
  a URL to a temporary directory first, then uploads it. That download
  refuses `localhost` and private addresses on every redirect and stops at
  `MULTIX_MAX_DOWNLOAD_MB`. Accepted formats: images `png`, `jpg`, `jpeg`,
  `bmp`, `webp`; audio `mp3`, `wav`, `m4a`; video `mp4`, `avi`, `mov`.
- `credit` shows `remainCredit`, which is a balance and not spend. It does not
  show the API Platform balance.

## API Platform

### Models and prices

```bash
multix topview models            # verified routes with live catalog prices
multix topview models --json
multix topview models --refresh  # refetch the catalog
```

`models` lists the prediction routes that multix accepts for `topview run`,
joined with TopView's public model catalog. It needs no key. The routes are
maintained by hand from the API Platform docs, and each one records its source
URL and `verified_at` date. Prices are shown as TopView reports them, in USD,
with the time they were fetched. The catalog is cached under
`~/.multix/cache/models/` (`MULTIX_CACHE_DIR` and `MULTIX_MODELS_TTL` apply).
If the catalog cannot be fetched, the routes are still listed, without prices.
[TopView's pricing page](https://platform.topview.ai/pricing) is
authoritative.

Verified route families on 2026-10-28:

| Model | Routes | Body |
| --- | --- | --- |
| Wan 3.0 | `alibaba/wan-3.0/{image-to-video,text-to-video,reference-to-video}` | `{"input": {...}, "parameters": {...}}` |
| Seedance 2.5, 2.0, 2.0 Fast, 2.0 Mini | `bytedance/seedance-<version>/{image-to-video,text-to-video,omni-reference-to-video}` | `{"content": [...], ...}` |
| Topview T1 | `topview/topview-t1/{image-to-video,text-to-video,omni-reference-to-video}` | `{"content": [...], ...}` |
| MiniMax H3 | `minimax/minimax-h3/{image-to-video,text-to-video}` | `{"content": [...], ...}` |
| GPT Image 2 | `openai/gpt-image-2/{text-to-image,edit}` | `{"prompt": "...", ...}` |

### Run a prediction

```bash
multix topview run bytedance/seedance-2.0/text-to-video \
  --input '{"content":[{"type":"text","text":"a paper boat on a rainy street"}],"ratio":"16:9"}'

multix topview run openai/gpt-image-2/text-to-image --input @body.json --wait
```

- `--input` takes the request body as inline JSON or as `@path` to a JSON
  file. multix rejects a route that is not verified, and a body whose
  top-level shape does not match the route's family, before it sends
  anything. TopView checks the fields.
- Every submission carries an `Idempotency-Key`, generated before the request
  is sent. multix reuses the same key when it retries a network error, `429`
  or `5xx` (at most twice, honoring `Retry-After`). If the outcome stays
  unknown, or the run is stopped (Ctrl-C, a timeout) while the submit is in
  flight, multix prints the key. Retry with the same body and
  `--idempotency-key <key>` to get the same prediction back instead of
  creating a second one.
- Without `--wait`, the command prints the prediction ID, the commands to
  check and resume it, and the idempotency key.

### Prediction status

```bash
multix topview prediction <id>                      # one-shot JSON summary
multix topview prediction <id> --wait --download    # resume
```

- Statuses are `created`, `processing`, `payment_required`, `completed` and
  `failed`. `payment_required` and `failed` exit non-zero.
- `payment_required` means the actual cost was higher than the reserved
  amount. Top up the same workspace at
  [platform.topview.ai](https://platform.topview.ai). TopView retries
  settlement automatically, so do not submit again; resume with
  `prediction <id> --wait`.
- Predictions are polled every 2 seconds or more, with back-off.

## Outputs

- Files are saved as `topview-<id8>-NN.<ext>` in `MULTIX_OUTPUT_DIR` (default
  `./multix-output`). `--output <file>` saves a single output to that path
  (several outputs become `<file>-NN.<ext>`), and `--output <dir>/` saves into
  a directory.
- Legacy result URLs are valid for 7 days. API Platform URLs may expire
  sooner, so download promptly. API Platform image outputs may also be inline
  data, which is written directly.
- Downloads use `https://` only, refuse `localhost` and private addresses on
  every redirect, and stop at `MULTIX_MAX_DOWNLOAD_MB`. If a download fails,
  the command exits non-zero and prints how to retry it.

## Cost and retries

- multix does not estimate TopView costs before a run. After a run, it logs
  what TopView reports. Legacy tasks report `costCredit` in plan credits. API
  Platform predictions report `charged_usd` with a `billing_state`:
  `RESERVED` is a temporary hold and not final spend, `CAPTURED` is the final
  charge, and `RELEASED` means the hold was returned.
- Legacy submits have no idempotency key, so multix never retries them, not
  even on `429`. After a `429`, network error, timeout, `5xx` or an
  unreadable success response, the task may still have been created and
  billed. Check `multix topview credit` (recent tasks) or the
  [TopView dashboard](https://www.topview.ai/dashboard/home) before you retry.

## Errors and privacy

- Legacy errors: `401` points at `TOPVIEW_API_KEY` and `TOPVIEW_UID`, `4100`
  at missing plan credits (`multix topview credit`), and `4007` at an earlier
  task of the same kind that is still running. `400x` codes are rejected
  parameters, `5xxx` codes are TopView server errors, and `6001` is a security
  rejection.
- API Platform errors: `401` points at `TOPVIEW_PLATFORM_API_KEY`, `403` at
  the key's permissions (`models:generate` to submit, `requests:read` to read
  results), and `402` at the workspace balance. TopView's request ID is
  included when TopView returns one.
- Keys, signed upload and output URLs, prompts and request bodies are never
  logged. Summaries print output URLs without their signed query strings.
  Only `--no-download` prints the full URLs.
