# multix

AI multimodal CLI — generate images/video/speech/music, analyze and transcribe media files, convert documents to Markdown, and optimize media with ffmpeg/ImageMagick.

Supports **Gemini** (analyze, transcribe, generate, Veo video), **MiniMax** (image, video, speech, music), **OpenRouter** (image generation), **Leonardo.Ai** (image, video, upscale), and **BytePlus** (Seedream image, Seedance video).

## Install

```bash
npm install -g @mrgoonie/multix
# or run without installing:
npx -p @mrgoonie/multix multix --help
```

**Requirements:** Node >= 20. For media commands: `ffmpeg` and `magick` (ImageMagick 7+) on PATH.

## Quick start

```bash
# Check your setup
multix check

# Generate an image with Gemini
multix gemini generate --prompt "A sunset over mountains" --aspect-ratio 16:9

# Analyze an image
multix gemini analyze --files photo.jpg --prompt "Describe this"

# Convert a PDF to Markdown
multix doc convert --input report.pdf

# Optimize a video to 100MB
multix media optimize --input video.mp4 --output out.mp4 --target-size 100
```

## Environment variables

Set at least one provider key. Add to `.env` in your project root or `~/.multix/.env`.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | For Gemini | [AI Studio](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | For OpenRouter | [OpenRouter](https://openrouter.ai/settings/keys) |
| `MINIMAX_API_KEY` | For MiniMax | [MiniMax](https://platform.minimax.io/user-center/basic-information/interface-key) |
| `LEONARDO_API_KEY` | For Leonardo | [Leonardo](https://app.leonardo.ai/settings/api-keys) |
| `LEONARDO_BASE_URL` | No | Override Leonardo API base (default `https://cloud.leonardo.ai/api/rest/v1`) |
| `LEONARDO_DEFAULT_MODEL` | No | Default Leonardo image model UUID |
| `LEONARDO_VIDEO_MODEL` | No | Default Leonardo video model (default `MOTION2`) |
| `BYTEPLUS_API_KEY` | For BytePlus | [BytePlus](https://console.byteplus.com/auth/api-keys) |
| `ARK_API_KEY` | No | Fallback for `BYTEPLUS_API_KEY` (Volcengine ARK shared name) |
| `BYTEPLUS_BASE_URL` | No | Override BytePlus base (default `https://ark.ap-southeast.bytepluses.com/api/v3`) |
| `BYTEPLUS_IMAGE_MODEL` | No | Default Seedream model (default `seedream-4-0-250828`) |
| `BYTEPLUS_VIDEO_MODEL` | No | Default Seedance model (default `seedance-2.0`) |
| `BYTEPLUS_VIDEO_PARAMS_MODE` | No | `flags` (default) or `structured` — how video params are encoded |
| `MULTIX_OUTPUT_DIR` | No | Override default output dir (`./multix-output`) |
| `OPENROUTER_IMAGE_MODEL` | No | Default OpenRouter model |
| `OPENROUTER_FALLBACK_MODELS` | No | Comma-separated fallback model ids |
| `IMAGE_GEN_MODEL` | No | Override Gemini image generation model |
| `VIDEO_GEN_MODEL` | No | Override Gemini video generation model |
| `MULTIMODAL_MODEL` | No | Override Gemini analysis model |

Priority: `process.env` > `cwd/.env` > `~/.multix/.env`.

## Commands

### `multix check`

Validate setup: tooling (ffmpeg, magick), API keys, Gemini live ping.

```
multix check [--verbose]
```

Exits 0 if at least one provider key is configured. Exits 1 if no keys found or Gemini auth fails.

### `multix gemini`

```bash
# Analyze files (images, video, audio, documents)
multix gemini analyze --files photo.jpg video.mp4 [--prompt <str>] [--model <id>] [--format text|json|csv|markdown] [--output <path>] [-v]

# Transcribe audio/video
multix gemini transcribe --files audio.mp3 [--prompt <str>] [--model <id>] [--format <fmt>] [-v]

# Extract structured information
multix gemini extract --files report.pdf --prompt "Extract tables as JSON" [--format json] [-v]

# Generate images
multix gemini generate --prompt "A mountain lake" [--model <id>] [--aspect-ratio 16:9] [--num-images 1] [--size 1K|2K|4K] [--output <path>] [-v]

# Generate video [EXPERIMENTAL — requires billing]
multix gemini generate-video --prompt "Ocean waves" [--model veo-3.1-generate-preview] [--resolution 720p|1080p] [--aspect-ratio 16:9] [--reference-images first.png last.png] [-v]

# Image-to-video with Veo (alias: i2v) [EXPERIMENTAL]
multix gemini image-to-video <imagePath> --prompt "camera pans left" [--last-frame <path>] [--model veo-3.1-generate-preview] [--resolution 1080p] [--aspect-ratio 16:9] [--output <path>] [-v]
```

**Gemini models:**
- Analysis: `gemini-2.5-flash` (default)
- Image gen: `gemini-3.1-flash-image-preview` (Nano Banana 2, fastest), `gemini-3-pro-image-preview` (4K text), `imagen-4.0-generate-001` (production)
- Video: `veo-3.1-generate-preview` (requires billing)

**Aspect ratios:** `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`

### `multix minimax`

```bash
# Generate image
multix minimax generate --prompt "A cat in space" [--model image-01] [--aspect-ratio 1:1] [--num-images 1] [-v]

# Generate video (async, polls until done)
multix minimax generate-video --prompt "A dancer" [--model MiniMax-Hailuo-2.3] [--duration 6|10] [--resolution 720P|1080P] [--first-frame <url>] [-v]

# Text-to-speech
multix minimax generate-speech (--text|--prompt) <str> [--model speech-2.8-hd] [--voice <id>] [--emotion neutral] [--output-format mp3|wav|flac|pcm] [-v]

# Music generation
multix minimax generate-music [--lyrics <str>] [--prompt <str>] [--model music-2.5] [--output-format mp3] [-v]
```

**MiniMax models:** `image-01`, `MiniMax-Hailuo-2.3`, `speech-2.8-hd`, `music-2.5` (and more — see `--help`)

### `multix openrouter`

```bash
multix openrouter generate --prompt "Retro robot" [--model google/gemini-3.1-flash-image-preview] [--aspect-ratio 1:1] [--image-size <sz>] [--num-images 1] [-v]

# Image-to-video (async — returns job id; image input is URL only)
multix openrouter image-to-video --prompt "camera pans left" --image-url https://... [--last-frame-url <url>] [--model google/veo-3.1] [--resolution 720p] [--aspect-ratio 16:9] [--duration <n>] [--seed <n>] [-v]
# alias: multix openrouter i2v --prompt "..." --image-url https://...

# Poll a video job (use --download to fetch when completed)
multix openrouter video-status <jobId> [--download] [--output <path>] [-v]

# List available video models
multix openrouter video-models
```

Fallback models from `OPENROUTER_FALLBACK_MODELS` (CSV) are appended to the chat-image payload automatically. Override the default video model with `OPENROUTER_VIDEO_MODEL` (default `google/veo-3.1`).

### `multix leonardo`

```bash
# Account info / remaining credits
multix leonardo me

# List image platform models
multix leonardo models [--limit <n>]

# List video models (static enum)
multix leonardo video-models

# Generate images (polls until COMPLETE, downloads to MULTIX_OUTPUT_DIR)
multix leonardo generate "a cyberpunk cat" [-m <modelId>] [-w 1024] [-h 1024] [-n 1] [--alchemy] [--ultra] [--style <uuid>] [--seed <n>] [--negative <text>] [--enhance] [--quality HIGH] [--output <path>] [--no-download] [--wait-timeout 480000] [-v]

# Generate text-to-video (async — returns generationId)
multix leonardo video "a dancer" [--model MOTION2|VEO3|kling-2.6|...] [--resolution RESOLUTION_720] [--enhance] [--frame-interpolation] [-v]

# Generate image-to-video (async — returns generationId)
multix leonardo image-to-video <imageId> --prompt "camera pans left" [--image-type GENERATED|UPLOADED] [--model MOTION2] [--resolution RESOLUTION_720] [--duration 6] [--seed <n>] [--negative <text>] [--enhance] [--frame-interpolation] [-v]
# alias: multix leonardo i2v <imageId> --prompt "..."

# Check a generation
multix leonardo status <generationId>

# Universal Upscaler (async)
multix leonardo upscale <generatedImageId> [--style GENERAL] [--strength 0.35] [--multiplier 1.5]
multix leonardo variation <variationId>
```

GPT Image models (`gpt-image-*`) and v2 video models (kling/hailuo/ltxv/seedance) are dispatched to Leonardo's `/api/rest/v2` endpoint automatically.

### `multix byteplus`

```bash
# Image generation (Seedream 4.0, sync)
multix byteplus generate --prompt "a cyberpunk cat" [--model seedream-4-0-250828] [--size 2K|1024x1024] [--aspect-ratio 16:9] [-n 1] [--seed <n>] [--no-watermark] [--input-image <path|url>] [--output <path>] [-v]

# Text-to-video (Seedance 2.0, async with auto-poll)
multix byteplus video --prompt "ocean waves" [--model seedance-2.0|seedance-2.0-fast|seedance-2.0-pro] [--resolution 1080p] [--duration 8] [--aspect-ratio 16:9] [--audio|--no-audio] [--seed <n>] [--negative <text>] [--camera-fixed] [--async] [--wait-timeout 600000] [--output <path>] [-v]

# Image-to-video (alias: i2v)
multix byteplus image-to-video <imagePath|url> --prompt "camera pans left" [--last-frame <path|url>] [--model ...] [video flags] [-v]
multix byteplus i2v ./photo.jpg --prompt "..."

# Reference-to-video (alias: r2v) — up to 9 images + 3 videos + 3 audio refs (total ≤12)
multix byteplus reference-to-video --prompt "..." \
  --ref-image ./hero.jpg:subject \
  --ref-image ./bg.jpg:environment \
  --ref-video ./style.mp4:style \
  --ref-audio ./music.mp3:audio \
  [video flags] [-v]
# On Windows, escape literal colons in paths with `\:` or use URLs.

# Poll a task / download MP4
multix byteplus status <taskId> [--wait] [--wait-timeout 600000] [--download] [--output <path>] [-v]
```

**BytePlus models:**
- Image: `seedream-4-0-250828`
- Video: `seedance-2.0-fast`, `seedance-2.0` (default), `seedance-2.0-pro`

**Notes:**
- Auth: `BYTEPLUS_API_KEY` is preferred; `ARK_API_KEY` is accepted as a fallback for compatibility with the Volcengine ARK SDK ecosystem.
- Video params can be encoded as flags inside the prompt text (default, e.g. `--rs 1080p --dur 8 --rt 16:9`) or as a top-level `parameters` object — set `BYTEPLUS_VIDEO_PARAMS_MODE=structured` to switch.
- **Task cancellation is not supported** — there is no verified DELETE endpoint on the ARK API. Submitted tasks must run to completion.

### `multix media`

Requires `ffmpeg` (video/audio) and `magick` (images) on PATH.

```bash
# Optimize single file
multix media optimize --input <file> --output <file> [--target-size <MB>] [--quality <n>] [--max-width <px>] [--bitrate <rate>] [--resolution <WxH>] [-v]

# Split video into chunks
multix media split --input <video> [--output-dir ./chunks] [--chunk-duration 3600] [-v]

# Batch optimize a directory
multix media batch --input-dir <dir> --output-dir <dir> [--quality 85] [--max-width 1920] [--bitrate 64k] [-v]
```

**Defaults:** quality=85, max-width=1920, bitrate=64k, chunk-duration=3600s.
**Video:** uses libx264 CRF encoding. Image optimization uses ImageMagick (replaces Pillow).

### `multix doc`

```bash
multix doc convert --input <files...> [--output <path>] [--auto-name] [--model gemini-2.5-flash] [--prompt <str>] [-v]
```

Converts PDFs, DOCX/XLSX/PPTX, images, and HTML/text files to Markdown via Gemini.
Multiple inputs are concatenated with `---` separators into a single output.

**Default output:** `./multix-output/document-extraction.md`

## Output

All generated files are saved to `./multix-output/` by default. Override with `MULTIX_OUTPUT_DIR`.

## Troubleshooting

**No API key found:** Run `multix check` — it prints setup instructions.

**ffmpeg not found:** Install per your OS:
- Linux: `sudo apt-get install ffmpeg`
- macOS: `brew install ffmpeg`
- Windows: https://ffmpeg.org/download.html

**magick not found:**
- Linux: `sudo apt-get install imagemagick`
- macOS: `brew install imagemagick`
- Windows: https://imagemagick.org/script/download.php

**Gemini free tier limitation:** Image/video generation requires billing. Enable at https://aistudio.google.com/apikey or use Google Cloud $300 free credits.

**MiniMax video times out:** Default timeout is 10 minutes. Long videos may take longer.

## Contributing

```bash
git clone https://github.com/mrgoonie/multix-cli
npm install
npm run build
npm test
```

## License

MIT — see [LICENSE](LICENSE).
