---
name: multix
description: AI multimodal CLI — Gemini/MiniMax/OpenRouter image & video generation, ffmpeg/ImageMagick media optimization, document-to-Markdown conversion via Gemini Files API.
version: 0.0.1
---

# multix — AI Multimodal CLI

## When to use

Activate this skill when the user asks to:
- Generate, analyze, or describe images or video
- Transcribe audio or video files
- Extract structured data from documents (PDF, DOCX, images)
- Convert documents to Markdown
- Optimize or split video/audio/image files
- Generate speech (TTS) or music

## Required env (at least one)

```
GEMINI_API_KEY       # Google AI Studio — required for analyze/transcribe/doc/generate
OPENROUTER_API_KEY   # OpenRouter — alternative image generation
MINIMAX_API_KEY      # MiniMax — image, video, speech, music generation
```

## Installation

```bash
npm install -g multix
# or run without installing:
npx multix --help
```

## Diagnostics

```bash
multix check            # verify keys, tooling, Gemini connectivity
multix check --verbose  # show install hints
```

## Command reference

### Gemini (analyze / generate)

```bash
# Analyze files
multix gemini analyze --files photo.jpg video.mp4 --prompt "Describe this content" -v

# Transcribe audio
multix gemini transcribe --files recording.mp3 --model gemini-2.5-flash

# Extract structured data
multix gemini extract --files report.pdf --prompt "Extract tables as JSON" --format json

# Generate images (Nano Banana — fastest)
multix gemini generate --prompt "A sunset over mountains" --aspect-ratio 16:9 --size 2K

# Generate images (Imagen 4 — production quality)
multix gemini generate --prompt "Product photo" --model imagen-4.0-ultra-generate-001 --num-images 4

# Generate video (Veo — EXPERIMENTAL, requires billing)
multix gemini generate-video --prompt "Ocean waves at sunset" --resolution 1080p
```

### MiniMax

```bash
# Generate image
multix minimax generate --prompt "A cat in space" --aspect-ratio 1:1

# Generate video (async, up to 10 min)
multix minimax generate-video --prompt "A dancer on stage" --duration 6 --resolution 1080P

# Text-to-speech
multix minimax generate-speech --text "Hello, world!" --voice English_expressive_narrator --output-format mp3

# Music generation
multix minimax generate-music --lyrics "Verse 1: Under the stars..." --model music-2.5
```

### OpenRouter

```bash
# Image generation via OpenRouter
multix openrouter generate --prompt "Retro robot mascot" --aspect-ratio 3:2
multix openrouter generate --prompt "Landscape" --model anthropic/claude-3-5-sonnet
```

### Media optimization

```bash
# Optimize single file
multix media optimize --input video.mp4 --output out.mp4 --target-size 100
multix media optimize --input audio.mp3 --output out.m4a --bitrate 64k
multix media optimize --input photo.jpg --output resized.jpg --max-width 1920

# Split long video into 1-hour chunks
multix media split --input long-video.mp4 --output-dir ./chunks --chunk-duration 3600

# Batch optimize a directory
multix media batch --input-dir ./raw --output-dir ./optimized --quality 85
```

### Document conversion

```bash
# Convert PDF to Markdown
multix doc convert --input document.pdf

# Auto-name output from input basename
multix doc convert --input report.pdf --auto-name
# Output: multix-output/report-extraction.md

# Custom output path
multix doc convert --input doc1.pdf doc2.docx --output ./combined.md
```

## Decision tree

```
User wants to generate image?
  ├── Has GEMINI_API_KEY? → multix gemini generate
  ├── Has OPENROUTER_API_KEY? → multix openrouter generate
  └── Has MINIMAX_API_KEY? → multix minimax generate

User wants to generate video?
  ├── Gemini/Veo (experimental, billing required) → multix gemini generate-video
  └── MiniMax Hailuo (reliable, async) → multix minimax generate-video

User wants to analyze/transcribe a file?
  └── multix gemini analyze|transcribe|extract --files <path>

User wants to convert document to Markdown?
  └── multix doc convert --input <file>

User wants to optimize media?
  └── multix media optimize|split|batch
```

## Environment variables (full list)

| Variable | Provider | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Gemini | Required for all Gemini operations |
| `OPENROUTER_API_KEY` | OpenRouter | Image generation via OpenRouter |
| `MINIMAX_API_KEY` | MiniMax | Image/video/speech/music generation |
| `MULTIX_OUTPUT_DIR` | Core | Override default output dir (`./multix-output`) |
| `OPENROUTER_IMAGE_MODEL` | OpenRouter | Default model override |
| `OPENROUTER_FALLBACK_MODELS` | OpenRouter | Comma-separated fallback model ids |
| `OPENROUTER_SITE_URL` | OpenRouter | HTTP-Referer header |
| `OPENROUTER_APP_NAME` | OpenRouter | X-Title header (default: multix) |
| `IMAGE_GEN_MODEL` | Gemini | Override default image generation model |
| `VIDEO_GEN_MODEL` | Gemini | Override default video generation model |
| `MULTIMODAL_MODEL` | Gemini | Override default analysis model |
| `MULTIX_DISABLE_HOME_ENV` | Core | Set to 1 to skip `~/.multix/.env` loading |
