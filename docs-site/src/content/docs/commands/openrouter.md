---
title: OpenRouter commands
description: Generate routed images, submit, poll, or download image-to-video jobs, and synthesize speech.
---

OpenRouter commands require `OPENROUTER_API_KEY`. Run `multix openrouter
video-models` to discover available video model IDs and `multix openrouter
speech-models` for speech model IDs.

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

## Text-to-speech

`tts` sends one request to OpenRouter's `/api/v1/audio/speech`. The default
model is `google/gemini-3.8-flash-tts` (override with `--model` or
`OPENROUTER_TTS_MODEL`). Give the text with `--text` (alias `--prompt`),
`--text-file`, or `--turns-file`, a JSON array of
`{"text", "voice"?, "instructions"?}` for multi-speaker models.

```bash
multix openrouter tts --text "Xin chào" \
  --model google/gemini-3.8-flash-lite-tts --voice Kore --output hello.wav

multix openrouter speech-models                     # live catalog
multix openrouter speech-models --model elevenlabs/eleven-v4   # its voices
multix openrouter generation <generation-id>        # cost recorded later
```

- The model and voice are checked against the live speech catalog before the
  paid request; a wrong model or voice fails with the valid choices.
  `--no-model-check` skips the check for a model OpenRouter does not list yet.
- Google Gemini and ElevenLabs models require `--voice` (Gemini: `Kore`,
  `Puck`, ...; ElevenLabs: `sarah`, `george`, ...). Fish Audio
  `fish-audio/drama-3` works without one.
- `--format auto` writes WAV for pcm-only models (Gemini, HeyGen) and MP3
  otherwise. `wav` is pcm wrapped in a WAV header locally (24 kHz mono unless
  OpenRouter states a rate, or `--sample-rate`). Gemini refuses `mp3`; MiniMax
  returns `mp3` only.
- `--instructions` sets tone, pace, and emotion where the model supports it;
  `--provider-options`, `--zdr`, and `--deny-data-collection` control routing.
- The request is never retried, because a second request is a second paid
  generation. A connection cut off after OpenRouter may have accepted it fails
  with `UNKNOWN_REMOTE_STATE`; check `multix openrouter generation <id>` or
  openrouter.ai/activity before sending it again.
- After the audio is saved, the CLI waits up to `--cost-wait` seconds (default
  20, max 120) for OpenRouter to report the cost; `--no-cost` skips it. With
  `--json`, the result includes the generation ID, cost, voice, format, size,
  SHA-256, and duration (pcm/WAV only); unknown values are `null`.

Speech-to-text is not available through `multix openrouter`.
