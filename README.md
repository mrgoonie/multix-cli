# multix

AI multimodal CLI — generate images/video/speech/music, analyze and transcribe media files, convert documents to Markdown, and optimize media with ffmpeg/ImageMagick.

![Isometric technical illustration of multix media workflows](docs-site/public/images/multix-isometric-banner.png)

Supports **OpenAI** (image, image edits, TTS, STT, optional Codex image driver), **Gemini** (analyze, transcribe, generate, Omni Flash video generation and editing, Flash TTS), **MiniMax** (image, video, speech, music), **OpenRouter** (image generation), **Leonardo.Ai** (image, video, upscale), **BytePlus** (Seedream image, Seedance video, Hyper3D / Hitem3d 3D), **Cloudflare** (Workers AI image and speech; AI Gateway-routed Replicate video), **ElevenLabs** (TTS, voice cloning, STT, voice changer, SFX, music, dubbing, isolation, alignment), **fal.ai** (generic model runner, image, video, text-to-speech via the fal queue API), and **Atlas Cloud** (any model: image, image edit, video, audio, 3D, with resumable async predictions), **Replicate** (generic model runner, image, video, async prediction status/cancel via the direct Replicate API), **Runway** (Gen-4.5 and Gen-4 Turbo video, Gen-4 images, resumable task status/cancel), **HeyGen** (v3 Video Agent prompt-to-video, scripted avatar videos, video translation, lipsync, TTS).

## Documentation

Read the full command reference at [multix.zuey.me](https://multix.zuey.me).
Every page also has a same-path `.md` representation for AI agents; start with
[llms.txt](https://multix.zuey.me/llms.txt).

## Install

```bash
npm install -g @mrgoonie/multix
# or run without installing:
npx -p @mrgoonie/multix multix --help
```

**Requirements:** Node >= 20. For media commands: `ffmpeg` and `magick` (ImageMagick 7+) on PATH.

## Release channels

- `main` uses Release Please for stable releases. On a main push it creates and validates a release PR from conventional commits, merges it, tags `vX.Y.Z`, and publishes npm with dist-tag `latest`.
- `dev` uses Release Please for beta releases. It creates prerelease PRs like `vX.Y.Z-beta.N` from conventional commits and publishes npm with dist-tag `beta`.

## Quick start

```bash
# Check your setup
multix check

# Generate an image with Gemini
multix gemini generate --prompt "A sunset over mountains" --aspect-ratio 16:9

# Generate an image with OpenAI
multix openai generate --prompt "A clean product photo of a glass espresso cup"

# Analyze an image
multix gemini analyze --files photo.jpg --prompt "Describe this"

# Convert a PDF to Markdown
multix doc convert --input report.pdf

# Optimize a video to 100MB
multix media optimize --input video.mp4 --output out.mp4 --target-size 100
```

## For AI agents

Every command takes `--json` and `--dry-run`, and errors exit with a class code,
so an agent can find a model, validate a call for free, check its own result and
recover without trial and error:

```bash
multix guide                                  # the agent protocol in one screen
multix models --task video --ready            # which command and model serve a task, key set or not
multix fal image "a red fox" --dry-run --json # validate; show the request instead of sending it
multix fal image "a red fox" --json           # one-line multix.result/v1 envelope on stdout
multix history stats --by model               # runs, success rate, p50/p90 time, cost, credits, tokens
multix rerun last                             # repeat a recorded run
```

The envelope lists `outputs` (path, bytes, MIME, SHA-256, dimensions, duration),
`warnings`, `usage` as the provider reports it (tokens, `cost_usd`, `credits`,
metrics), `error` (`code`, `retryable`, `retry_after_s`, `hint`) and `next`
commands. With `--json`, exit codes are `2` usage or input, `3` key or setup,
`4` temporary (retry), `5` rejected (quota, safety, model), `6` timed out (job may
still run), `1` unknown; plain runs keep exit 1 and print the code and hint on
stderr. Each run is recorded in `~/.multix/history.jsonl` without keys or signed
URLs (`MULTIX_HISTORY=0` turns it off). Details:
[For AI agents](https://multix.zuey.me/reference/for-ai-agents/).

## Environment variables

Set at least one provider key. Add to `.env` in your project root or `~/.multix/.env`.

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | For Gemini | [AI Studio](https://aistudio.google.com/apikey) |
| `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, … | No | Extra Gemini keys for quota rotation (see below) |
| `OPENAI_API_KEY` | For OpenAI API | [OpenAI](https://platform.openai.com/api-keys) |
| `OPENROUTER_API_KEY` | For OpenRouter | [OpenRouter](https://openrouter.ai/settings/keys) |
| `MINIMAX_API_KEY` | For MiniMax | [MiniMax](https://platform.minimax.io/user-center/basic-information/interface-key) |
| `LEONARDO_API_KEY` | For Leonardo | [Leonardo](https://app.leonardo.ai/settings/api-keys) |
| `LEONARDO_BASE_URL` | No | Override Leonardo API base (default `https://cloud.leonardo.ai/api/rest/v1`) |
| `LEONARDO_DEFAULT_MODEL` | No | Default Leonardo image model UUID |
| `LEONARDO_VIDEO_MODEL` | No | Default Leonardo video model (default `MOTION2`) |
| `BYTEPLUS_API_KEY` | For BytePlus | [BytePlus](https://console.byteplus.com/auth/api-keys) |
| `ELEVENLABS_API_KEY` | For ElevenLabs | [ElevenLabs](https://elevenlabs.io/app/settings/api-keys) |
| `FAL_KEY` | For fal.ai | [fal.ai](https://fal.ai/dashboard/keys) |
| `FAL_BASE_URL` | No | Override fal queue base (default `https://queue.fal.run`) |
| `FAL_IMAGE_MODEL` | No | Default fal image model (default `fal-ai/flux/schnell`) |
| `FAL_VIDEO_MODEL` | No | Default fal text-to-video model (default `fal-ai/kling-video/v1.6/standard/text-to-video`) |
| `HEYGEN_API_KEY` | For HeyGen | [HeyGen API settings](https://app.heygen.com/developers/api). API usage is billed separately from HeyGen web plans |
| `HEYGEN_BASE_URL` | No | Override the HeyGen API base (default `https://api.heygen.com`; proxies/tests). Must be `https://`, except `http://` on `localhost`/`127.0.0.1`/`[::1]` |
| `FAL_TTS_MODEL` | No | Default fal text-to-speech model (default `google/gemini-3.8-flash-tts`) |
| `FAL_VIDEO_IMAGE_MODEL` | No | Default fal image-to-video model, used when `--image-url` is passed without `-m` (default `fal-ai/kling-video/v1.6/standard/image-to-video`) |
| `ATLASCLOUD_API_KEY` | For Atlas Cloud | [Atlas Cloud](https://www.atlascloud.ai/console/api-keys) |
| `ATLASCLOUD_BASE_URL` | No | Override Atlas Cloud media API base (default `https://api.atlascloud.ai/api/v1`; `https://` required, `http://` only for localhost) |
| `ATLASCLOUD_IMAGE_MODEL` / `ATLASCLOUD_IMAGE_EDIT_MODEL` | No | Atlas image defaults (`black-forest-labs/flux-schnell`, `openai/gpt-image-1-mini/edit`) |
| `ATLASCLOUD_VIDEO_MODEL` / `ATLASCLOUD_IMAGE_TO_VIDEO_MODEL` | No | Atlas video defaults (`bytedance/seedance-v1-pro-fast/text-to-video`, `.../image-to-video`) |
| `ATLASCLOUD_TTS_MODEL` / `ATLASCLOUD_STT_MODEL` | No | Atlas audio defaults (`xai/tts-v1`, `bytedance/seed-asr-2.0`) |
| `ATLASCLOUD_TEXT_TO_3D_MODEL` / `ATLASCLOUD_IMAGE_TO_3D_MODEL` | No | Atlas 3D defaults (`tencent/hunyuan3d-rapid/text-to-3d`, `.../image-to-3d`) |
| `FAL_MAX_UPLOAD_MB` | No | Size limit for local files uploaded by `fal upload` / `fal run --file` (default `1024`) |
| `ATLASCLOUD_MAX_UPLOAD_MB` | No | Size limit for local files uploaded to Atlas Cloud (default `200`) |
| `ARK_API_KEY` | No | Fallback for `BYTEPLUS_API_KEY` (Volcengine ARK shared name) |
| `BYTEPLUS_BASE_URL` | No | Override BytePlus base (default `https://ark.ap-southeast.bytepluses.com/api/v3`) |
| `BYTEPLUS_IMAGE_MODEL` | No | Default Seedream model (default `seedream-4-0-250828`) |
| `BYTEPLUS_VIDEO_MODEL` | No | Default Seedance model (default `seedance-2.0`) |
| `BYTEPLUS_VIDEO_PARAMS_MODE` | No | `flags` (default) or `structured` — how video params are encoded |
| `BYTEPLUS_3D_MODEL` | No | Default 3D model (default `hyper3d-gen2-260112`) |
| `CLOUDFLARE_ACCOUNT_ID` | For Cloudflare media | Cloudflare account ID for Workers AI and AI Gateway |
| `CLOUDFLARE_API_TOKEN` | For Cloudflare media | Cloudflare API token for Workers AI and AI Gateway |
| `CLOUDFLARE_AI_GATEWAY_ID` | Video only | AI Gateway ID; optional for Workers AI image/speech, required for video |
| `CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD` | No | Set to `true` to explicitly opt in to AI Gateway request-payload collection; defaults to `false` |
| `REPLICATE_API_TOKEN` | For Replicate / Cloudflare video | [Replicate](https://replicate.com/account/api-tokens) token for `multix replicate`; also used by Cloudflare AI Gateway video |
| `REPLICATE_API_KEY` | No | Fallback for `REPLICATE_API_TOKEN` (direct `multix replicate` only) |
| `REPLICATE_BASE_URL` | No | Override Replicate API root (default `https://api.replicate.com/v1`) |
| `REPLICATE_IMAGE_MODEL` | No | Default `multix replicate image` model (default `black-forest-labs/flux-schnell`) |
| `REPLICATE_VIDEO_MODEL` | No | Default `multix replicate video` model (default `prunaai/p-video`) |
| `RUNWAYML_API_SECRET` | For Runway | [Runway](https://dev.runwayml.com/) API secret for `multix runway` |
| `RUNWAY_BASE_URL` | No | Override Runway API root (default `https://api.dev.runwayml.com`) |
| `RUNWAY_VIDEO_MODEL` | No | Default `multix runway video` model (default `gen4.5`) |
| `RUNWAY_IMAGE_MODEL` | No | Default `multix runway image` model (default `gen4_image`) |
| `CLOUDFLARE_AI_IMAGE_MODEL` | No | Image model setting; only `@cf/black-forest-labs/flux-1-schnell` is accepted |
| `CLOUDFLARE_AI_TTS_MODEL` | No | Speech model setting; only `@cf/myshell-ai/melotts` is accepted |
| `MULTIX_OUTPUT_DIR` | No | Override default output dir (`./multix-output`) |
| `MULTIX_MAX_DOWNLOAD_MB` | No | Size limit per downloaded Replicate, Runway or Atlas Cloud output file (default `2048`) |
| `MULTIX_UPLOAD_MIN_KBPS` | No | Slowest upload speed to allow for (Gemini Files API, Runway requests with inline images), in KB/s (default `1000`); lower it on slow links |
| `MULTIX_IMAGE_FORMAT` | No | `webp` (default) or `original` to keep provider image format/quality |
| `MULTIX_OUTPUT` | No | `json` prints one `multix.result/v1` envelope per run, as `--json` does |
| `MULTIX_HISTORY` | No | `0` stops recording runs in `~/.multix/history.jsonl` |
| `MULTIX_HISTORY_FILE` | No | Run ledger path (shell or `~/.multix/.env` only) |
| `OPENROUTER_IMAGE_MODEL` | No | Default OpenRouter model |
| `OPENROUTER_FALLBACK_MODELS` | No | Comma-separated fallback model ids |
| `OPENAI_IMAGE_MODEL` | No | Default OpenAI image model (default `gpt-image-2`) |
| `OPENAI_TTS_MODEL` | No | Default OpenAI TTS model (default `gpt-4o-mini-tts`) |
| `OPENAI_STT_MODEL` | No | Default OpenAI STT model (default `gpt-4o-transcribe`) |
| `IMAGE_GEN_MODEL` | No | Override Gemini image generation model |
| `VIDEO_GEN_MODEL` | No | Override Gemini video generation model (default `gemini-omni-1.1-flash`; `veo-*` selects the legacy Veo path) |
| `GEMINI_MODEL` / `MULTIMODAL_MODEL` | No | Override Gemini analyze/transcribe/extract model (doc convert uses `--model`; default `gemini-3.6-flash`) |
| `GEMINI_TTS_MODEL` / `TTS_MODEL` | No | Override Gemini TTS model (default `gemini-3.8-flash-lite-tts`) |

### Gemini key rotation

Set extra keys as `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, … (any numeric suffix; numbered keys alone are enough). `multix` tries `GEMINI_API_KEY` first, then the numbered keys in ascending order, skipping duplicates. When a key returns HTTP 429 (or 400/403 with `RESOURCE_EXHAUSTED`), it cools down for the server's `Retry-After`/`retryDelay` (default 60s) and the same request is retried with the next ready key; other errors are not rotated. A Files API upload is repeated on the new key if the following generate call is rate-limited. Video generation (Omni and Veo) rotates on submit only, so a rate limit while polling or downloading never starts a second billed job; the key that accepted the request is kept for polling and download, `edit-video`/`extend-video`/`video-status` use the key whose project holds the interaction, and a network failure on submit is not retried because the request may already be billed. `doc convert` stops its own retries on a rate limit. Cooldowns last for the current process only, and logs name the env var, never the key. `multix check` lists the keys in rotation and pings each one. Quotas are per Google Cloud project: keys from the same project share one quota, so rotation only helps across projects.

Priority: `process.env` > `cwd/.env` > `~/.multix/.env`. A blank or whitespace-only value in a `.env` file does not count as set, so a project `.env` copied from `.env.example` does not hide `~/.multix/.env`; a shell variable wins even when blank. Set `MULTIX_LEGACY_CLAUDE_ENV=1` (shell or `~/.multix/.env`) to also read legacy AgentKit files (`.claude/skills/{ai-multimodal,ak-ai-multimodal}/.env`, `.claude/skills/.env`, `.claude/.env`, project first, then home) with the lowest priority (credential names only, never endpoint/proxy settings); `multix check -v` lists the env files that were loaded.

A project `.env` may only set variables `multix` reads: provider keys, the provider settings in `.env.example` (`*_BASE_URL`, model overrides, Cloudflare IDs), the documented `MULTIX_*` settings (`MULTIX_OUTPUT_DIR`, so a project can choose where outputs go, `MULTIX_IMAGE_FORMAT`, `MULTIX_MAX_DOWNLOAD_MB`, `MULTIX_UPLOAD_MIN_KBPS`, `MULTIX_OUTPUT`, `MULTIX_HISTORY`) and `NO_COLOR`. The opt-ins `MULTIX_ALLOW_PROJECT_BASE_URL` and `MULTIX_LEGACY_CLAUDE_ENV`, and `MULTIX_HISTORY_FILE`, are refused there; set them in the shell or `~/.multix/.env`. Other names, such as `NODE_OPTIONS`, `npm_config_registry`, `LD_PRELOAD` or `HTTPS_PROXY`, are not loaded, so they never reach `multix` or the tools it starts (`npm` in `multix update`, ffmpeg, ImageMagick, cwebp); one warning on stderr lists the ignored names, never their values. The shell and `~/.multix/.env` are not filtered.

`*_BASE_URL`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID` decide where your API key is sent. Values from the shell or `~/.multix/.env` are always used. A value from the project `.env` (or a legacy `.claude` file under it) is used only when every key the provider sends with it comes from that same project file (the repository's own key). That protects your key, not your data: a project `.env` that ships its own key and base URL routes that project's requests, including your prompts and any files you upload, to that host, and its key replaces yours from `~/.multix/.env`, so review a cloned repository's `.env` before running `multix` in it. If a key comes from anywhere else, the project value is ignored: the `~/.multix/.env` value is used with a warning (variable, file and key source named, never the value), or, if there is none, the command stops with an error instead of falling back to the vendor default. `multix check` shows whether each such setting is in effect or ignored. To use a project value for one command, run `MULTIX_ALLOW_PROJECT_BASE_URL=1 multix ...`; do not put the opt-in in `~/.multix/.env`, which disables the check for every directory. Non-default base URLs must be `https://` (plain `http://` only for `localhost`, `127.0.0.1`, `[::1]`), and `multix` warns once per variable on stderr with the provider and hostname only.
## Commands

### `multix check`

Validate setup: tooling (ffmpeg, magick), API keys, Gemini live ping, and experimental authenticated Codex image capability. Codex is checked when no API key is configured, or in `--verbose` mode.

```
multix check [--verbose]
```

Exits 0 if at least one provider key is configured, or authenticated Codex image capability is available. Exits 1 if no provider is usable or Gemini auth fails.

### `multix update`

Update the CLI itself to the latest (or a given dist-tag) version published on npm.

```
multix update [--check] [--tag <tag>] [--dry-run] [-v]
```

- Detects how `multix` was installed (npm, pnpm, yarn, or bun global) from the running binary's path and runs the matching global-install command, e.g. `npm i -g @mrgoonie/multix@latest`.
- `--check` only compares the current version against the npm registry; it never installs.
- `--tag <tag>` installs a dist-tag such as `beta` instead of `latest`. Passing `--tag` always installs the requested tag, skipping the "already up to date" comparison that applies to the default `latest` flow.
- `--dry-run` prints the install command instead of running it.

### `multix gemini`

```bash
# Analyze files (images, video, audio, documents)
multix gemini analyze --files photo.jpg video.mp4 [--prompt <str>] [--model <id>] [--format text|json|csv|markdown] [--output <path>] [-v]

# Transcribe audio/video
multix gemini transcribe --files audio.mp3 [--prompt <str>] [--model <id>] [--format <fmt>] [-v]

# Extract structured information
multix gemini extract --files report.pdf --prompt "Extract tables as JSON" [--format json] [-v]

# Read piped stdin with "-" (type auto-detected, else pass --stdin-ext; max 2 GB; labelled <stdin>)
cat photo.png | multix gemini analyze --files - --prompt "Describe this"

# Generate images
multix gemini generate --prompt "A mountain lake" [--model <id>] [--aspect-ratio 16:9] [--num-images 1] [--size 1K|2K|4K] [--output <path>] [-v]

# Image-to-image (Nano Banana — edit/compose from refs, alias: i2i)
multix gemini image-to-image --prompt "make it watercolor" --ref ./photo.jpg [--ref ./style.png] [--model gemini-2.5-flash-image] [--output <path>] [-v]

# Generate video with Gemini Omni Flash (default; requires a billing-enabled key)
multix gemini generate-video --prompt "Ocean waves" [--model gemini-omni-1.1-flash|veo-*] [--resolution 360p|720p|1080p|4k] [--aspect-ratio 16:9|9:16] [--duration 3-10] [--reference-images first.png [last.png | more subject refs...]] [--no-store] [--no-wait] [--wait-timeout <ms>] [--output <path>] [-v]

# Image-to-video (alias: i2v); --last-frame interpolates between two frames
multix gemini image-to-video <imagePath> --prompt "camera pans left" [--last-frame <path>] [--resolution 720p] [--aspect-ratio 16:9] [--duration 3-10] [--no-wait] [--output <path>] [-v]

# Edit or extend a stored Omni interaction, or an uploaded local clip (at most 10 s)
multix gemini edit-video --prompt "make it night time" (--interaction-id <id> | --video ./clip.mp4) [--reference-images ...] [--resolution ...] [--aspect-ratio ...] [--no-store] [--no-wait] [--output <path>]
multix gemini extend-video --prompt "the camera follows the ball out the door" --interaction-id <id> [--duration 3-10] [--output <path>]

# Check, resume or cancel an Omni interaction (JSON on stdout, logs on stderr)
multix gemini video-status <interactionId> [--wait] [--download] [--output <path>] [--wait-timeout <ms>]
multix gemini video-cancel <interactionId>

# Text-to-speech (Gemini 3.1 Flash TTS — single & multi-speaker)
multix gemini generate-speech (--text|--prompt) "Have a wonderful day!" [--model gemini-3.8-flash-lite-tts] [--voice Kore] [--style "cheerful and friendly"] [--output-format wav|pcm] [--output <path>] [-v]

# Multi-speaker (max 2): repeat --speaker name:voice; prompt should prefix lines with "<name>:"
multix gemini generate-speech --text "Joe: How's it going? Jane: Not too bad!" \
  --speaker Joe:Kore --speaker Jane:Puck
```

**Gemini models:**
- Text output (analyze, transcribe, extract, doc convert): `gemini-3.6-flash` (default), `gemini-3.5-flash` (manual override)
- Image gen: `gemini-3.1-flash-image-preview` (Nano Banana 2, fastest), `gemini-3-pro-image-preview` (4K text), `imagen-4.0-generate-001` (production)
- Video: `gemini-omni-1.1-flash` (default, Interactions API, requires billing). Legacy `veo-*` models still run with an explicit `--model`; see [Gemini video migration](#gemini-video-migration-veo-to-omni-flash).
- TTS: `gemini-3.8-flash-lite-tts` (default, fast/cheap, 101 languages), `gemini-3.8-flash-tts` (highest fidelity, 130 languages), legacy `gemini-3.1-flash-tts-preview`, `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts`. Gemini 3.8 models use the Interactions API, read the text verbatim, take delivery direction via `--style`, and also accept custom `voice_…`/`voicekey_…` voice ids.

`gemini-3.6-flash` is a text-output model. Use Nano Banana/Imagen for images, Gemini Omni Flash for video, and Gemini Flash TTS for speech.

#### Gemini video migration (Veo to Omni Flash)

Google shuts the Veo 3.1 preview models down on the Gemini API on 2026-10-22 (the Veo 3.0 models already shut down on 2026-06-30), so `generate-video` and `image-to-video` now default to Gemini Omni Flash (`gemini-omni-1.1-flash`). `gemini-omni-flash-preview` shuts down on the same date; use the GA id.

```bash
# Before: Veo, 1080p by default
multix gemini generate-video --prompt "Ocean waves" --model veo-3.1-generate-preview --resolution 1080p
# After: Omni Flash, 720p by default; 360p|720p|1080p|4k and 3-10 s
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p --duration 8
```

- An explicit `--model veo-*` (or `VIDEO_GEN_MODEL=veo-*`) still uses the Veo path, with a shutdown warning for `*-preview` models. Omni-only flags (`--duration`, `--no-store`, `--no-wait`) fail with Veo; `--no-thumb` applies to Veo only. Any other model id is rejected.
- Omni runs as a stored background interaction. Its id is written to `gemini_omni_<timestamp>-<random>.json` in the output directory before polling starts, so a timeout or crash can be resumed with `multix gemini video-status <id> --download`. On success stdout prints `Generated video: <path>` and `Interaction ID: <id>`.
- `--no-store` sends one synchronous request that Google does not keep: it cannot be edited, extended or resumed, and it cannot be combined with `--no-wait`.
- `edit-video` and `extend-video` keep the source video's format unless `--resolution`/`--aspect-ratio` is given; only a completed interaction can be continued. `extend-video` returns the source clip followed by the continuation. Editing or extending an uploaded `--video` is unavailable in the EEA, Switzerland and the UK; editing a generated video with `--interaction-id` works there.
- Stored interactions and uploaded files expire (Files API uploads after about 48 hours). `--upload-timeout` is deprecated and ignored.
- Paid tier only. The session record holds a cost estimate from the reported token usage (video output $17.50, input $1.50, text/thought output $9 per 1M tokens; roughly $0.10 per second at 720p); the bill is what Google reports.

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
multix openrouter image-to-image --prompt "make it cyberpunk" --ref ./photo.jpg [--ref https://...] [--model google/gemini-2.5-flash-image] [--strength 0.7] [--output <path>] [-v]

# Image-to-video (async — returns job id; image input is URL only)
multix openrouter image-to-video --prompt "camera pans left" --image-url https://... [--last-frame-url <url>] [--model google/veo-3.1] [--resolution 720p] [--aspect-ratio 16:9] [--duration <n>] [--seed <n>] [-v]
# alias: multix openrouter i2v --prompt "..." --image-url https://...

# Poll a video job (use --download to fetch when completed)
multix openrouter video-status <jobId> [--download] [--output <path>] [-v]

# List available video models
multix openrouter video-models
```

**Supported i2i model families:** Gemini (default) and OpenAI gpt-image return `text+image` (modalities `["image","text"]`); Recraft accepts `--strength` (init-image strength 0..1); Flux / Sourceful are image-only (`["image"]`). The CLI picks the right `modalities` automatically based on the model id prefix.

Fallback models from `OPENROUTER_FALLBACK_MODELS` (CSV) are appended to the chat-image payload automatically — applies to both `generate` and `image-to-image`. Override the default video model with `OPENROUTER_VIDEO_MODEL` (default `google/veo-3.1`).

### `multix openai`

```bash
# Image generation via OpenAI Images API
multix openai generate --prompt "A product photo of a titanium travel mug" \
  [--model gpt-image-2] [--size 1024x1024] [--quality medium] [--format png] [--num-images 1] [--output <path>] [-v]

# Use authenticated Codex CLI as an experimental image driver.
# Requires manual `codex` login outside multix.
multix openai generate --prompt "A poster for a midnight jazz club" --driver codex --output poster.png

# Auto chooses OpenAI API when OPENAI_API_KEY exists, otherwise tries authenticated Codex.
multix openai generate --prompt "Editorial portrait lighting" --driver auto

# Image-to-image edits with one or more local/URL refs
multix openai image-to-image --prompt "turn this into a watercolor travel sketch" --ref ./photo.jpg [--ref https://...] [--output sketch.png]

# Text-to-speech
multix openai generate-speech --text "Welcome to multix." [--voice alloy] [--output-format mp3|wav|aac|flac|opus|pcm] [--output speech.mp3]

# Speech-to-text
multix openai transcribe --input meeting.mp3 [--format text|json|diarized_json] [--language vi]

# Known speaker refs must be paired by name and reference audio path/URL.
multix openai transcribe --input call.mp3 --format json \
  --known-speaker-name Alice --known-speaker-reference ./alice.wav \
  --known-speaker-name Bob --known-speaker-reference ./bob.wav
```

**OpenAI models:** image `gpt-image-2` (default), TTS `gpt-4o-mini-tts` (default), STT `gpt-4o-transcribe` (default). The Codex driver is experimental and only handles image generation; `multix` does not authenticate Codex for you.

**OpenAI STT format behavior:**

| CLI format | Non-diarize GPT transcription models | Diarize model |
|---|---|---|
| `text` | Requests JSON from API, writes returned `text` | Requests JSON from API, writes returned `text` |
| `json` | Requests JSON | Requests JSON |
| `diarized_json` | Not supported | Requires `gpt-4o-transcribe-diarize` and defaults `chunking_strategy=auto` |

Known-speaker diarization uses paired `--known-speaker-name` and `--known-speaker-reference` flags; names and references must have the same count.

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

### `multix cloudflare`

Cloudflare image and speech use [Workers AI's REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Supplying `CLOUDFLARE_AI_GATEWAY_ID` optionally routes those Workers AI calls through AI Gateway. The CLI supports only the fixed models below; it does not expose the arbitrary Workers AI catalog.

```bash
# Image generation: Workers AI FLUX.1 Schnell (sync)
multix cloudflare generate --prompt "a cyberpunk cat" \
  [--model @cf/black-forest-labs/flux-1-schnell] [--steps 1-8] [--seed <n>] [--output <path>] [-v]

# Text-to-speech: Workers AI MeloTTS (sync, saves MP3)
multix cloudflare generate-speech --text "Hello world" \
  [--lang <code>] [--model @cf/myshell-ai/melotts] [--output <path>] [-v]

# Video: Replicate prunaai/p-video prediction through Cloudflare AI Gateway (async by default)
multix cloudflare generate-video --prompt "Ocean waves" \
  [--duration 5] [--aspect-ratio 16:9] [--resolution 720p] [--fps 24] \
  [--wait] [--wait-timeout 600000] [--download] [--output <path>] [-v]

# Inspect, wait for, or download a video prediction
multix cloudflare video-status <predictionId> \
  [--wait] [--wait-timeout 600000] [--download] [--output <path>] [-v]
```

Video requires all four variables: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_AI_GATEWAY_ID`, and `REPLICATE_API_TOKEN`. It uses Cloudflare's documented [Replicate AI Gateway route](https://developers.cloudflare.com/ai-gateway/usage/providers/replicate/), not a native Workers AI video model.

Without `--wait` or `--download`, `generate-video` prints the prediction ID so it can be checked with `video-status`. `--download` implies `--wait`; on `generate-video`, either flag waits for success and saves the MP4. On `video-status`, `--wait` only reports the terminal status, while `--download` waits and saves the MP4. These commands print local paths and status/IDs, never the provider output URL.

Set `CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` only to explicitly opt in to request-payload collection by AI Gateway; it defaults to `false`. This controls the gateway request header, not multix CLI logging: the CLI does not log credential values or provider output URLs.

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

### `multix fal`

Generic runner plus convenience commands for [fal.ai](https://fal.ai)'s queue REST API. Any model id works with `run`; `image`/`video` set sensible defaults and download media automatically.

```bash
# Generic runner — works with any fal model id
multix fal run fal-ai/flux/schnell --input '{"prompt":"a cyberpunk cat"}' [--no-download] [--wait-timeout 480000] [-v]
multix fal run fal-ai/flux/schnell --input @input.json

# Local media: upload to fal storage and set the URL at an input field
multix fal run fal-ai/mmaudio-v2 --input '{"prompt":"soft rain"}' --file video_url=./shot.mp4
multix fal upload ./shot.mp4                   # prints {"url","mime_type","size_bytes","file_name"}

# Submit without waiting; prints a receipt with status/result commands
multix fal run fal-ai/hunyuan-video-foley --input '{"text_prompt":"footsteps"}' --file video_url=./shot.mp4 --detach

# Text-to-image (default model: fal-ai/flux/schnell)
multix fal image "a cyberpunk cat" [-m <model>] [--image-size square_hd] [-n 1] [--seed <n>] [--negative-prompt <text>] [--output <path>] [--no-download] [-v]

# Text-to-video (default model: fal-ai/kling-video/v1.6/standard/text-to-video),
# or image-to-video with --image-url (default model: fal-ai/kling-video/v1.6/standard/image-to-video).
# Without -m, the default model switches automatically based on whether --image-url is passed.
multix fal video "a dancer under neon lights" [-m <model>] [--image-url <https-url>] [--duration <n>] [--aspect-ratio 16:9] [--seed <n>] [--no-download] [--wait-timeout 900000] [-v]

# Queue status / result for a request submitted any other way
# Text-to-speech with per-model typed inputs (default model: google/gemini-3.8-flash-tts)
multix fal tts "Xin chào" [--text-file <path>] [-m <model>] [--voice <name>] [--style <text>] [--format <fmt>] [--language <code>] [--input <json>] [--detach]
multix fal voices [<model>] [--live]           # models, voices, formats; one model prints typed inputs as JSON

multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download] [--output-dir <dir>] [--format <fmt>]   # --format: raw speech formats (pcm_*, ulaw_8000, alaw_8000)
```

**Notes:**
- Auth header is `Authorization: Key $FAL_KEY`; base URL is `https://queue.fal.run`.
- All fal jobs are async: submit → poll `status` → fetch `result`. `run`/`image`/`video` do this automatically.
- `--detach` saves a receipt (`~/.multix/fal/requests/<request_id>.json`, or `--receipt <path>`, which also works for a blocking run; mode 0600, ids and an input hash only). `status`/`result` only read, so resuming never pays twice. A submit whose outcome is unknown (connection cut off, 5xx gateway error) fails with `UNKNOWN_REMOTE_STATE` and is never retried.
- `tts` maps flags to each model's schema (Gemini 3.8 Flash / Flash-Lite TTS: `prompt`, `voice`, `style_instructions`; ElevenLabs v4 / v4 Turbo: `text`, `voice`, `output_format`, `language_code`) and refuses a flag the model has no field for. Other fal TTS ids need `--text-field` (and `--voice-field`). Audio is saved under the extension its bytes have (raw `pcm_*`/`ulaw_8000`/`alaw_8000` from the requested format); empty, error-page or mislabelled downloads are refused.
- `--file` / `fal upload` accept image, video and audio files only (up to `FAL_MAX_UPLOAD_MB`, default 1024). fal storage URLs are public to anyone with the link and fal controls retention; the key goes only to `https://rest.fal.ai`, never to the pre-signed upload URL.
- Media URLs are extracted generically from the result JSON (any `url` field, recursively) and downloaded to `MULTIX_OUTPUT_DIR`.

### `multix atlas`

Image, image-edit, video, audio and 3D generation through [Atlas Cloud](https://www.atlascloud.ai)'s prediction API, plus a generic runner for any Atlas model. `atlascloud` is an alias for the group.

```bash
# Image (default black-forest-labs/flux-schnell) and image edit (default openai/gpt-image-1-mini/edit)
multix atlas image "a red fox in the snow" [-m <model>] [--size <size>] [--aspect-ratio 1:1] [--resolution 2k] [-n 1] [--seed <n>] [--negative-prompt <text>]
multix atlas image-to-image --prompt "make it dusk" --ref ./photo.png [--ref https://...] [-m <model>]

# Video (defaults bytedance/seedance-v1-pro-fast/text-to-video and .../image-to-video)
multix atlas video "waves at sunset" [-m <model>] [--duration <s>] [--resolution 720p] [--aspect-ratio 16:9]
multix atlas image-to-video --ref ./first-frame.png [--prompt "slow pan"]

# Audio: TTS (default xai/tts-v1), or STT with --audio (default bytedance/seed-asr-2.0; transcript printed)
multix atlas audio "Hello from multix" [--voice <id>] [--format mp3]
multix atlas audio --audio ./meeting.mp3 [--output transcript.txt]

# 3D (defaults tencent/hunyuan3d-rapid/text-to-3d, or .../image-to-3d with --ref)
multix atlas 3d "a low-poly treasure chest" [--format GLB]

# Any model, raw JSON input (fields per the model's docs; `model` is added for you)
multix atlas run <modelId> --input '{"prompt":"a cat"}' [--type image|video|audio]

# Async: submit now, resume later
multix atlas image "a paper boat" --async        # prints the prediction id
multix atlas status <predictionId> [--wait] [--download] [--output <path>]

# Upload a local file and print its temporary URL
multix atlas upload ./photo.png
```

**Notes:**
- Auth is `Authorization: Bearer $ATLASCLOUD_API_KEY`; the media API base is `https://api.atlascloud.ai/api/v1`. An `ATLASCLOUD_BASE_URL` override must use `https://`; plain `http://` is accepted only for `localhost`, `127.0.0.1` or `[::1]`.
- Generation commands and `run` accept `--async`, `--wait-timeout <ms>`, `--output <path>`, `--no-download` and `--no-validate`. By default the command waits, then downloads to `MULTIX_OUTPUT_DIR` (or a directory `--output`) as `atlas-<prediction id>-NN.<ext>`. These names are fixed per output, so a retry with `multix atlas status <id> --wait --download` keeps the files already saved (whatever their extension, e.g. after WebP conversion) and downloads only the missing ones. An explicit single-file `--output` is overwritten as asked; the `<name>-NN.<ext>` files from a multi-output `--output` never overwrite an existing file (a `-1`, `-2`, ... suffix is added). A `.part` file reserves a name while it downloads, so a concurrent run of the same output stops with an error instead of writing it twice; a `.part` left by a run that stopped (Ctrl+C, crash) is taken over automatically on the next run.
- Output and thumbnail downloads use `https://` only and refuse `localhost` and loopback, private, link-local, or other special-purpose IP literals (hostnames are not resolved), including on redirects. Inline `data:` outputs are still saved. Each file is capped at `MULTIX_MAX_DOWNLOAD_MB` (default 2048). A video thumbnail is taken only from the prediction's outputs, never from echoed request input such as a reference image.
- Inputs are model-specific. multix reads each model's published schema, maps flags onto that model's field names, and rejects unsupported flags or invalid values before submitting. Use `--no-validate` to skip this check.
- `--async` prints only the prediction id on stdout and `upload` prints only the URL; progress goes to stderr, so `id=$(multix atlas video "waves" --async)` works.
- `--ref` takes one value per flag; repeat it for several references. Local `--ref` / `--audio` files are uploaded first: only image, video and audio files, up to 200 MB (`ATLASCLOUD_MAX_UPLOAD_MB`).
- Text outputs (transcripts, lyrics) are printed instead of downloaded. A failed prediction, or a download where some outputs fail, exits non-zero with the resume command (including your `--output`). Atlas Cloud has no cancel endpoint.
- `run --no-validate` skips the schema, so pass `--type` with it.

### `multix replicate`

Direct [Replicate](https://replicate.com) API provider (independent of the Cloudflare AI Gateway route). `run` accepts any model; `image`/`video` set defaults; every job can be resumed or canceled by prediction ID.

```bash
# Generic runner — official models (owner/name) use the model endpoint;
# owner/name:version, a bare version id, or --version use POST /predictions.
multix replicate run black-forest-labs/flux-schnell --input '{"prompt":"a cyberpunk cat"}'
multix replicate run owner/model:<version-id> --input @payload.json [--file image=./photo.png]

# Text-to-image (default model: black-forest-labs/flux-schnell)
multix replicate image "a futuristic city" [-m <owner/name>] [--aspect-ratio 16:9] [-n 1] [--seed <n>] [--output-format webp|jpg|png] [--input <json>] [--output <path>]

# Text-to-video, or image-to-video with --image (default model: prunaai/p-video)
multix replicate video "a cinematic establishing shot" [-m <owner/name>] [--image <path|url>] [--duration 5] [--aspect-ratio 16:9] [--resolution 720p] [--input '{"draft":true}']

# Shared flags: [--async] [--wait] [--prefer-wait [seconds]] [--wait-timeout <ms>] [--no-download] [--output <path>] [-v]

# Resume or cancel a prediction by id without re-running inference
multix replicate status <prediction-id> [--wait] [--download] [--output <path>]
multix replicate cancel <prediction-id>
```

**Notes:**
- Auth: `Authorization: Bearer $REPLICATE_API_TOKEN` (`REPLICATE_API_KEY` accepted as fallback).
- Default behavior waits with bounded polling; `--async` prints the prediction id plus resume/cancel commands. `--prefer-wait [seconds]` (an integer from 1 to 60; the bare flag means 60) sends `Prefer: wait=N` and keeps polling if the job is still running. Put the prompt before a bare `--prefer-wait`; any other value is rejected.
- Only `succeeded` exits 0; `failed`, `canceled`, and `aborted` exit non-zero with Replicate's error.
- If submitting fails with a network error, timeout, 5xx, or an unreadable 2xx response, the prediction may still have been created and billed (Replicate has no idempotency key). Check https://replicate.com/predictions before retrying.
- Every media URL in the output (string, list, or nested object) is downloaded as `replicate-<id8>-NN.<ext>` (`<id8>` = first 8 characters of the prediction id); text outputs are printed. Output URLs expire, so download promptly. If any download fails, the command exits non-zero and prints `multix replicate status <id> --download` to retry.
- Output downloads use `https://` only and refuse `localhost` and loopback, private, link-local, or other special-purpose IP literals (hostnames are not resolved), including on redirects. Files are written to `<path>.part` and renamed when complete, so a failed download never clobbers an existing file. Hosts other than `replicate.delivery` and Replicate's R2 output bucket are downloaded with a warning that names the host. Network errors, dropped connections, 408, 429 and 5xx are retried twice before the download fails. Each file is capped at `MULTIX_MAX_DOWNLOAD_MB` (default 2048).
- `replicate image` converts images to WebP by default; `--image-format original`, `--no-webp`, `MULTIX_IMAGE_FORMAT=original`, an explicit `--output-format`, or a non-`.webp` `--output` extension keeps the provider format.
- Local files (`--image`, `--file key=path`) up to 256 KB are inlined as data URIs; larger files (< 100 MB) are uploaded via the Replicate Files API.

### `multix runway`

[Runway](https://dev.runwayml.com/) API provider for Runway's own Gen-4 family (`X-Runway-Version: 2024-11-06`). Third-party models on the Runway API, video-to-video, upscaling and audio are not covered; unknown models are rejected, with no fallback.

```bash
# Text-to-video, or image-to-video with --image (default gen4.5; gen4_turbo is image-to-video only)
multix runway video "a lighthouse in a storm" [-m gen4.5|gen4_turbo] [--image <path|url>] [--ratio 1280:720] [--duration 5] [--seed <n>]
multix runway video "waves at dusk" --wait [--wait-timeout <ms>] [--no-download] [--output <path>]

# Text-to-image with up to 3 references cited as @tag (default gen4_image; gen4_image_turbo needs a reference)
multix runway image "@hero on a rooftop at night" [-m gen4_image|gen4_image_turbo] [--ratio 1920:1080] \
  [--reference ./hero.png --reference-tag hero] [--seed <n>] [--async] [--output <path>]

# Check, resume, cancel, or delete a task by id
multix runway status <task-id> [--wait] [--download] [--output <path>] [--wait-timeout <ms>]
multix runway cancel <task-id> [--delete]
multix runway models [--json]   # offline: supported models, ratios, durations, reference limits
```

**Notes:**
- Auth: `Authorization: Bearer $RUNWAYML_API_SECRET`.
- `video` does not wait by default: it prints the task id with status/resume/cancel commands. `--output` and `--download`/`--no-download` need `--wait`. `image` waits and downloads by default; `--async` returns the id.
- `status` writes only its result to stdout (the JSON summary, or the saved file list with `--download`); progress and resume hints go to stderr, so without `--download`, `multix runway status <id> | jq` parses even for a running task, and `--wait` prints the summary of a failed or canceled task before exiting non-zero.
- gen4.5 text-to-video ratios are `1280:720` and `720:1280`; image-to-video adds `1104:832`, `832:1104`, `960:960`, `1584:672`. `--duration` is 2-10 seconds, `--seed` 0-4294967295, prompts at most 1000 characters (required for gen4.5, optional for gen4_turbo). Image ratios: see the [Runway page](https://multix.zuey.me/commands/runway/).
- `--reference-tag` pairs with the `--reference` at the same position (3-16 letters, digits or `_`, starting with a letter). `image` converts to WebP like the other image commands.
- Inputs: public `https://` URLs (domain names only, at most 2048 characters; Runway does not follow redirects), `data:image/jpeg|png|webp` URIs up to 5 MB, `runway://` URIs, or local `.jpg`/`.jpeg`/`.png`/`.webp` files (inlined up to 5 MB encoded, otherwise uploaded for 24 hours, under 200 MB).
- `status` prints JSON without the prompt or inputs, and output URLs without signed query strings. `FAILED` and `CANCELLED` exit non-zero. `cancel` stops a pending or running task; a finished task is only deleted (with its outputs) with `--delete`.
- Outputs are saved as `runway-<id8>-NN.<ext>`; their URLs expire in 24-48 hours. Downloads follow the same https-only, no-private-host, `MULTIX_MAX_DOWNLOAD_MB` and `.part` rules as Replicate. A partial download failure exits non-zero and prints `multix runway status <id> --download`.
- Cost: before submitting, the CLI logs an indicative list-price estimate (Gen-4.5 12 credits/s, Gen-4 Turbo 5 credits/s, Gen-4 Image from 5 credits, Gen-4 Image Turbo 2 credits; 1 credit = $0.01; prices change, see [Runway pricing](https://docs.dev.runwayml.com/guides/pricing/)), then Runway's `estimatedCost` after create and the billed `cost` at the end.
- Create is retried only on 429. After a network error, timeout, 5xx, or unreadable response the task may still have been created and billed: check https://dev.runwayml.com/ before retrying. Tasks are polled every 5 seconds or more.

### `multix heygen`

[HeyGen](https://www.heygen.com) v3 API (`X-Api-Key` auth, base `https://api.heygen.com`). Two ways to make an avatar video:

- **Video Agent** (`video-agent`): prompt-to-video. Describe the video; the agent writes the script and chooses avatar, voice, scenes, and B-roll.
- **Scripted avatar video** (`video`): you pick the avatar look and voice, and the avatar speaks your exact script (or lip-syncs `--audio`).

```bash
# Prompt-to-video (Video Agent); waits, then downloads MP4 + thumbnail
multix heygen video-agent "45-second explainer for our note app, upbeat" [--avatar <look-id>] [--voice <voice-id>] [--style <style-id>] [--orientation landscape|portrait] [--file <ref>]...

# Scripted avatar video
multix heygen avatars [--type studio_avatar|digital_twin|photo_avatar] [--limit 50] [--cursor <token>]
multix heygen voices [--language English] [--gender female]
multix heygen video "Hi, I'm Anna." --avatar <look-id> [--voice <voice-id>] [--aspect-ratio 9:16] [--resolution 1080p] [--engine avatar_iv|avatar_v|avatar_iii] [--burn-captions] [--captions]
multix heygen video --avatar <look-id> --audio ./voiceover.mp3

# Translation (one job per language; all are downloaded), lipsync, TTS
multix heygen languages
multix heygen translate ./talk.mp4 --languages "Spanish, Chinese (Cantonese, Traditional)" [--mode speed|precision] [--output <dir|dub.mp4>]   # dub.mp4 -> dub-Spanish.mp4, ...
multix heygen lipsync --video <ref> --audio <ref>
multix heygen tts "Welcome to the show." --voice <voice-id> [--output hello.mp3]

# HeyGen Video model (5-15 s cinematic clip, not an avatar), templates, raw v3 payloads
multix heygen model-video "drone shot over a misty forest" [--duration 8] [--resolution 1080p]
multix heygen template <template-id> --input @vars.json
multix heygen run video --input @payload.json   # video-agent | video | video-translation | lipsync | model-video | speech

# Resume / inspect any job (agent takes a session_id)
multix heygen status <id> --type agent|video|translation|lipsync|model-video [--wait] [--download]
multix heygen me
```

**Notes:**
- API usage is billed separately from HeyGen web/app plans; `multix heygen me` shows the API balance. A 402 means the API account needs credits.
- Media `<ref>` values accept `https://` URLs, `asset:<asset_id>`, or a local file. Local files upload via `POST /v3/assets` (max 32 MB).
- Generation commands wait and download by default. Use `--async` to print IDs plus a resume command, `--no-download` to print the signed URL (included as `output_url` with `--json`), and `--wait-timeout` / `--poll-interval` to tune polling (default 30 min / 10 s, backing off to 30 s). `--burn-captions` downloads the captioned render and fails if HeyGen returns none.
- Failed, cancelled, or input-blocked jobs exit non-zero with HeyGen's `failure_code`/message. When several jobs run, every success is still downloaded before the command exits non-zero. 429 `Retry-After` is honoured, and `Idempotency-Key` is sent only on endpoints that document it.
- `--callback-url` webhooks are signed with HMAC-SHA256 of the raw body (hex, `signature` header). The npm package does not export a verifier; copy `src/providers/heygen/webhook.ts` or the Node snippet in the [HeyGen docs](https://multix.zuey.me/commands/heygen/#webhooks).
- Digital-twin creation and voice cloning are out of scope. Full reference: [HeyGen commands](https://multix.zuey.me/commands/heygen/).

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
**Audio:** mono 16 kHz; the codec follows the output extension (`.mp3` → MP3, `.m4a`/`.aac`/`.mp4`/`.mka`/`.mkv`/`.mov` → AAC, `.opus`/`.ogg` → Opus, `.wav`/`.aiff` → PCM, `.flac` → FLAC); other extensions are rejected. Embedded cover art is dropped.
**Video:** uses libx264 CRF encoding. Image optimization uses ImageMagick (replaces Pillow).

### `multix doc`

```bash
multix doc convert --input <files...> [--output <path>] [--auto-name] [--stdin-ext <ext>] [--model gemini-3.6-flash] [--prompt <str>] [-v]

# Read piped stdin with "-" (PDF, images and text auto-detected; else pass --stdin-ext, e.g. pdf; "-" only once, ./- for a file named -)
cat report.pdf | multix doc convert --input - --output report.md
```

Converts PDFs, DOCX/XLSX/PPTX, images, and HTML/text files to Markdown via Gemini.
Multiple inputs are concatenated with `---` separators into a single output.
Piped stdin is labelled `<stdin>` in the output and error messages; its temp file is removed when the command ends.

**Default output:** `./multix-output/document-extraction.md` (with `--auto-name`: `<input-basename>-extraction.md`, or `stdin-extraction.md` for piped input)

## Output

All generated files are saved to `./multix-output/` by default. Override with `MULTIX_OUTPUT_DIR`.

### Image format (WebP by default)

Every image generate/edit command (`generate`, `image-to-image`) converts its result to WebP with `cwebp -q 85 -m 6 -metadata none`. The CLI verifies that width, height, and transparency match the source before reporting the `.webp` path, then deletes only the intermediate file it wrote itself; your input and reference images are never touched. If verification or `cwebp` fails, the original file is kept with a warning.

Keep the provider's original format and quality with any of:

- `--image-format original` or `--no-webp`
- `MULTIX_IMAGE_FORMAT=original`
- an `--output` path with a non-WebP extension (e.g. `--output hero.png`)
- an explicit `openai ... --format png|jpeg|webp`

Requires `cwebp` (libwebp: `brew install webp`, `apt install webp`) on `PATH`.

### Polling and downloading videos

Most video-generating subcommands accept a uniform set of polling/download flags:

| Flag | Description |
|------|-------------|
| `--wait` | Poll the provider until the job reaches a terminal status (skip with the provider's `--async` flag where present). |
| `--wait-timeout <ms>` | Polling timeout (default `600000` = 10 min). |
| `--download` | Stream the resulting MP4 to disk on success — implies `--wait`. |
| `--output <path>` | Copy the saved MP4 to a custom path. The thumbnail is copied beside it as `<base>_thumb.<ext>`. |
| `--no-thumb` | Skip thumbnail download. |

Thumbnail detection is automatic: if the provider response includes any of `cover_image_url`, `thumbnail_url`, `thumb_url`, `preview_url`, `first_frame_url`, `poster_url`, or `image_url` (and the value is an `https://…(.jpg|.png|.webp|.gif|.bmp)` URL), the file is downloaded next to the video as `<basename>_thumb.<ext>`. Providers that don't expose a thumbnail simply skip this step.

`leonardo video`, `leonardo image-to-video`, and `openrouter image-to-video` are async-by-default for backward compatibility — pass `--wait` (or `--download`) to opt into the synchronous flow.

Cloudflare video is intentionally separate: it has no thumbnail flags, and `generate-video --wait` already saves the completed MP4. See [`multix cloudflare`](#multix-cloudflare) for its exact polling and download behavior.

## Remote MCP server (Cloudflare Workers)

`worker/` contains an optional MCP server that runs multix CLI commands in
Cloudflare Containers over Streamable HTTP at `/mcp`, for agents that cannot
run the CLI locally. It is a separate package and is not included in the npm CLI. A hosted
instance runs at `https://multix.zuey.me/mcp` (invited GitHub accounts only).

- Tools: `multix_catalog` (runnable commands, their options and file inputs,
  and `has_keys` per group from the caller's saved keys; always listed),
  `multix_run` (run one CLI command, for example
  `gemini analyze` or `media optimize`, in its own Cloudflare Container with
  ffmpeg and ImageMagick; waits up to `wait_seconds`, default 25, max 40,
  container start included), `multix_job_status` and `multix_job_cancel`.
  Each account runs at most `MULTIX_MAX_JOBS_PER_ACCOUNT` jobs at once
  (default 2; `busy: …` otherwise) and the server at most
  `MULTIX_MAX_JOBS_TOTAL` (default 10, keep it at or below the container
  `max_instances`; `server at capacity: …` otherwise), and one 30-minute limit covers downloads,
  the CLI and uploads. File inputs are public `https://` URLs. Output files
  (at most 50, up to 500 MB each) are streamed to the account's own R2 bucket
  and returned as URLs; without R2 the job still runs and the result says to
  configure R2 in `/dashboard`. Keys are redacted from stdout and stderr.
  The three job tools need the Workers Paid plan (Containers) and Docker at
  deploy time; they are listed only when the `MULTIX_JOBS` and
  `MULTIX_JOB_QUOTA` bindings exist.
- Protocol: 2025 clients (`initialize`) keep the tools-only surface; clients
  on protocol `2026-07-28` negotiate through `server/discover` and can
  subscribe to MCP Events (`multix.job.completed`, `multix.job.failed`,
  `multix.job.canceled`, `multix.job.timed_out`, `multix.asset.ready`) with
  verified, signed `https://` webhooks to public hosts. Subscriptions are kept
  per account in the `MULTIX_EVENTS` Durable Object, next to the REST
  webhook subscriptions.
- Auth: OAuth 2.1 (dynamic client registration, PKCE) with GitHub sign-in.
  Only GitHub logins or verified emails in the `MULTIX_ALLOWED_USERS` secret
  can sign in.
  `/health` is public.
- Per-account keys: each account saves its own provider keys at `/dashboard`
  (AES-GCM encrypted in KV) and spends its own credits. The dashboard has an
  input for every key env name the CLI reads (grouped by provider) plus the
  Cloudflare Workers AI names, and an R2 storage card for the account's own
  bucket (account ID, access key pair, bucket, optional `https://` public
  URL, optional directory path, default `multix`; checked with a list, upload and delete of an empty `.multix-probe-*`
  object before it is saved). It also lists and disconnects MCP clients. Limit exposure further with
  `MULTIX_MCP_MAX_OUTPUTS`, `MULTIX_MCP_MAX_VIDEO_SECONDS` (also sent as
  `min(5, cap)` when a command's default duration is unknown or longer; it
  bounds each `gemini extend-video` continuation, not a stored clip that
  chained extends grew, nor a `gemini edit-video` of it),
  `MULTIX_MCP_ALLOWED_RESOLUTIONS` (default `480p,720p,768p,1080p`),
  `MULTIX_MCP_ALLOWED_ORIGINS` (exact browser origins, with CORS), and the
  approximate per-account rate limiter. JSON-RPC batches are rejected.

```bash
claude mcp add --transport http multix https://multix.zuey.me/mcp
```

A `multix_run` call mirrors the CLI command it runs:

```json
{
  "command": "gemini analyze",
  "options": { "prompt": "Summarise this clip" },
  "inputs": { "files": "https://cdn.example.com/clip.mp4" }
}
```

It returns `{ job_id, status, outputs: [{ name, url, bytes }], stdout,
stderr_tail, exit_code }`; poll `multix_job_status` while `status` is
`running`.

To run your own: create a GitHub OAuth App (callback
`<origin>/oauth/github/callback`), two KV namespaces, and set routes and vars in
`worker/wrangler.jsonc`, then:

```bash
npm ci --prefix worker
cd worker && npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
openssl rand -base64 32 | npx wrangler secret put SECRETS_ENCRYPTION_KEY
npx wrangler secret put MULTIX_ALLOWED_USERS     # GitHub logins or emails
cd .. && npm run deploy:mcp                   # or: npm run dev:mcp (local, port 8787)
```

`deploy:mcp` builds the job container image from `worker/container/Dockerfile`,
so Docker must be running. To deploy without the CLI runner, remove
`containers`, `durable_objects` and `exports` from `worker/wrangler.jsonc`.

Full guide: [Remote MCP server](https://multix.zuey.me/guides/mcp-server/).

### REST API

The same server exposes a JSON REST API at `/api/v1` for scripts and CI
(manage provider keys and R2 storage, read the catalog, run and poll jobs).
Create an account API key (`mxk_…`, shown once) in the **API keys** card at
`/dashboard` and send it as `Authorization: Bearer <key>`:

```bash
curl -s https://multix.zuey.me/api/v1/me -H "Authorization: Bearer $MULTIX_API_KEY"
```

To be told when a job ends instead of polling, subscribe an https endpoint at
`POST /api/v1/events/subscriptions`: the server sends signed
[Standard Webhooks](https://www.standardwebhooks.com) events
(`multix.job.completed`, `multix.job.failed`, …) carrying ids and final state
only; polling stays the fallback.

Guide: [REST API](https://multix.zuey.me/guides/rest-api/), including
[job event webhooks](https://multix.zuey.me/guides/rest-api/#job-event-webhooks). Reference:
[`/api/docs`](https://multix.zuey.me/api/docs) (OpenAPI at `/api/v1/openapi.json`).

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
