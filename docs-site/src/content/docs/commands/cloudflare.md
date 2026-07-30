---
title: Cloudflare commands
description: Generate images and speech with Workers AI, or submit and retrieve AI Gateway video jobs.
---

Cloudflare image and speech commands require `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`. Video also requires `CLOUDFLARE_AI_GATEWAY_ID` and
`REPLICATE_API_TOKEN`.

## Workers AI image and speech

`generate` uses the supported FLUX.1 Schnell image model. `--steps` accepts an
integer from 1 through 8. `generate-speech` returns MPEG audio through the
supported MeloTTS model.

```bash
multix cloudflare generate \
  --prompt "A technical pen drawing of an isometric terminal" \
  --steps 4 --output terminal.jpg

multix cloudflare generate-speech \
  --text "Welcome to multix." --lang en \
  --output welcome.mp3
```

An AI Gateway ID is optional for image and speech. When configured, multix
routes those Workers AI calls through the gateway; request-payload collection
stays disabled unless `CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` is set.

## AI Gateway video jobs

`generate-video` creates a `prunaai/p-video` prediction through Cloudflare AI
Gateway. Without `--wait`, it prints a prediction ID. `--download` implies
waiting and saves the completed MP4.

```bash
multix cloudflare generate-video \
  --prompt "Camera glides through a paper architectural model" \
  --duration 5 --aspect-ratio 16:9 --resolution 720p

multix cloudflare video-status <predictionId> \
  --download --output model-tour.mp4
```

Use `multix cloudflare generate-video --help` and `multix cloudflare
video-status --help` before automation; the installed CLI owns current options
and defaults.
