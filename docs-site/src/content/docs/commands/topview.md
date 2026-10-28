---
title: TopView commands
description: TopView marketing videos from a product link or your materials, talking avatars, product avatars and product shots (legacy API, plan credits), plus API Platform video and image models (USD balance).
---

TopView has **two separate APIs**, each with its own key and its own money.
multix keeps them apart: a command uses exactly one API, a key never falls back
to the other, and credits never move between them.

| API | Key | Paid from | Commands |
| --- | --- | --- | --- |
| Legacy API (`https://api.topview.ai`) | `TOPVIEW_API_KEY` **and** `TOPVIEW_UID` | Credits of your topview.ai web plan | `url-to-video`, `materials-to-video`, `export`, `video-avatar`, `product-avatar`, `product-anyshoot`, `upload --api legacy` |
| API Platform (`https://platform-backend.topview.ai`) | `TOPVIEW_API_PLATFORM_KEY` | A separate pay-as-you-go USD balance | `generate`, `upload --api platform` |

Get the legacy key and UID under **API Settings** at
[topview.ai](https://www.topview.ai/dashboard/home). Create a Platform key at
[platform.topview.ai](https://platform.topview.ai). `multix check` shows both.

:::caution[Billing]
- Legacy API usage spends the credits of your topview.ai plan ("API credits are
  shared with the credits in your topview.ai web account"; Ultra credits cannot
  be used). TopView publishes per-task point rules but no USD price, so multix
  reports the credits a task says it used (`costCredit`) and never a dollar
  amount.
- The API Platform charges its own USD balance. Its estimate "is not a cap", so
  multix records only the settled `charged_usd` once billing is `CAPTURED` or
  `RELEASED`. A `RESERVED` hold is not spend.
- Neither API has a provable upper bound before the run, so `--max-cost` refuses
  every TopView task command (`BUDGET_UNPROVEN`) instead of guessing.
- Your remaining balance is never reported as spend.
:::

## Marketing videos (legacy API)

```bash
# From a product page: TopView reads its media and copy
multix topview url-to-video --product-link https://shop.example.com/p/123 \
  [--product-name "Mug"] [--aspect-ratio 9:16] [--language en] [--video-length 1] \
  [--avatar-id <id>] [--voice-id <id>] [--caption-id <id>] [--preview]

# From your own images/videos (uploaded first) or earlier uploads
multix topview materials-to-video --file ./shot1.jpg --file asset:<fileId> \
  --product-name "Mug" [--product-description "..."]

# Submitted with --preview? Export one script
multix topview export <taskId> --script-id <id>
```

- `--aspect-ratio`: `9:16` (default), `3:4`, `1:1`, `4:3`, `16:9`.
- `--video-length`: `1` 30-50 s (default), `2` 15-30 s, `3` 30-45 s, `4` 45-60 s.
- `--extra <json>` adds other documented fields; a field a flag already sets is
  refused instead of overridden.
- Without `--preview` the exported video is returned directly. With
  `--preview`, the task returns preview videos; `export` then waits until the
  exported video exists.

## Avatars and product shots (legacy API)

```bash
# Talking avatar: TTS text or your audio
multix topview video-avatar --avatar-source 1 --avatar-id <id> --tts-text "Hi!" --voice-id <id>
multix topview video-avatar --avatar-source 3 --avatar-id <id> --image ./face.png --audio ./vo.mp3

# Product avatar: step 1 puts your product in an avatar image, step 2 animates it
multix topview product-avatar image --product ./mug.png --avatar-id <id> [--prompt "..."]
multix topview product-avatar video --image-id <imageId> --mode avatar4 --tts-text "..." --voice-id <id>

# Product shots: with a model, or in a new background
multix topview product-anyshoot model --product ./mug.png --template-mask ./mask.png --template-id <id> [--count 4]
multix topview product-anyshoot background --product ./mug.png --mode prompt --prompt "marble kitchen"
```

File options take a local file (uploaded through TopView's signed upload) or
`asset:<fileId>` from `multix topview upload <file> --api legacy`. URLs are not
accepted for files. Only media extensions are uploaded (`png`, `jpg`, `jpeg`,
`bmp`, `webp`, `mp3`, `wav`, `m4a`, `mp4`, `avi`, `mov`).

## API Platform models

```bash
multix topview models            # verified routes, with source and date
multix topview models --live     # also flag models in the public index that multix has not verified
multix topview generate bytedance/seedance-2.0-mini/text-to-video \
  --input '{"content":[{"type":"text","text":"waves at dusk"}]}'
multix topview generate openai/gpt-image-2/text-to-image --input @body.json
multix topview upload ./ref.png --api platform   # prints the asset JSON (reference)
```

`generate` accepts only routes TopView's docs list (`topview models`). The body
is the model's native JSON; the Platform validates it. Every request sends an
`Idempotency-Key` (a new random one unless you pass `--idempotency-key`).

## Task lifecycle

Every task command submits **once**, then waits (default 30 minutes; 15 for `product-anyshoot`) and saves
the results as `topview-<taskId>-NN.<ext>` in the output directory.

```bash
multix topview url-to-video --product-link https://shop.example.com/p/1 --async   # prints the task id
multix topview status <taskId> --task m2v                  # one read, prints JSON
multix topview status <taskId> --task m2v --wait           # poll until finished
multix topview status <taskId> --task m2v --download       # wait and save; already saved files are kept
multix topview status <predictionId> --task platform --download
```

- `--task` is one of `m2v`, `video-avatar`, `product-avatar-image`,
  `product-avatar-video`, `anyshoot-model`, `anyshoot-background`, `platform`.
  An export is read as `m2v`.
- `--no-download` prints the result URLs instead. TopView's legacy result URLs
  are valid for 7 days.
- A stopped wait (timeout or Ctrl-C) leaves the task running and prints the
  `status ... --download` command that resumes it.
- Polling retries network errors, 5xx, TopView's "busy" codes and 429 (honouring
  `Retry-After`).
- A submit is never retried. When its outcome is unknown (connection lost after
  sending, a gateway error, a timeout) the command fails with
  `UNKNOWN_REMOTE_STATE`. Check the task list before submitting again. On the
  Platform, resend the same input with the `--idempotency-key` the error names
  to get the original task back instead of a second one.
- TopView documents no cancel endpoint on either API, so there is no `cancel`.
- A failed task exits non-zero with TopView's reason. Credit refusals
  (legacy code 4100, Platform HTTP 402) are `QUOTA_EXCEEDED`; a wrong key or UID
  is `INVALID_KEY`.

## Environment

| Variable | Use |
| --- | --- |
| `TOPVIEW_API_KEY` | Legacy API key (topview.ai plan credits) |
| `TOPVIEW_UID` | Legacy API user id, sent as `Topview-Uid` with the key |
| `TOPVIEW_API_PLATFORM_KEY` | API Platform key (separate USD balance) |
| `TOPVIEW_BASE_URL` | Legacy API base override for proxies/tests (default `https://api.topview.ai`) |
| `TOPVIEW_PLATFORM_BASE_URL` | Platform base override (default `https://platform-backend.topview.ai`) |

Base URL overrides must be `https://` (plain `http://` only on localhost).
