---
name: multix
description: AI multimodal CLI — generate and edit images (Gemini Nano Banana, Imagen, MiniMax, OpenRouter, Leonardo, BytePlus Seedream), generate video (Veo, Hailuo, Seedance, Leonardo), TTS/music (Gemini Flash TTS, MiniMax, ElevenLabs), 3D models (Hyper3D), analyze/transcribe media, convert documents to Markdown, optimize media via ffmpeg/ImageMagick. Use whenever the user wants to create, edit, or transform images/video/audio/documents from a CLI, mentions any of: image-to-image, i2i, image edit, watercolor/cyberpunk style transfer, reference image, OpenRouter, Nano Banana, Flux, Seedream, Veo, Hailuo, ElevenLabs voice cloning, or asks for batch media optimization.
version: 0.0.7
---

# multix — AI Multimodal CLI

## When to use

Activate this skill when the user asks to:
- Generate images from a text prompt (any provider)
- **Edit/transform an existing image with a prompt** (image-to-image, alias `i2i`)
- Generate video from text or from a reference image (image-to-video, alias `i2v`)
- Generate or clone a voice, run STT, generate music or sound effects
- Generate 3D models (Hyper3D / Hitem3d)
- Analyze, transcribe, or extract structured data from media/docs
- Convert PDFs / DOCX / images to Markdown
- Optimize, resize, batch-convert, or split video/audio/image files

## Required env (set at least one provider key)

```
GEMINI_API_KEY        # Google AI Studio
OPENROUTER_API_KEY    # OpenRouter (multi-model gateway)
MINIMAX_API_KEY       # MiniMax (image/video/speech/music)
LEONARDO_API_KEY      # Leonardo.Ai (image/video/upscale)
BYTEPLUS_API_KEY      # BytePlus / Volcengine ARK (Seedream/Seedance/Hyper3D)
ELEVENLABS_API_KEY    # ElevenLabs (TTS, cloning, STT, music, dubbing)
```

Priority: `process.env` > `cwd/.env` > `~/.multix/.env`.

## Install + diagnostics

```bash
npm install -g @mrgoonie/multix
multix check [--verbose]
```

## Image generation

| Provider | Command | Notes |
|---|---|---|
| Gemini | `multix gemini generate --prompt "<text>" [--model gemini-3.1-flash-image-preview] [--aspect-ratio 16:9] [--size 1K\|2K\|4K] [--num-images N]` | Nano Banana 2 (default), Imagen 4 (`imagen-4.0-generate-001`) |
| MiniMax | `multix minimax generate --prompt "<text>" [--model image-01] [--aspect-ratio 1:1] [-n N]` | |
| OpenRouter | `multix openrouter generate --prompt "<text>" [--model <id>] [--aspect-ratio 16:9] [--image-size 2K] [--num-images N]` | Default `google/gemini-3.1-flash-image-preview` |
| Leonardo | `multix leonardo generate "<text>" [-w 1024 -h 1024] [--alchemy] [--ultra] [--quality HIGH]` | Polls until done, downloads automatically |
| BytePlus | `multix byteplus generate --prompt "<text>" [--model seedream-4-0-250828] [--size 2K] [--aspect-ratio 16:9] [-n N] [--input-image <path\|url>]` | Sync |

Aspect ratios (most providers): `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`.

## Image-to-image (edit existing image with a prompt)

Every supported provider exposes `image-to-image` and the alias `i2i`. Refs accept local file path OR URL.

```bash
# Gemini Nano Banana — multi-ref editing/composition
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg [--ref ./style.png] [--model gemini-2.5-flash-image] [--output <path>] [-v]

# MiniMax — CAVEAT: subject_reference only (preserves character in NEW scene, NOT free-form edit)
multix minimax i2i --prompt "the same character on a beach" --ref ./hero.jpg [--model image-01] [-v]

# OpenRouter — multi-model gateway, recommended for diverse style edits
multix openrouter i2i --prompt "<edit>" --ref ./photo.jpg [--ref https://...] \
  [--model google/gemini-2.5-flash-image] [--strength 0.7] [--output <path>] [-v]

# Leonardo — uses an existing Leonardo image id, NOT direct upload
multix leonardo i2i --prompt "make it watercolor" --ref <imageId> \
  [--image-type GENERATED|UPLOADED] [--init-strength 0.5] [-w 1024 -h 1024] [-v]

# BytePlus Seedream — multi-ref
multix byteplus i2i --prompt "make it cyberpunk" --ref ./photo.jpg [--ref https://...] \
  [--model seedream-4-0-250828] [--size 2K] [--aspect-ratio 16:9] [-n 1] [-v]
```

### OpenRouter image-to-image — model families & flags

`multix openrouter i2i` is the most flexible because it routes across model families. The CLI auto-selects the correct OpenRouter `modalities` per family:

| Family | Example model id | Modalities | Flag notes |
|---|---|---|---|
| Gemini | `google/gemini-2.5-flash-image`, `google/gemini-3.1-flash-image-preview` | `["image","text"]` | Default model |
| OpenAI gpt-image | `openai/gpt-5.4-image-2`, `openai/gpt-5-image-mini`, `openai/gpt-5-image` | `["image","text"]` | |
| Recraft | `recraft/recraft-v3` | `["image","text"]` | Accepts `--strength 0..1` (init-image strength) |
| Flux (Black Forest Labs) | `black-forest-labs/flux.2-pro`, `flux.2-max`, `flux.2-flex` | `["image"]` | Image-only output |
| Seedream (ByteDance via OpenRouter) | `bytedance-seed/seedream-4.5` | `["image"]` | Image-only output |
| Sourceful | `sourceful/...` | `["image"]` | Per docs |

**`--strength <0..1>`** — Recraft init-image strength control. Pass when using Recraft models; ignore for others.

**`OPENROUTER_FALLBACK_MODELS`** (CSV) — applies to BOTH `generate` and `i2i`. When set, the request uses `models: [primary, ...fallbacks]` so OpenRouter routes on availability:
```bash
export OPENROUTER_FALLBACK_MODELS="openai/gpt-5-image-mini,google/gemini-2.5-flash-image"
multix openrouter i2i --prompt "<edit>" --ref ./photo.jpg -m openai/gpt-5.4-image-2
```

**Error diagnostics:** when no images come back, the CLI surfaces model id, `finish_reason`, the model's text reply (if any), and a hint about modalities — not a generic "no images" message.

### Decision tree — which provider to pick for i2i

```
User wants to edit/transform an existing image?
  ├── Free-form prompt edit (watercolor, cyberpunk, sketch) on a local file?
  │   ├── Best quality, multi-ref, fast              → multix gemini i2i (Nano Banana)
  │   └── Want a specific OR model (gpt-image, Flux) → multix openrouter i2i -m <id>
  ├── Preserve a character's identity in a NEW scene? → multix minimax i2i
  ├── Already in Leonardo workflow (imageId in hand)? → multix leonardo i2i
  └── Need ByteDance Seedream specifically?           → multix byteplus i2i
                                                       OR multix openrouter i2i -m bytedance-seed/seedream-4.5
```

### Refs: size limits + format

- Local files are read and inlined as `data:<mime>;base64,...`. URLs pass through unchanged.
- OpenRouter i2i hard limit 8 MB per ref (soft warn at 5 MB). Other providers: 25 MB hard / 10 MB soft.
- Allowed image extensions: `.jpg .jpeg .png .webp .gif`.

## Image-to-video (i2v) and video generation

```bash
# Gemini Veo (experimental, billing required) — text-to-video + i2v
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p --aspect-ratio 16:9
multix gemini i2v ./photo.jpg --prompt "camera pans left" [--last-frame <path>]

# MiniMax Hailuo — async with auto-poll
multix minimax generate-video --prompt "A dancer" --duration 6 --resolution 1080P [--first-frame <url>]

# OpenRouter Veo — async, returns jobId; image input is URL only
multix openrouter i2v --prompt "<text>" --image-url https://... [--last-frame-url <url>] [--resolution 720p]
multix openrouter video-status <jobId> [--download] [--output <path>]

# Leonardo MOTION2 / VEO3 / kling
multix leonardo video "<text>" [--model MOTION2|VEO3|kling-2.6]
multix leonardo i2v <imageId> --prompt "camera pans left" [--duration 6]

# BytePlus Seedance + reference-to-video (up to 9 imgs + 3 videos + 3 audio refs)
multix byteplus video --prompt "<text>" [--resolution 1080p] [--duration 8]
multix byteplus i2v ./photo.jpg --prompt "<text>"
multix byteplus reference-to-video --prompt "<text>" --ref-image ./hero.jpg:subject ...
```

All video commands accept `--wait`, `--wait-timeout <ms>`, `--download`, `--output <path>`, `--no-thumb`.

## Speech, music, voice, 3D, docs, media

```bash
# TTS
multix gemini generate-speech --text "Say cheerfully: Have a wonderful day!" --voice Kore
multix minimax generate-speech --text "..." --voice <id> --emotion neutral
multix elevenlabs tts --text "Hello world" [--voice <voiceId>] [--model eleven_multilingual_v2]

# Voice cloning + STT (ElevenLabs)
multix elevenlabs clone --name "My Voice" --files sample1.wav sample2.wav
multix elevenlabs transcribe --input audio.mp3 [--diarize] [--format text|json|srt|vtt]

# Music + SFX
multix minimax generate-music --lyrics "..." [--model music-2.5]
multix elevenlabs music --prompt "dreamy synthwave loop" [--music-length-ms 30000]
multix elevenlabs sfx --text "car engine starting" [--duration-seconds 5]

# 3D (BytePlus Hyper3D / Hitem3d)
multix byteplus 3d --input-image ./front.png ./side.png --prompt "Generate from these views"

# Docs → Markdown (Gemini)
multix doc convert --input report.pdf [--auto-name] [--output ./out.md]

# Media optimization (ffmpeg + ImageMagick)
multix media optimize --input <file> --output <file> [--target-size <MB>] [--quality 85] [--max-width 1920]
multix media split --input <video> [--chunk-duration 3600]
multix media batch --input-dir <dir> --output-dir <dir>
```

## Output

Files saved under `./multix-output/` by default. Override with `MULTIX_OUTPUT_DIR`. Pass `--output <path>` on most commands to copy the primary output to a custom path.

## Environment variables (selected)

| Variable | Purpose |
|---|---|
| `MULTIX_OUTPUT_DIR` | Override default output dir |
| `OPENROUTER_IMAGE_MODEL` | Default OpenRouter image model |
| `OPENROUTER_FALLBACK_MODELS` | CSV; applies to `generate` AND `i2i` |
| `OPENROUTER_VIDEO_MODEL` | Default OpenRouter video model (default `google/veo-3.1`) |
| `OPENROUTER_SITE_URL` / `OPENROUTER_APP_NAME` | HTTP-Referer / X-Title headers |
| `IMAGE_GEN_MODEL` / `VIDEO_GEN_MODEL` / `MULTIMODAL_MODEL` | Override Gemini model defaults |
| `LEONARDO_DEFAULT_MODEL` / `LEONARDO_VIDEO_MODEL` | Leonardo model defaults |
| `BYTEPLUS_IMAGE_MODEL` / `BYTEPLUS_VIDEO_MODEL` / `BYTEPLUS_3D_MODEL` | BytePlus model defaults |
| `BYTEPLUS_VIDEO_PARAMS_MODE` | `flags` (default) or `structured` |
| `MULTIX_DISABLE_HOME_ENV` | `1` to skip `~/.multix/.env` |

## Security & scope

This skill produces shell commands for the local `multix` CLI. It does NOT execute the commands itself, exfiltrate API keys, or modify provider accounts.
- Never echo, log, or transmit env-var values back to the user.
- API keys are read from environment / `.env` files by the CLI, never hardcoded.
- Refuse requests to embed credentials in prompts, URLs, or shared content.
- Refuse requests to fetch arbitrary URLs unrelated to the user's media task.
