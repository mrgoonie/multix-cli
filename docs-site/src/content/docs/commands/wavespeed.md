---
title: WaveSpeedAI 3D
description: Generate 3D assets using Seed3D 2.0, Tripo H3.1, Hunyuan3D Rapid, and Meshy.
---

WaveSpeedAI provides asynchronous 3D inference via a single API key, including Seed3D 2.0 (available independently from Atlas Cloud). This provider also accepts arbitrary endpoint IDs with `wavespeed run`.

## Configure

Set `WAVESPEED_API_KEY` in your shell or `~/.multix/.env`. Then run `multix check`. Use [WaveSpeedAI access keys](https://wavespeed.ai/accesskey).

## Image-to-3D

```sh
multix wavespeed 3d --ref ./object.png --model bytedance/seed3d-2.0/image-to-3d
multix wavespeed 3d --ref ./object.png --model tripo3d/h3.1/image-to-3d
multix wavespeed 3d --ref ./object.png --model wavespeed-ai/hunyuan-3d-v3.1/image-to-3d-rapid
multix wavespeed 3d --ref ./front.png --ref ./left.png --model tripo3d/h3.1/multiview-to-3d
multix wavespeed 3d --ref ./object.png --model meshy/v7.1/image-to-3d
```

For Meshy multi-view, 1–4 images are allowed. Tripo multiview needs 2–4 images, with the first as the front view. Use `multix wavespeed models` for the curated model IDs.

For advanced fields use JSON to match each provider's model schema:

```sh
multix wavespeed 3d --ref ./object.png --model bytedance/seed3d-2.0/image-to-3d --input '{"subdivision_level":"high"}'
multix wavespeed run bytedance/seed3d-2.0/image-to-3d --file image=./object.png --input '{"subdivision_level":"medium"}'
```

## Text-to-3D

```sh
multix wavespeed 3d "a small wooden chest" --model tripo3d/h3.1/text-to-3d
```

## Resumable jobs

```sh
multix wavespeed 3d --ref ./object.png --detach
multix wavespeed status PREDICTION_ID --wait
multix wavespeed status PREDICTION_ID --no-download
```

A failed submit with uncertain status is **not retried automatically** because the remote job may have started and incurred charges. GET status requests may be retried. Returned storage upload URLs are short-lived credentials and are used only for direct upload, without the WaveSpeed API key.

Prices shown on model pages are not necessarily the final billed cost. Do not assume a catalog unit price equals one generation.

## fal.ai alternatives

The existing fal client now also has a typed 3D command:

```sh
multix fal 3d --ref ./object.png --model hitem3d/hi3d/v3.0/image-to-3d --input '{"resolution":"2048quality"}'
multix fal 3d --ref ./object.png --model hitem3d/hi3d/image-to-3d --input '{"model":"hitem3dv2.1","resolution":"1536pro"}'
multix fal 3d --ref ./object.png --model fal-ai/hunyuan-3d/v3.1/pro/image-to-3d
multix fal 3d --ref ./object.png --model meshy/v7.1/image-to-3d
multix fal 3d --ref ./front.png --ref ./side.png --model tripo3d/h3.1/multiview-to-3d
```

fal jobs support `--detach` and existing `multix fal result/status` receipt-based resumption. Provider schemas and cost tiers differ.

**References:** [WaveSpeed upload API](https://wavespeed.ai/docs/upload-files-api), [WaveSpeed result polling](https://wavespeed.ai/docs/get-result), [Seed3D model](https://wavespeed.ai/models/bytedance/seed3d-2.0/image-to-3d), [fal Hi3D](https://fal.ai/models/hitem3d/hi3d/v3.0/image-to-3d/api).
