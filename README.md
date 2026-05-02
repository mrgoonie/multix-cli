# multix

AI multimodal CLI — generate images/video/speech/music, analyze and transcribe media files, convert documents to Markdown, and optimize media with ffmpeg/ImageMagick.

Supports **Gemini** (analyze, transcribe, generate, Veo video), **MiniMax** (image, video, speech, music), and **OpenRouter** (image generation).

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
```

Fallback models from `OPENROUTER_FALLBACK_MODELS` (CSV) are appended to the payload automatically.

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
