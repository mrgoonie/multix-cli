# multix

AI multimodal CLI — generate images/video/speech/music, analyze and transcribe media files, convert documents to Markdown, and optimize media with ffmpeg/ImageMagick.

Supports **Gemini** (analyze, transcribe, generate, Veo video, Flash TTS), **MiniMax** (image, video, speech, music), **OpenRouter** (image generation), **Leonardo.Ai** (image, video, upscale), **BytePlus** (Seedream image, Seedance video, Hyper3D / Hitem3d 3D), and **ElevenLabs** (TTS, voice cloning, STT, voice changer, SFX, music, dubbing, isolation, alignment).

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
| `ELEVENLABS_API_KEY` | For ElevenLabs | [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) |
| `ARK_API_KEY` | No | Fallback for `BYTEPLUS_API_KEY` (Volcengine ARK shared name) |
| `BYTEPLUS_BASE_URL` | No | Override BytePlus base (default `https://ark.ap-southeast.bytepluses.com/api/v3`) |
| `BYTEPLUS_IMAGE_MODEL` | No | Default Seedream model (default `seedream-4-0-250828`) |
| `BYTEPLUS_VIDEO_MODEL` | No | Default Seedance model (default `seedance-2.0`) |
| `BYTEPLUS_VIDEO_PARAMS_MODE` | No | `flags` (default) or `structured` — how video params are encoded |
| `BYTEPLUS_3D_MODEL` | No | Default 3D model (default `hyper3d-gen2-260112`) |
| `MULTIX_OUTPUT_DIR` | No | Override default output dir (`./multix-output`) |
| `OPENROUTER_IMAGE_MODEL` | No | Default OpenRouter model |
| `OPENROUTER_FALLBACK_MODELS` | No | Comma-separated fallback model ids |
| `IMAGE_GEN_MODEL` | No | Override Gemini image generation model |
| `VIDEO_GEN_MODEL` | No | Override Gemini video generation model |
| `MULTIMODAL_MODEL` | No | Override Gemini analysis model |
| `GEMINI_TTS_MODEL` / `TTS_MODEL` | No | Override Gemini TTS model (default `gemini-3.1-flash-tts-preview`) |

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

# Image-to-image (Nano Banana — edit/compose from refs, alias: i2i)
multix gemini image-to-image --prompt "make it watercolor" --ref ./photo.jpg [--ref ./style.png] [--model gemini-2.5-flash-image] [--output <path>] [-v]

# Generate video [EXPERIMENTAL — requires billing]
multix gemini generate-video --prompt "Ocean waves" [--model veo-3.1-generate-preview] [--resolution 720p|1080p] [--aspect-ratio 16:9] [--reference-images first.png last.png] [-v]

# Image-to-video with Veo (alias: i2v) [EXPERIMENTAL]
multix gemini image-to-video <imagePath> --prompt "camera pans left" [--last-frame <path>] [--model veo-3.1-generate-preview] [--resolution 1080p] [--aspect-ratio 16:9] [--output <path>] [-v]

# Text-to-speech (Gemini 3.1 Flash TTS — single & multi-speaker)
multix gemini generate-speech (--text|--prompt) "Say cheerfully: Have a wonderful day!" [--model gemini-3.1-flash-tts-preview] [--voice Kore] [--output-format wav|pcm] [--output <path>] [-v]

# Multi-speaker (max 2): repeat --speaker name:voice; prompt should prefix lines with "<name>:"
multix gemini generate-speech --text "Joe: How's it going? Jane: Not too bad!" \
  --speaker Joe:Kore --speaker Jane:Puck
```

**Gemini models:**
- Analysis: `gemini-2.5-flash` (default)
- Image gen: `gemini-3.1-flash-image-preview` (Nano Banana 2, fastest), `gemini-3-pro-image-preview` (4K text), `imagen-4.0-generate-001` (production)
- Video: `veo-3.1-generate-preview` (requires billing)
- TTS: `gemini-3.1-flash-tts-preview` (default), `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`

**Aspect ratios:** `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`

**TTS voices (30 prebuilt):** Zephyr, Puck, Charon, Kore, Fenrir, Leda, Orus, Aoede, Callirrhoe, Autonoe, Enceladus, Iapetus, Umbriel, Algieba, Despina, Erinome, Algenib, Rasalgethi, Laomedeia, Achernar, Alnilam, Schedar, Gacrux, Pulcherrima, Achird, Zubenelgenubi, Vindemiatrix, Sadachbia, Sadaltager, Sulafat. Audio is PCM s16le @ 24 kHz mono — saved as WAV (default) or raw PCM. Style is controlled via natural language in the prompt (`[whispers]`, `Say excitedly:`, etc.). No streaming; max 2 speakers; ~32k token context.

### `multix minimax`

```bash
# Generate image
multix minimax generate --prompt "A cat in space" [--model image-01] [--aspect-ratio 1:1] [--num-images 1] [-v]

# Image-to-image (alias: i2i) — CAVEAT: subject_reference only, NOT free-form editing
# Preserves a character/subject's identity in a NEW scene described by --prompt.
multix minimax image-to-image --prompt "the same character on a beach" --ref ./hero.jpg [--model image-01] [-v]

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

# Image-to-image (alias: i2i) — refs accept URL or local path
multix openrouter image-to-image --prompt "make it cyberpunk" --ref ./photo.jpg [--ref https://...] [--model google/gemini-2.5-flash-image] [--output <path>] [-v]

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

# Image-to-image (alias: i2i) — uses an existing Leonardo image id as init image
# Direct upload from local path is not yet supported; pass an existing imageId.
multix leonardo image-to-image --prompt "make it watercolor" --ref <imageId> [--image-type GENERATED|UPLOADED] [--init-strength 0.5] [-m <modelId>] [-w 1024] [-h 1024] [-n 1] [--seed <n>] [--negative <text>] [--output <path>] [--no-download] [-v]

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

# Image-to-image (alias: i2i) — Seedream with one or more reference images
multix byteplus image-to-image --prompt "make it cyberpunk" --ref ./photo.jpg [--ref https://...] [--model seedream-4-0-250828] [--size 2K] [--aspect-ratio 16:9] [-n 1] [--seed <n>] [--no-watermark] [--output <path>] [-v]

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

# 3D model generation (alias: 3d) — Hyper3D / Hitem3d, async with auto-poll + download
multix byteplus generate-3d --prompt "Quadrupedal mech robot" \
  --flags "--mesh_mode Raw --hd_texture true --material PBR" \
  [--model hyper3d-gen2-260112] [--seed 8648] [--async] [--output model.glb] [-v]

# Image-to-3D (1–5 reference images, path or URL)
multix byteplus 3d --input-image ./front.png ./side.png ./back.png \
  --prompt "Generate from these views" [--model hyper3d-gen2-260112]

# Hitem3d uses different flags
multix byteplus 3d --input-image ./cat.png --model hitem3d-2-0-251223 \
  --flags "--ff 2 --resolution 1536pro"

# Poll a task / download MP4
multix byteplus status <taskId> [--wait] [--wait-timeout 600000] [--download] [--output <path>] [-v]
```

**BytePlus models:**
- Image: `seedream-4-0-250828`
- Video: `seedance-2.0-fast`, `seedance-2.0` (default), `seedance-2.0-pro`
- 3D: `hyper3d-gen2-260112` (Hyper3D Gen2, default — text-to-3D + image-to-3D), `hitem3d-2-0-251223` (Hitem3d 2.0 — image-to-3D)

**Notes:**
- Auth: `BYTEPLUS_API_KEY` is preferred; `ARK_API_KEY` is accepted as a fallback for compatibility with the Volcengine ARK SDK ecosystem.
- Video params can be encoded as flags inside the prompt text (default, e.g. `--rs 1080p --dur 8 --rt 16:9`) or as a top-level `parameters` object — set `BYTEPLUS_VIDEO_PARAMS_MODE=structured` to switch.
- 3D model knobs are passed via `--flags <raw>`, appended to the prompt text. Hyper3D supports `--mesh_mode`, `--hd_texture`, `--material`, `--addons`, `--quality_override`, `--use_original_alpha`, `--bbox_condition`, `--TAPose`. Hitem3d supports `--ff`, `--resolution`. See [BytePlus 3D docs](https://docs.byteplus.com/en/docs/ModelArk/2279947).
- 3D output is a textured model file (`.glb`/`.gltf`/`.zip` depending on flags). The CLI auto-detects the extension from the response URL.
- `multix byteplus status <taskId> --download` works for both video (`content.video_url`) and 3D (`content.file_url`) tasks.
- **Task cancellation is not supported** — there is no verified DELETE endpoint on the ARK API. Submitted tasks must run to completion.

### `multix elevenlabs`

```bash
# Text-to-speech (sync, returns audio bytes)
multix elevenlabs tts --text "Hello world" [--voice <voiceId>] [--model eleven_multilingual_v2] \
  [--format mp3_44100_128] [--stability 0.5] [--similarity-boost 0.75] [--style 0.0] \
  [--no-speaker-boost] [--language-code en] [--seed <n>] [--output out.mp3] [-v]

# Voices: list / get / search shared / design / persist / delete
multix elevenlabs voices list [--category cloned|generated|premade|professional]
multix elevenlabs voices get <voiceId>
multix elevenlabs voices search [--search "calm female"] [--language en] [--gender female] [--age young] [--accent american]
multix elevenlabs voices design --description "friendly female narrator" [--text "sample text"] [--auto-text]
multix elevenlabs voices create-from-preview --generated-voice-id <id> --name "My Voice" --description "..."
multix elevenlabs voices delete <voiceId>

# Instant voice cloning (multipart upload of 1-3 minutes of samples)
multix elevenlabs clone --name "My Voice" --files sample1.wav sample2.wav [--description "..."] [--remove-background-noise]

# Speech-to-speech voice changer
multix elevenlabs voice-changer --input source.mp3 --voice <voiceId> [--model eleven_multilingual_sts_v2] \
  [--format mp3_44100_128] [--remove-background-noise] [--output changed.mp3] [-v]

# Speech-to-text (Scribe)
multix elevenlabs transcribe --input audio.mp3 [--model scribe_v1] [--language en] [--diarize] \
  [--num-speakers 2] [--tag-audio-events] [--timestamps-granularity word] [--format text|json|srt|vtt] [--output out.txt]

# Sound effects
multix elevenlabs sfx --text "car engine starting" [--duration-seconds 5] [--prompt-influence 0.3] [--loop] \
  [--format mp3_44100_128] [--output sfx.mp3]

# Music generation
multix elevenlabs music --prompt "dreamy synthwave loop" [--music-length-ms 30000] [--model music_v1] \
  [--format mp3_44100_128] [--output song.mp3]
# OR with a structured composition plan
multix elevenlabs music --plan ./plan.json [--output song.mp3]

# Dubbing (async — submit and poll, then optionally --download)
multix elevenlabs dub --input video.mp4 --target-lang es [--source-lang en] [--num-speakers 2] \
  [--watermark] [--start-time 0] [--end-time 60] [--highest-resolution] [--name "My Dub"] \
  [--async] [--wait] [--download] [--poll-interval 10] [--wait-timeout 1800000] [--output dubbed.mp4]
multix elevenlabs dub-status <dubbingId> [--download <lang>] [--output dubbed.mp4]

# Voice isolator (strip background noise)
multix elevenlabs isolate --input noisy.mp3 [--output clean.mp3]

# Forced alignment (transcript ↔ audio timing)
multix elevenlabs align --input audio.mp3 --text "transcript here" [--output alignment.json]
# Or read transcript from file:
multix elevenlabs align --input audio.mp3 --text-file transcript.txt

# Account info / available models
multix elevenlabs account
multix elevenlabs models
```

**ElevenLabs models:**
- TTS: `eleven_multilingual_v2` (default), `eleven_flash_v2_5`, `eleven_flash_v2`, `eleven_turbo_v2_5`, `eleven_turbo_v2`, `eleven_v3`
- STT: `scribe_v1`, `scribe_v1_experimental`
- Voice changer: `eleven_multilingual_sts_v2` (default)
- Music: `music_v1`

**Recommended voices** (verified from ElevenLabs conversational voice design guide):
`Alexandra` `kdmDKE6EkgrWrrykO9Qt` (default), `Archer` `L0Dsvb3SLTyegXwtm47J`, `Jessica Anne Bogart` `g6xIsTj2HwM6VR4iXFCw`, `Hope` `OYTbf65OHHFELVut7v2H`, `Eryn` `dj3G1R1ilKoFKhBnWOzG`, `Stuart` `HDA9tsk27wYi3uq0fPcK`, `Mark` `1SM7GgM6IMuvQlz2BwM3`, `Angela` `PT4nqlKZfc06VW1BuClj`, `Finn` `vBKc2FfBKJfcZNyEt1n6`, `Cassidy` `56AoDkrOh6qfVPDXZ7Pt`, `Grandpa Spuds Oxley` `NOpBlnGInO9m6vDvFkFC`. Use `multix elevenlabs voices list` for the full library.

**Notes:**
- Auth header is `xi-api-key`; base URL is `https://api.elevenlabs.io/v1`.
- Most generation endpoints (TTS, SFX, Music, Voice Changer, Isolation) return audio bytes synchronously.
- Dubbing is async: submit → poll → download per-language tracks.
- Output format strings combine codec + sample rate + bitrate, e.g. `mp3_44100_128`, `pcm_24000`, `ulaw_8000`.

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

### Polling and downloading videos

Every video-generating subcommand accepts a uniform set of polling/download flags:

| Flag | Description |
|------|-------------|
| `--wait` | Poll the provider until the job reaches a terminal status (skip with the provider's `--async` flag where present). |
| `--wait-timeout <ms>` | Polling timeout (default `600000` = 10 min). |
| `--download` | Stream the resulting MP4 to disk on success — implies `--wait`. |
| `--output <path>` | Copy the saved MP4 to a custom path. The thumbnail is copied beside it as `<base>_thumb.<ext>`. |
| `--no-thumb` | Skip thumbnail download. |

Thumbnail detection is automatic: if the provider response includes any of `cover_image_url`, `thumbnail_url`, `thumb_url`, `preview_url`, `first_frame_url`, `poster_url`, or `image_url` (and the value is an `https://…(.jpg|.png|.webp|.gif|.bmp)` URL), the file is downloaded next to the video as `<basename>_thumb.<ext>`. Providers that don't expose a thumbnail simply skip this step.

`leonardo video`, `leonardo image-to-video`, and `openrouter image-to-video` are async-by-default for backward compatibility — pass `--wait` (or `--download`) to opt into the synchronous flow.

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
