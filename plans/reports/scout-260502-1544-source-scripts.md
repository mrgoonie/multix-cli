# Scout Report: ai-multimodal Source Scripts

Source: `D:\www\claudekit\claudekit-engineer\claude\skills\ai-multimodal\scripts\`
Total LOC: ~3462 across 8 Python files.

## 1. check_setup.py (327 LOC)
Purpose: validate skill setup (deps, API keys, structure, live API ping).
Argv: none (zero-flag).
Behavior:
- Checks Python deps: google-genai, python-dotenv, Pillow, requests.
- Resolves keys: `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY` via centralized resolver fallback to env+dotenv.
- Validates Gemini key prefix `AIza`, lists models via `genai.Client.models.list()`.
- Exit non-zero if no provider keys.
TS port: `multix check` — drop Python-specific deps; check `node`, `ffmpeg`, `magick` on PATH; ping Gemini `/v1beta/models` via fetch.

## 2. gemini_batch_process.py (1380 LOC) — primary entry
Argv flags:
- `--files <...>` (multi)
- `--task {transcribe,analyze,extract,generate,generate-video}` (auto-detected from extension)
- `--prompt <str>`
- `--model <str>` (auto from task)
- `--provider {auto,google,openrouter,minimax}` default `auto`
- `--format {text,json,csv,markdown}` default `text`
- `--aspect-ratio {1:1,2:3,3:2,3:4,4:3,4:5,5:4,9:16,16:9,21:9}`
- `--num-images <int>` default 1
- `--size {1K,2K,4K}`
- `--resolution {720p,1080p}` (video) default 1080p
- `--reference-images <...>` (max 3)
- `--output <path>`
- `--verbose/-v`, `--dry-run`
Defaults:
- IMAGE_MODEL_DEFAULT = `gemini-3.1-flash-image-preview` (Nano Banana 2)
- IMAGE_MODEL_FALLBACK = `gemini-2.5-flash-image`
- IMAGEN models set: `imagen-4.0-generate-001`, `-ultra-`, `-fast-`
Routing: `is_minimax_model` / `is_openrouter_model` (slash in id) dispatches to providers.
Validation: generate task requires --prompt; OR/MM only support prompt-only (no input files); other tasks require --files.
TS port: `multix gemini ...` with same flag surface; same routing.

## 3. minimax_cli.py (178 LOC) + minimax_generate.py (278) + minimax_api_client.py (195)
Argv (cli):
- `--task {generate,generate-video,generate-speech,generate-music}` required
- `--prompt`, `--text`, `--lyrics`, `--model`
- `--aspect-ratio {1:1,16:9,4:3,3:2,2:3,3:4,9:16,21:9}` default 1:1
- `--num-images <int>` default 1 (max 9)
- `--duration {6,10}` default 6
- `--resolution {720P,1080P}` default 1080P
- `--voice <str>` default `English_expressive_narrator`
- `--emotion {happy,sad,angry,fearful,disgusted,surprised,neutral}` default neutral
- `--output-format {mp3,wav,flac,pcm}` default mp3
- `--first-frame <url>`
- `--output/-o`, `--verbose/-v`
TASK_DEFAULTS: generate=image-01; generate-video=MiniMax-Hailuo-2.3; generate-speech=speech-2.8-hd; generate-music=music-2.5.
HTTP: base `https://api.minimax.io/v1`, Bearer auth, async polling for video, file download.
Models registries:
- IMAGE: image-01, image-01-live
- VIDEO: MiniMax-Hailuo-2.3, MiniMax-Hailuo-2.3-Fast, MiniMax-Hailuo-02, S2V-01
- SPEECH: speech-2.8-hd, speech-2.8-turbo, speech-2.6-hd/turbo, speech-02-hd/turbo
- MUSIC: music-2.5, music-2.0
TS port: `multix minimax <subcommand>` with same task verbs.

## 4. openrouter_generate.py (203 LOC)
Library only (called by gemini_batch_process). Endpoint: `POST https://openrouter.ai/api/v1/chat/completions`.
Default model: `google/gemini-3.1-flash-image-preview`.
Payload: `{messages, modalities:[image,text], image_config:{aspect_ratio,image_size?}, model | models[fallbacks]}`.
Headers: `Authorization Bearer`, `HTTP-Referer` (env OPENROUTER_SITE_URL), `X-Title` (env OPENROUTER_APP_NAME default "ClaudeKit Engineer").
Env: `OPENROUTER_API_KEY`, `OPENROUTER_IMAGE_MODEL`, `OPENROUTER_FALLBACK_MODELS` (csv).
Returns base64 data URLs or http urls; saves PNG.
TS port: `multix openrouter generate --prompt --model --aspect-ratio --image-size --num-images --output`.

## 5. media_optimizer.py (506 LOC) — FFmpeg + Pillow wrapper
Argv:
- `--input` / `--input-dir`, `--output` / `--output-dir`
- `--target-size <MB>`
- `--quality <int>` default 85 (image %, video CRF semantics)
- `--max-width <int>` default 1920
- `--bitrate <str>` default `64k`
- `--resolution <WxH>` (video)
- `--split` + `--chunk-duration <sec>` default 3600
- `--verbose/-v`
File-type dispatch by ext: video {.mp4,.mov,.avi,.mkv,.webm,.flv}, audio {.mp3,.wav,.m4a,.flac,.aac}, image {.jpg,.jpeg,.png,.webp}.
TS port: `multix media optimize|split` — shell out to `ffmpeg`/`magick` via execa; Pillow image compression replaced by `sharp` or just `magick`.

## 6. document_converter.py (395 LOC)
Argv:
- `--input/-i <files...>` required
- `--output/-o <path>`
- `--auto-name/-a`
- `--model <str>` default `gemini-2.5-flash`
- `--prompt/-p <str>`
- `--verbose/-v`
Behavior: uploads doc to Gemini, asks to convert to markdown, writes to output (default `docs/assets/document-extraction.md`).
TS port: `multix doc convert -i ... -o ... [--auto-name]` using Gemini Files API via fetch.

## Cross-cutting
- Env resolution hierarchy: process.env → skill .env → skills/.env → .claude/.env (skill of `ai-multimodal`). Replicate as `MULTIX_*` discovery: cwd `.env` → `.multixrc` → `~/.multix/.env` → process.env (process.env wins).
- All scripts emit human-readable status lines + JSON-friendly result dicts. Keep parity in TS for LLM-friendly output.
- "Centralized resolver" (`~/.claude/scripts/resolve_env.py`) — N/A in standalone npm pkg; we own the resolver.
- Key rotation (`api_key_rotator`) — defer (YAGNI v1).

## Unresolved Questions
1. Should `multix` keep `--task generate-video` under `gemini` if Veo isn't yet GA via official SDK? (Source script lists it but Veo support depends on Google access.)
2. For document conversion — replicate `docs/assets/document-extraction.md` default output path, or use cwd-relative `./multix-output/`?
3. Skill companion (`skill/SKILL.md`) — should it live in repo root or `claude/skills/multix/`? Following /ck:agentize, root `skill/` directory.
4. Replace Pillow with `sharp` (native dep, fast) or shell out to `magick` only (keep deps light)? Recommend `magick`-only for KISS.
