---
title: OpenRouter commands
description: Generate routed images and submit, poll, or download image-to-video jobs.
---

OpenRouter commands require `OPENROUTER_API_KEY`. Run `multix openrouter
video-models` to discover available video model IDs for the installed CLI.

## Images

```bash
multix openrouter generate \
  --prompt "Retro robot in a rainy city" \
  --model google/gemini-3.1-flash-image-preview \
  --aspect-ratio 16:9 --output robot.png

multix openrouter i2i \
  --prompt "Make it cyberpunk" --ref ./photo.jpg \
  --model google/gemini-2.5-flash-image --output cyberpunk.png
```

Image references accept local paths or URLs. `--strength` applies only to
Recraft image-to-image models. If configured, `OPENROUTER_FALLBACK_MODELS`
applies to image generation and image-to-image requests.

## Image-to-video jobs

`image-to-video` (alias `i2v`) is asynchronous. Its first frame, and optional
last frame, must be HTTPS URLs—not local paths. Submit and retain the job ID,
then query it with `video-status`; `--download` implies waiting.

```bash
multix openrouter i2v \
  --prompt "Camera pans left" \
  --image-url https://example.com/first-frame.jpg \
  --last-frame-url https://example.com/last-frame.jpg \
  --model google/veo-3.1

multix openrouter video-status <jobId> --download --output clip.mp4
```

To submit and wait in one command, add `--wait`; adding `--download` waits and
downloads the completed video.
