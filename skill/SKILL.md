---
name: multix
description: AI multimodal CLI — generate and edit images (OpenAI, Codex driver, Gemini Nano Banana, Imagen, MiniMax, OpenRouter, Leonardo, BytePlus Seedream, Cloudflare Workers AI FLUX.1 Schnell, fal.ai FLUX, Replicate FLUX, Runway Gen-4 Image), generate, edit and extend video (Gemini Omni Flash, plus legacy Gemini Veo), generate video (MiniMax Hailuo, OpenRouter via Veo/Seedance/Kling, Leonardo via Motion/Veo/Kling/Hailuo/Seedance/LTX, BytePlus Seedance, Cloudflare AI Gateway via Replicate, fal.ai queue models, Replicate direct API models incl. P-Video, Runway Gen-4.5 and Gen-4 Turbo, HeyGen Video Agent and scripted avatar videos), video translation and lipsync (HeyGen), TTS/STT/music (OpenAI, Gemini Flash TTS incl. Gemini 3.8 with delivery-style control, MiniMax, Cloudflare Workers AI MeloTTS, ElevenLabs), 3D models (BytePlus Hyper3D/Hitem3d), analyze/transcribe media, convert documents to Markdown, optimize media via ffmpeg/ImageMagick, and self-update the CLI. Use whenever the user wants to create, edit, or transform images/video/audio/3D/documents from a CLI, mentions any of: OpenAI, Codex image driver, image-to-image, i2i, image edit, watercolor/cyberpunk style transfer, reference image, OpenRouter, Nano Banana, Flux, Seedream, Gemini Omni, Omni Flash, Veo, Hailuo, Seedance, Kling, Cloudflare Workers AI, AI Gateway, fal.ai, Atlas Cloud, Replicate, replicate.com models, Replicate predictions, Runway, Gen-4.5, Gen-4 Turbo, Gen-4 Image, HeyGen, avatar video, talking head, Video Agent, video translation, dubbing, lipsync, video generation, text-to-video, image-to-video, i2v, ElevenLabs voice cloning, updating/upgrading multix, or asks for batch media optimization.
version: 1.14.0 # x-release-please-version
---

# multix — AI Multimodal CLI

## Agent protocol (read first)

```bash
multix models --task <task> --ready     # command + default model per task, key set or not
multix <group> <cmd> ... --dry-run      # free: local checks, then shows the request instead of sending it
multix <group> <cmd> ... --json         # stdout = ONE line, schema multix.result/v1
```

- Tasks: image, image-edit, video, image-to-video, video-edit, speech, transcription, music, sfx, voice, 3d, analysis, document, avatar-video, any. `multix guide` prints the protocol for the installed version.
- Success = `ok: true` AND `outputs[]` non-empty (path, bytes, mime, sha256, width/height, duration_s) AND no `warnings` (`EMPTY_OUTPUT`, `CONTENT_MISMATCH`, `UNREADABLE_MEDIA`).
- Failure: read `error.code`, `error.hint`, `next[]`. Exit codes (with `--json`; plain runs exit 1): 2 fix flags/input · 3 key/setup (`multix check`, key named in `error.env`) · 4 temporary (wait `retry_after_s`, `multix rerun <history_id>`) · 5 rejected: quota, safety, model (change input/provider) · 6 timed out, job may still run (status command in `next[]`, do not resubmit) · 1 unknown (`log[]`).
- `usage` = what the provider reported (tokens, `cost_usd`, `credits`, metrics); `history_id` names the run.
- History: `multix history [--failed] [--since 1d]`, `multix history show last`, `multix history stats --by model|provider|command`, `multix rerun <id|last>`. Ledger `~/.multix/history.jsonl` has no keys or signed URLs; `MULTIX_HISTORY=0` disables it.

## When to use

Activate this skill when the user asks to:
- Generate images from a text prompt (any provider)
- **Edit/transform an existing image with a prompt** (image-to-image, alias `i2i`)
- Generate video from text or from a reference image (image-to-video, alias `i2v`)
- **Edit or extend a Gemini Omni video** (`gemini edit-video`, `gemini extend-video`) and check/resume/cancel it (`gemini video-status`, `gemini video-cancel`)
- **Generate video via OpenRouter routed models** (Veo, Seedance, Kling — use `multix openrouter video-models` to list)
- **Generate video via BytePlus Seedance** directly (text-to-video, image-to-video, reference-to-video)
- **Generate video via Leonardo** (Motion, Veo, Kling, Hailuo, Seedance, LTX models)
- Generate images or speech with Cloudflare Workers AI, or video through Cloudflare AI Gateway's Replicate route
- Generate or clone a voice, run STT, generate music or sound effects
- Generate 3D models (BytePlus Hyper3D / Hitem3d)
- Analyze, transcribe, or extract structured data from media/docs
- Convert PDFs / DOCX / images to Markdown
- Optimize, resize, batch-convert, or split video/audio/image files
- Run any fal.ai model (generic queue-API runner), or fal.ai's default image/video models and text-to-speech (Gemini 3.8 Flash/Flash-Lite TTS, ElevenLabs v4/v4 Turbo) with typed inputs
- Run any Atlas Cloud model (image, image edit, video, TTS/STT, 3D) with schema-validated inputs and resumable async predictions
- Run any Replicate model (official or versioned) via the direct API, generate Replicate images/video, or resume/cancel a Replicate prediction by id
- Generate Runway Gen-4.5 / Gen-4 Turbo video or Gen-4 images (with tagged reference images), or check/resume/cancel a Runway task by id
- Make HeyGen avatar videos from a prompt (Video Agent) or an exact script, translate/lipsync videos, HeyGen TTS
- Update multix itself to the latest (or a given dist-tag) npm version

## Self-update

```bash
multix update [--check] [--tag <tag>] [--dry-run] [-v]
```

Detects whether `multix` was installed via npm, pnpm, yarn, or bun global install (from the running binary's path) and runs the matching install command, e.g. `npm i -g @mrgoonie/multix@latest`. `--check` only compares versions against the npm registry without installing. `--tag <tag>` installs a dist-tag such as `beta`, always installing that tag regardless of the current version (skipping the "already up to date" comparison used by the default `latest` flow). `--dry-run` prints the command instead of running it.

## Required env (set at least one provider key)

```
GEMINI_API_KEY        # Google AI Studio (extra keys: GEMINI_API_KEY_2, _3, … rotate on 429/RESOURCE_EXHAUSTED)
OPENAI_API_KEY        # OpenAI API (image, image edit, TTS, STT)
OPENROUTER_API_KEY    # OpenRouter (multi-model gateway: image + video via Veo, Seedance, Kling)
MINIMAX_API_KEY       # MiniMax (image/video/speech/music)
LEONARDO_API_KEY      # Leonardo.Ai (image/video/upscale)
BYTEPLUS_API_KEY      # BytePlus / Volcengine ARK (Seedream/Seedance/Hyper3D)
ELEVENLABS_API_KEY    # ElevenLabs (TTS, cloning, STT, music, dubbing)
FAL_KEY                # fal.ai (generic queue-API model runner, image/video/TTS, local media upload)
ATLASCLOUD_API_KEY    # Atlas Cloud (any model: image, edit, video, audio, 3D)
REPLICATE_API_TOKEN   # Replicate direct API (REPLICATE_API_KEY accepted as fallback)
RUNWAYML_API_SECRET   # Runway API (Gen-4.5 / Gen-4 Turbo video, Gen-4 images)
HEYGEN_API_KEY        # HeyGen v3 (avatar video, Video Agent, translation); API billed separately from web plans
CLOUDFLARE_ACCOUNT_ID # Cloudflare Workers AI / AI Gateway account
CLOUDFLARE_API_TOKEN  # Cloudflare Workers AI / AI Gateway token
# Video additionally requires CLOUDFLARE_AI_GATEWAY_ID and REPLICATE_API_TOKEN.
```

Priority: `process.env` > `cwd/.env` > `~/.multix/.env`; a blank value in a `.env` file does not count as set, so a later file can fill it (a shell value wins even when blank). Set `MULTIX_LEGACY_CLAUDE_ENV=1` to also read legacy AgentKit `.claude` env files (credential names only, lowest priority); `multix check -v` lists loaded env files. A project `.env` may only set names multix reads (provider keys and settings from `.env.example`, the documented `MULTIX_*` settings such as `MULTIX_OUTPUT_DIR`, `NO_COLOR`; never `MULTIX_ALLOW_PROJECT_BASE_URL` or `MULTIX_LEGACY_CLAUDE_ENV`); anything else there (`NODE_OPTIONS`, `npm_config_*`, `LD_PRELOAD`, proxy/TLS variables) is not loaded, with one stderr warning naming the ignored variables. Put such variables in the shell.

## Gemini text-output tasks

`gemini-3.6-flash` is the default for Gemini analyze, transcribe, extract, and doc conversion. It is text-output only; use Nano Banana/Imagen for images, Gemini Omni Flash for video, and Gemini Flash TTS for speech. Override analyze/transcribe/extract with `GEMINI_MODEL` or `MULTIMODAL_MODEL`; override doc conversion with `--model`.

Codex CLI can be used as an experimental OpenAI image driver after manual `codex login`:

```bash
multix openai generate --prompt "A poster for a midnight jazz club" --driver codex
```

## Install + diagnostics

```bash
npm install -g @mrgoonie/multix
multix check [--verbose]
```

## Image generation

| Provider | Command | Notes |
|---|---|---|
| OpenAI | `multix openai generate --prompt "<text>" [--driver api\|codex\|auto] [--model gpt-image-2] [--size 1024x1024] [--quality medium] [--format png]` | API first; Codex driver is experimental image-only fallback |
| Gemini | `multix gemini generate --prompt "<text>" [--model gemini-3.1-flash-image-preview] [--aspect-ratio 16:9] [--size 1K\|2K\|4K] [--num-images N]` | Nano Banana 2 (default), Imagen 4 (`imagen-4.0-generate-001`) |
| MiniMax | `multix minimax generate --prompt "<text>" [--model image-01] [--aspect-ratio 1:1] [-n N]` | |
| OpenRouter | `multix openrouter generate --prompt "<text>" [--model <id>] [--aspect-ratio 16:9] [--image-size 2K] [--num-images N]` | Default `google/gemini-3.1-flash-image-preview` |
| Leonardo | `multix leonardo generate "<text>" [-w 1024 -h 1024] [--alchemy] [--ultra] [--quality HIGH]` | Polls until done, downloads automatically |
| BytePlus | `multix byteplus generate --prompt "<text>" [--model seedream-4-0-250828] [--size 2K] [--aspect-ratio 16:9] [-n N] [--input-image <path\|url>]` | Sync |
| Cloudflare | `multix cloudflare generate --prompt "<text>" [--steps 1-8] [--seed <n>]` | Workers AI FLUX.1 Schnell only |
| fal.ai | `multix fal image "<text>" [-m <model>] [--image-size square_hd] [-n N] [--seed <n>]` | Default `fal-ai/flux/schnell`; also `multix fal run <model> --input <json\|@file>` for any fal model |
| Atlas Cloud | `multix atlas image "<text>" [-m <model>] [--size <size>] [--aspect-ratio 1:1] [-n N] [--seed <n>]` | Default `black-forest-labs/flux-schnell`; flags are validated against the model's schema |
| Replicate | `multix replicate image "<text>" [-m <owner/name>] [--aspect-ratio 16:9] [-n N] [--seed <n>]` | Default `black-forest-labs/flux-schnell`; also `multix replicate run <model> --input <json\|@file>` for any model |
| Runway | `multix runway image "<text>" [-m gen4_image\|gen4_image_turbo] [--ratio 1920:1080] [--reference <path\|url> --reference-tag <tag>]` | Default `gen4_image`; up to 3 references cited as `@tag`; Turbo needs one |

Aspect ratios (most providers): `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`.

## Cloudflare media

Cloudflare image and speech use the [Workers AI REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. `CLOUDFLARE_AI_GATEWAY_ID` is optional for those Workers AI calls, but required with `REPLICATE_API_TOKEN` for video. The CLI deliberately supports only the fixed models shown here; it does not expose an arbitrary Workers AI catalog.

`CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD` defaults to `false`; set it to `true` only to explicitly opt in to AI Gateway request-payload collection. It controls a gateway request header, not multix CLI logging: the CLI does not log credential values or provider output URLs.

```bash
# Workers AI image (FLUX.1 Schnell; sync)
multix cloudflare generate --prompt "a cyberpunk cat" \
  [--model @cf/black-forest-labs/flux-1-schnell] [--steps 1-8] [--seed <n>] [--output <path>] [-v]

# Workers AI speech (MeloTTS; sync, saves MP3)
multix cloudflare generate-speech --text "Hello world" \
  [--lang <code>] [--model @cf/myshell-ai/melotts] [--output <path>] [-v]

# Replicate prunaai/p-video through Cloudflare AI Gateway; no native Workers AI video
multix cloudflare generate-video --prompt "Ocean waves" \
  [--duration 5] [--aspect-ratio 16:9] [--resolution 720p] [--fps 24] \
  [--wait] [--wait-timeout 600000] [--download] [--output <path>] [-v]
multix cloudflare video-status <predictionId> \
  [--wait] [--wait-timeout 600000] [--download] [--output <path>] [-v]
```

Video follows Cloudflare's documented [Replicate AI Gateway route](https://developers.cloudflare.com/ai-gateway/usage/providers/replicate/). `generate-video` returns a prediction ID unless `--wait` or `--download` is passed; either waits, saves the completed MP4, and prints its local path. For `video-status`, `--wait` reports the terminal status and `--download` implies waiting plus saves the MP4. No Cloudflare video command prints the provider output URL.

## fal.ai

Auth is `Authorization: Key $FAL_KEY`; base URL is `https://queue.fal.run`. All fal jobs are async (submit → poll status → fetch result); `run`/`image`/`video` handle this automatically and download any media URL found in the result.

```bash
# Generic runner — works with any fal model id
multix fal run fal-ai/flux/schnell --input '{"prompt":"a cyberpunk cat"}' [--no-download] [--wait-timeout 480000] [-v]
multix fal run <model> --input @input.json

# Local media -> fal storage URL at an input field (repeatable; a.b=path nests, field[]=path appends)
multix fal run fal-ai/mmaudio-v2 --input '{"prompt":"soft rain"}' --file video_url=./shot.mp4
multix fal upload ./shot.mp4          # stdout: {"url","mime_type","size_bytes","file_name"}

# Submit only: prints a receipt (request_id, status_command, result_command); resume later
multix fal run <model> --input @in.json --file video_url=./shot.mp4 --detach [--receipt <path>]

# Text-to-image (default fal-ai/flux/schnell)
multix fal image "a cyberpunk cat" [-m <model>] [--image-size square_hd] [-n 1] [--seed <n>] [--negative-prompt <text>] [--output <path>] [-v]

# Text-to-video (default fal-ai/kling-video/v1.6/standard/text-to-video), or
# image-to-video with --image-url (default switches to fal-ai/kling-video/v1.6/standard/image-to-video when -m is omitted)
multix fal video "a dancer under neon lights" [-m <model>] [--image-url <https-url>] [--duration <n>] [--aspect-ratio 16:9] [--seed <n>] [-v]

# Inspect a request submitted any other way
# Text-to-speech (default google/gemini-3.8-flash-tts, or FAL_TTS_MODEL); flags map to each model's own fields
multix fal tts "Xin chào" [--voice Puck] [--style "warm"]                       # Gemini: prompt/voice/style_instructions, wav
multix fal tts --text-file script.txt -m elevenlabs/tts/eleven-v4-turbo [--format pcm_16000|opus_48000_64|mp3_44100_128] [--language vi]
multix fal tts "hi" -m <other-fal-tts> --text-field <field> [--voice-field <field> --voice <v>]   # unlisted model: name its fields
multix fal voices [<model>] [--live]   # verified models, voices, formats; <model> or --json prints typed inputs; --live lists fal's TTS catalog

multix fal status <model> <requestId>
multix fal result <model> <requestId> [--download] [--output-dir <dir>] [--format <fmt>]   # --format for raw speech formats; detach receipts include it
```

`--detach` leaves a receipt in `~/.multix/fal/requests/` (or at `--receipt <path>`, which also works without `--detach`; mode 0600, no input or key). `status`/`result` never resubmit, so resume a detached or timed-out job with them instead of running `fal run` again. `UNKNOWN_REMOTE_STATE` means fal may or may not have queued the submit (connection cut off, 5xx gateway error): check https://fal.ai/dashboard/requests before resubmitting. `fal tts` refuses a flag the model has no field for (`--style` on ElevenLabs, `--format` on Gemini) and a voice or format outside the model's list, before sending. It saves `fal-<id>-01.<ext>` with the extension taken from the bytes (raw `pcm_*`/`ulaw_8000`/`alaw_8000` from the format) and refuses empty, error-page or mislabelled audio; `--detach` and `fal result --download` work as for `run`. `--file`/`fal upload` take image, video and audio only (`FAL_MAX_UPLOAD_MB`, default 1024); the uploaded URL is public to anyone with the link.

## Atlas Cloud

Auth is `Authorization: Bearer $ATLASCLOUD_API_KEY`; the media API base is `https://api.atlascloud.ai/api/v1`. Each job is an async prediction: commands wait (bounded by `--wait-timeout`) and download to `MULTIX_OUTPUT_DIR` as `atlas-<prediction id>-NN.<ext>`. These names are fixed per output, so rerunning `multix atlas status <id> --wait --download` after a partial failure keeps the saved files ("already saved") and fetches only the missing ones; an explicit single-file `--output` is overwritten, and multi-output `--output` names get a `-1`, `-2`, ... suffix instead of overwriting. An error naming a `.part` file means another live multix process is downloading that output: wait and retry (a `.part` left by a stopped run is taken over automatically, so never delete it by hand). `--async` prints only the prediction id on stdout (progress goes to stderr) so scripts can capture it. A failed prediction, or a partial download, exits non-zero with a resume command that keeps your `--output`. Output and thumbnail downloads are https-only and refuse `localhost` and loopback/private/link-local/special-purpose IP literals, also on redirects (hostnames are not resolved): "Refusing to download from ..." means the API returned such a URL, and `--no-download` prints it instead. Each file stops at `MULTIX_MAX_DOWNLOAD_MB` (default 2048); inline `data:` outputs are still saved. Thumbnails come only from the prediction's outputs, never from echoed input.

Inputs are model-specific. multix reads the model's published schema and maps flags onto its field names (`size`/`image_size`, `images[]`/`image`, `audio_url`/`audio`). Unsupported flags and invalid values fail before anything is billed, and the error lists the accepted values. Pass `--no-validate` to skip this check.

```bash
multix atlas image "a red fox in the snow" [-m <model>] [--size <size>] [--aspect-ratio 1:1] [-n 1] [--seed <n>]
multix atlas image-to-image --prompt "make it dusk" --ref ./photo.png      # default openai/gpt-image-1-mini/edit
multix atlas video "waves at sunset" [--duration <s>] [--resolution 720p]  # default bytedance/seedance-v1-pro-fast/text-to-video
multix atlas image-to-video --ref ./frame.png [--prompt "slow pan"]
multix atlas audio "Hello from multix" [--voice <id>]                      # TTS, default xai/tts-v1
multix atlas audio --audio ./meeting.mp3                                   # STT, transcript printed to stdout
multix atlas 3d "a low-poly treasure chest" [--ref ./object.png]           # tencent/hunyuan3d-rapid
multix atlas run <modelId> --input '{"prompt":"a cat"}' [--type image|video|audio]

# Async + resume
id=$(multix atlas video "waves" --async)
multix atlas status "$id" --wait --download [--output <path>]
```

`--ref` takes one value per flag; repeat it for several references. Local `--ref` and `--audio` files are uploaded first (`multix atlas upload <file>` prints only a temporary URL). Uploads accept only image, video and audio files up to 200 MB (`ATLASCLOUD_MAX_UPLOAD_MB`). `run --no-validate` skips the schema, so pass `--type` with it. Atlas Cloud has no cancel endpoint.

## Replicate

Direct Replicate API (`Authorization: Bearer $REPLICATE_API_TOKEN`, fallback `REPLICATE_API_KEY`), separate from the Cloudflare AI Gateway route. Official models (`owner/name`) run on the model endpoint; community models need `owner/name:version`, a bare version id, or `--version`. Commands wait with bounded polling by default and download every media output as `replicate-<id8>-NN.<ext>` (first 8 characters of the prediction id). A partial download failure exits non-zero with a `status <id> --download` retry command. `replicate image` converts to WebP unless `--image-format original`/`--no-webp`, an explicit `--output-format`, or a non-`.webp` `--output` is given.

```bash
# Generic runner (input is passed through unchanged; --file uploads local files into an input key)
multix replicate run black-forest-labs/flux-schnell --input '{"prompt":"a cyberpunk cat"}'
multix replicate run owner/model:<version-id> --input @payload.json [--file image=./photo.png]

# Image (default black-forest-labs/flux-schnell) and video (default prunaai/p-video; --image for image-to-video)
multix replicate image "a futuristic city" [-m <owner/name>] [--aspect-ratio 16:9] [-n 1] [--output-format png]
multix replicate video "a cinematic establishing shot" [--image <path|url>] [--duration 5] [--input '{"draft":true}']

# Long jobs: submit async, keep the id, resume or cancel later without re-running
multix replicate video "a slow pan over mountains" --async
multix replicate status <prediction-id> --wait --download
multix replicate cancel <prediction-id>
```

Shared flags: `--async`, `--wait`, `--prefer-wait [seconds]` (integer 1-60, bare flag = 60; sends `Prefer: wait=N`, still polls if unfinished; put the prompt before a bare flag), `--wait-timeout <ms>`, `--no-download` (print URLs), `--output <path|dir/>`. `failed`/`canceled`/`aborted` predictions exit non-zero. Local files up to 256 KB are inlined as data URIs; larger files (< 100 MB) go through the Replicate Files API.

Output downloads are `https://` only; `localhost` and loopback/private/link-local/special-purpose IP literals (including redirects; hostnames are not resolved) are refused, hosts other than `replicate.delivery` and Replicate's R2 output bucket are downloaded with a warning, network errors, dropped connections and 408/429/5xx download failures are retried twice (if it still fails, `multix replicate status <id>` prints the output URLs), and each file is capped at `MULTIX_MAX_DOWNLOAD_MB` (default 2048). If submitting fails with a network error, timeout, 5xx, or an unreadable 2xx response, the prediction may still exist and bill: check https://replicate.com/predictions before retrying instead of resubmitting blindly.

## Runway

Runway API (`Authorization: Bearer $RUNWAYML_API_SECRET`), Runway's own Gen-4 family only; unknown models are rejected (no fallback). Video models: `gen4.5` (default; text-to-video, or image-to-video with `--image`) and `gen4_turbo` (image-to-video only, prompt optional). Image models: `gen4_image` (default) and `gen4_image_turbo` (needs at least one `--reference`).

```bash
# Video does NOT wait by default: it prints the task id plus status/resume/cancel commands
multix runway video "a lighthouse in a storm" [--ratio 1280:720|720:1280] [--duration 2-10] [--seed <n>]
multix runway video "the camera orbits the statue" --image ./statue.png --wait   # wait + download MP4
multix runway video -m gen4_turbo --image https://cdn.example.com/still.jpg --ratio 960:960

# Image waits and downloads by default; --async returns the id
multix runway image "@hero on a rooftop at night" --reference ./hero.png --reference-tag hero [--ratio 1920:1080]

multix runway status <task-id> [--wait] [--download] [--output <path>]
multix runway cancel <task-id> [--delete]   # --delete also removes a finished task and its outputs
multix runway models [--json]               # offline (no key, no request): models, ratios, durations, reference limits
```

- `--output` and `--download`/`--no-download` on `video` need `--wait`; otherwise resume later with `status <id> --wait --download`. `FAILED`/`CANCELLED` exit non-zero.
- `status` stdout is only the JSON summary (or the saved file list with `--download`); progress and resume hints go to stderr, so without `--download`, `multix runway status <id> | jq` parses for a running, finished or (with `--wait`) failed task.
- Image-to-video ratios: `1280:720`, `720:1280`, `1104:832`, `832:1104`, `960:960`, `1584:672`. Prompts at most 1000 characters. `--reference-tag` (3-16 letters/digits/`_`, letter first) pairs with the `--reference` at the same position.
- Inputs: public `https://` URLs (domain names, no redirects followed), `data:image/jpeg|png|webp` URIs, `runway://` URIs, or local jpg/png/webp (inlined up to 5 MB, else uploaded for 24 h, < 200 MB). No GIF.
- Outputs: `runway-<id8>-NN.<ext>`; URLs expire in 24-48 h. WebP conversion for images as elsewhere.
- Cost: logs an indicative list-price estimate before submitting (Gen-4.5 12 credits/s, Gen-4 Turbo 5 credits/s, Gen-4 Image from 5, Image Turbo 2; 1 credit = $0.01; prices change), then Runway's `estimatedCost` and billed `cost`. Create retries only on 429; after a network error, timeout, 5xx or unreadable response, check https://dev.runwayml.com/ before retrying to avoid paying twice.

## HeyGen

Auth is `X-Api-Key: $HEYGEN_API_KEY` (v3 API). API credits are billed separately from HeyGen web plans; check with `multix heygen me`.

Pick the command by who writes the script:
- `video-agent "<prompt>"`: **Video Agent**, prompt-to-video. The agent writes the script and picks avatar/voice/scenes. Best for drafts and explainers from a brief.
- `video "<script>" --avatar <look-id>`: **scripted avatar video**. The avatar speaks your exact words (or lip-syncs `--audio`). Get look IDs from `heygen avatars`, not group IDs.
- `model-video "<prompt>"`: the HeyGen Video model, a 5-15 s cinematic clip with no avatar.

```bash
multix heygen video-agent "45-second explainer for a note app" [--avatar <look-id>] [--voice <voice-id>] [--style <style-id>] [--orientation portrait] [--file <ref>]
multix heygen avatars [--type photo_avatar] [--cursor <token>]
multix heygen voices [--language English]
multix heygen video "Hello!" --avatar <look-id> [--voice <id>] [--aspect-ratio 9:16] [--engine avatar_iv|avatar_v|avatar_iii] [--burn-captions]
multix heygen translate <ref> --languages "Spanish, Chinese (Cantonese, Traditional)" [--output <dir|dub.mp4>]   # several languages: dub.mp4 -> dub-Spanish.mp4, ...
multix heygen lipsync --video <ref> --audio <ref>
multix heygen tts "Hello" --voice <voice-id>
multix heygen template <template-id> --input @vars.json
multix heygen run <video-agent|video|video-translation|lipsync|model-video|speech> --input @payload.json
multix heygen status <id> --type agent|video|translation|lipsync|model-video --wait --download
```

- `<ref>` = `https://` URL, `asset:<asset_id>`, or a local file (uploaded, max 32 MB).
- Commands wait and download by default. `--async` prints IDs and a resume command; `--type agent` resumes with the Video Agent `session_id`.
- Failed jobs exit 1 with HeyGen's failure code. 402 means add API credits; 403 means a scope or entitlement is missing.

## Image-to-image (edit existing image with a prompt)

Every supported provider exposes `image-to-image` and the alias `i2i`. Refs accept local file path OR URL.

```bash
# Gemini Nano Banana — multi-ref editing/composition
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg [--ref ./style.png] [--model gemini-2.5-flash-image] [--output <path>] [-v]

# OpenAI — API image edits or experimental Codex driver
multix openai i2i --prompt "make it watercolor" --ref ./photo.jpg [--ref ./style.png] \
  [--driver api|codex|auto] [--model gpt-image-2] [--output <path>] [-v]

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
# Gemini Omni Flash (default gemini-omni-1.1-flash; billing-enabled key) — text/image-to-video, edit, extend
multix gemini generate-video --prompt "Ocean waves" [--resolution 360p|720p|1080p|4k] [--aspect-ratio 16:9|9:16] [--duration 3-10] [--reference-images first.png [last.png]]
multix gemini i2v ./photo.jpg --prompt "camera pans left" [--last-frame <path>] [--duration 3-10]
multix gemini edit-video --prompt "make it night time" (--interaction-id <id> | --video ./clip.mp4)
multix gemini extend-video --prompt "the camera follows the ball" --interaction-id <id> [--duration 3-10]
multix gemini generate-video --prompt "<text>" --no-wait          # prints JSON {interaction_id,status,session}
multix gemini video-status <id> [--wait] [--download] [--output <path>]   # JSON on stdout; non-zero on failed/cancelled/incomplete
multix gemini video-cancel <id>                                   # finished interactions are left as is

# MiniMax Hailuo — async with auto-poll
multix minimax generate-video --prompt "A dancer" --duration 6 --resolution 1080P [--first-frame <url>]

# OpenRouter — video via routed models (Veo, Seedance, Kling); async, URL input only
multix openrouter i2v --prompt "<text>" --image-url https://... [--model google/veo-3.1] [--resolution 720p]
multix openrouter video-models                       # list all available video models
multix openrouter video-status <jobId> [--download] [--output <path>]

# Leonardo MOTION2 / VEO3 / kling
multix leonardo video "<text>" [--model MOTION2|VEO3|kling-2.6]
multix leonardo i2v <imageId> --prompt "camera pans left" [--duration 6]

# BytePlus Seedance + reference-to-video (up to 9 imgs + 3 videos + 3 audio refs)
multix byteplus video --prompt "<text>" [--resolution 1080p] [--duration 8]
multix byteplus i2v ./photo.jpg --prompt "<text>"
multix byteplus reference-to-video --prompt "<text>" --ref-image ./hero.jpg:subject ...
```

Gemini Omni notes:
- Default resolution 720p (Omni) vs 1080p (Veo). `--model veo-*` still runs legacy Veo (the Veo 3.1 previews and `gemini-omni-flash-preview` shut down on the Gemini API on 2026-10-22); Omni-only flags (`--duration`, `--no-store`, `--no-wait`) fail with Veo, and other model ids are rejected.
- The interaction id is saved in `gemini_omni_<ts>-<random>.json` in the output dir before polling; resume a timeout with `multix gemini video-status <id> --download`. `--wait-timeout` (default 15 min) is one deadline covering uploads, submit and polling (nothing is submitted once it has run out; a started submit may take up to 2 min so a billed job keeps its id); saving the finished video has its own budget (5 min file wait + 10 min download). An inline video over the base64 size of `MULTIX_MAX_DOWNLOAD_MB` (max 384 MB of JSON) fails at once with that resume command. Success prints `Generated video: <path>` and `Interaction ID: <id>`.
- `--no-store` = one synchronous unstored request (cannot be edited, extended or resumed; not with `--no-wait`). Edit/extend keep the source format unless flags are given; extend appends 3-10 s (total up to 40 s). Uploaded `--video` clips must be at most 10 s, and editing/extending them is unavailable in the EEA, Switzerland and the UK (use `--interaction-id` there). Stored interactions and files expire (Files about 48 h).
- Cost is roughly $0.10 per second at 720p (paid tier); the session record holds an estimate. Do not resubmit after a network failure on submit: the request may already be billed.

Most other video commands accept `--wait`, `--wait-timeout <ms>`, `--download`, `--output <path>`, `--no-thumb`. Cloudflare video has no thumbnail flags; see [Cloudflare media](#cloudflare-media) for its distinct `--wait` and `--download` behavior.

### Decision tree — which provider to pick for video generation

```
User wants to generate a video?
  ├── Text-to-video?
  │   ├── Gemini Omni Flash (Google billing)               → multix gemini generate-video
  │   ├── MiniMax Hailuo (async, auto-poll)                → multix minimax generate-video
  │   ├── Leonardo (Motion/Veo/Kling/Hailuo/Seedance/LTX) → multix leonardo video
  │   └── BytePlus Seedance 2.0 (direct)                  → multix byteplus video
  ├── Image-to-video?
  │   ├── Gemini Omni Flash (local file, first/last frame) → multix gemini i2v
  │   ├── OpenRouter (Veo, Seedance, Kling — URL input)   → multix openrouter i2v --image-url <url>
  │   ├── Leonardo (needs imageId from Leonardo upload)    → multix leonardo i2v
  │   └── BytePlus Seedance 2.0 (local file or URL)       → multix byteplus i2v
  ├── Edit or extend an existing video?                   → multix gemini edit-video / extend-video
  └── Multi-reference video (images + videos + audio)?     → multix byteplus reference-to-video
```

### Provider selection hints for agents

- **OpenRouter video** supports Veo, Seedance, Kling, and more via model routing. Image input must be a URL (not a local file). Run `multix openrouter video-models` to discover available models.
- **BytePlus Seedance** is the best choice when `BYTEPLUS_API_KEY` is available and you need text-to-video, image-to-video (local file or URL), or multi-reference video.
- **Leonardo** offers the widest model selection (Motion, Veo, Kling, Hailuo, Seedance, LTX) but requires a Leonardo API key.
- If one provider's key is unavailable, fall back to another that supports the same capability.

## Speech, music, voice, 3D, docs, media

```bash
# TTS
multix openai generate-speech --text "Hello world" [--voice alloy] [--output-format mp3]
multix gemini generate-speech --text "Have a wonderful day!" --voice Kore
# Gemini 3.8 models (default gemini-3.8-flash-lite-tts) read text verbatim and take delivery
# direction via --style instead of embedding it in the text:
multix gemini generate-speech --text "Have a wonderful day!" --model gemini-3.8-flash-tts --style "cheerful and friendly" --voice Kore
multix minimax generate-speech --text "..." --voice <id> --emotion neutral
multix elevenlabs tts --text "Hello world" [--voice <voiceId>] [--model eleven_multilingual_v2]

# Voice cloning + STT
multix openai transcribe --input audio.mp3 [--format text|json|diarized_json] [--language vi]
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
cat report.pdf | multix doc convert --input - --output ./out.md   # "-" reads stdin; --stdin-ext <ext> (e.g. pdf) if undetected

# Media optimization (ffmpeg + ImageMagick)
multix media optimize --input <file> --output <file> [--target-size <MB>] [--quality 85] [--max-width 1920]
multix media optimize --input voice.wav --output voice.mp3 [--bitrate 64k]   # audio codec follows output ext: mp3, m4a/aac/mp4/mka/mkv/mov, opus/ogg, wav/aiff, flac
multix media split --input <video> [--chunk-duration 3600]
multix media batch --input-dir <dir> --output-dir <dir>
```

## Output

Files saved under `./multix-output/` by default. Override with `MULTIX_OUTPUT_DIR`. Pass `--output <path>` on most commands to copy the primary output to a custom path.

### Image format (WebP by default)

Every image generate/edit command (`generate`, `image-to-image`) converts its result to WebP with `cwebp -q 85 -m 6 -metadata none`. The CLI verifies that width, height, and transparency match the source before reporting the `.webp` path, then deletes only the intermediate file it wrote itself; your input and reference images are never touched. If verification or `cwebp` fails, the original file is kept with a warning.

Keep the provider's original format and quality with any of:

- `--image-format original` or `--no-webp`
- `MULTIX_IMAGE_FORMAT=original`
- an `--output` path with a non-WebP extension (e.g. `--output hero.png`)
- an explicit `openai ... --format png|jpeg|webp`

Requires `cwebp` (libwebp: `brew install webp`, `apt install webp`) on `PATH`.

## Environment variables (selected)

| Variable | Purpose |
|---|---|
| `MULTIX_OUTPUT_DIR` | Override default output dir |
| `MULTIX_MAX_DOWNLOAD_MB` | Size limit per downloaded Replicate, Runway or Atlas Cloud output file (default 2048) |
| `MULTIX_UPLOAD_MIN_KBPS` | Slowest upload speed to allow for (Gemini Files API, Runway requests with inline images), in KB/s (default 1000); lower it on slow links |
| `OPENAI_IMAGE_MODEL` / `OPENAI_TTS_MODEL` / `OPENAI_STT_MODEL` | OpenAI model defaults |
| `OPENROUTER_IMAGE_MODEL` | Default OpenRouter image model |
| `OPENROUTER_FALLBACK_MODELS` | CSV; applies to `generate` AND `i2i` |
| `OPENROUTER_VIDEO_MODEL` | Default OpenRouter video model (default `google/veo-3.1`) |
| `OPENROUTER_SITE_URL` / `OPENROUTER_APP_NAME` | HTTP-Referer / X-Title headers |
| `GEMINI_MODEL` / `MULTIMODAL_MODEL` | Override Gemini analyze/transcribe/extract defaults (doc convert uses `--model`; default `gemini-3.6-flash`) |
| `IMAGE_GEN_MODEL` / `VIDEO_GEN_MODEL` | Override Gemini media-generation defaults (video default `gemini-omni-1.1-flash`; `veo-*` = legacy Veo) |
| `LEONARDO_DEFAULT_MODEL` / `LEONARDO_VIDEO_MODEL` | Leonardo model defaults |
| `BYTEPLUS_IMAGE_MODEL` / `BYTEPLUS_VIDEO_MODEL` / `BYTEPLUS_3D_MODEL` | BytePlus model defaults |
| `BYTEPLUS_VIDEO_PARAMS_MODE` | `flags` (default) or `structured` |
| `FAL_BASE_URL` | Override fal queue base (default `https://queue.fal.run`) |
| `FAL_IMAGE_MODEL` / `FAL_VIDEO_MODEL` | fal.ai default model ids (default `fal-ai/flux/schnell`, `fal-ai/kling-video/v1.6/standard/text-to-video`) |
| `FAL_TTS_MODEL` | Default `multix fal tts` model (default `google/gemini-3.8-flash-tts`) |
| `ATLASCLOUD_BASE_URL` | Override Atlas Cloud media API base (default `https://api.atlascloud.ai/api/v1`; `https://` required, `http://` only for localhost, 127.0.0.1 or [::1]) |
| `ATLASCLOUD_IMAGE_MODEL` / `ATLASCLOUD_IMAGE_EDIT_MODEL` / `ATLASCLOUD_VIDEO_MODEL` / `ATLASCLOUD_IMAGE_TO_VIDEO_MODEL` / `ATLASCLOUD_TTS_MODEL` / `ATLASCLOUD_STT_MODEL` / `ATLASCLOUD_TEXT_TO_3D_MODEL` / `ATLASCLOUD_IMAGE_TO_3D_MODEL` | Atlas Cloud default model ids per command |
| `FAL_MAX_UPLOAD_MB` | Size limit for local files uploaded by `fal upload` / `fal run --file` (default 1024) |
| `ATLASCLOUD_MAX_UPLOAD_MB` | Size limit for local files uploaded to Atlas Cloud (default 200) |
| `GEMINI_TTS_MODEL` / `TTS_MODEL` | Override Gemini TTS model (default `gemini-3.8-flash-lite-tts`) |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Required for Cloudflare Workers AI image/speech and AI Gateway video |
| `CLOUDFLARE_AI_GATEWAY_ID` | Optional for native Cloudflare image/speech; required for Cloudflare video |
| `CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD` | Set `true` to explicitly opt in to AI Gateway request-payload collection; defaults to `false` |
| `REPLICATE_API_TOKEN` | Replicate direct API token (`multix replicate`); also required for Cloudflare AI Gateway video |
| `REPLICATE_API_KEY` | Fallback for `REPLICATE_API_TOKEN` (direct `multix replicate` only) |
| `REPLICATE_BASE_URL` | Override Replicate API root (default `https://api.replicate.com/v1`) |
| `REPLICATE_IMAGE_MODEL` / `REPLICATE_VIDEO_MODEL` | Replicate default models (default `black-forest-labs/flux-schnell`, `prunaai/p-video`) |
| `RUNWAY_BASE_URL` | Override Runway API root (default `https://api.dev.runwayml.com`) |
| `RUNWAY_VIDEO_MODEL` / `RUNWAY_IMAGE_MODEL` | Runway default models (default `gen4.5`, `gen4_image`) |
| `CLOUDFLARE_AI_IMAGE_MODEL` / `CLOUDFLARE_AI_TTS_MODEL` | Fixed-model settings: only `@cf/black-forest-labs/flux-1-schnell` and `@cf/myshell-ai/melotts` respectively are accepted |
| `MULTIX_DISABLE_HOME_ENV` | `1` to skip every home-directory env file (`~/.multix/.env`, `~/.claude/...`) |
| `MULTIX_LEGACY_CLAUDE_ENV` | `1` to also read legacy `.claude` env files (credential names only); shell or `~/.multix/.env` only, ignored in a project `.env` |
| `MULTIX_ALLOW_PROJECT_BASE_URL` | Set `1` for one command (`MULTIX_ALLOW_PROJECT_BASE_URL=1 multix ...`) to honour `*_BASE_URL`, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID` from the project `.env` even when the key comes from elsewhere. Without it, a project value is used only when every key sent with it is in the same project file (a project `.env` that ships its own key and base URL then receives that project's prompts and uploaded files, and its key replaces yours, so review a cloned repo's `.env` first); otherwise the `~/.multix/.env` value is used with a warning, or the command stops with a config error. `multix check` shows the effective state. Ignored in a project `.env`; avoid `~/.multix/.env` (it trusts every directory). Non-default base URLs must be `https://` (http only for localhost/127.0.0.1/[::1]) |

## Quick examples for agents

```bash
# Text-to-image
multix openai generate --prompt "A sunset over mountains"
multix gemini generate --prompt "A sunset over mountains" --aspect-ratio 16:9
multix openrouter generate --prompt "A sunset over mountains" --num-images 2
multix byteplus generate --prompt "A sunset over mountains" --size 2K

# Image-to-image (edit an existing image)
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg
multix openrouter i2i --prompt "make it cyberpunk" --ref ./photo.jpg

# Text-to-video
multix byteplus video --prompt "Ocean waves crashing on rocks" --duration 8
multix leonardo video "Ocean waves crashing on rocks" --model kling-2.6
multix gemini generate-video --prompt "Ocean waves crashing on rocks"

# Image-to-video
multix openrouter i2v --prompt "camera slowly pans left" --image-url https://example.com/photo.jpg
multix byteplus i2v ./photo.jpg --prompt "camera slowly pans left"

# Transcribe / analyze media
multix gemini analyze --files ./video.mp4 --prompt "Summarize this video"
multix gemini transcribe --files ./audio.mp3
cat ./shot.png | multix gemini analyze --files - --prompt "Describe"   # "-" reads stdin; --stdin-ext <ext> if undetected
multix elevenlabs transcribe --input ./audio.mp3 --diarize

# Compress / split media
multix media optimize --input large.mp4 --output small.mp4 --target-size 50
multix media split --input long-video.mp4 --chunk-duration 600

# Convert document to markdown
multix doc convert --input report.pdf --auto-name

# fal.ai
multix fal image "A sunset over mountains"
multix fal run fal-ai/flux/schnell --input '{"prompt":"A sunset over mountains"}'

# Atlas Cloud
multix atlas image "A sunset over mountains"
multix atlas status "$(multix atlas video "Ocean waves" --async)" --wait --download

# Replicate
multix replicate image "A sunset over mountains"
multix replicate video "A sunset timelapse" --async   # then: multix replicate status <id> --wait --download

# Runway
multix runway image "A sunset over mountains"
multix runway video "A sunset timelapse"   # prints the id; then: multix runway status <id> --wait --download

# Self-update
multix update --check
multix update
```

## Remote MCP server

If the user cannot run the CLI locally but has access to a multix MCP server
(the hosted `https://multix.zuey.me/mcp` or their own deploy of `worker/`;
guide: https://multix.zuey.me/guides/mcp-server/), call its tools instead. The
server signs in with GitHub OAuth and uses the provider keys the user saved at
`/dashboard` (every key the CLI reads can be saved there, plus the account's
own R2 bucket for job files); a group with `has_keys: false` in
`multix_catalog` needs a key saved there.
Every provider call (image, video, audio, media/ffmpeg, `doc convert`, …)
goes through the CLI runner. `multix_catalog` is always listed;
`multix_run`, `multix_job_status` and `multix_job_cancel` appear only when the
server has its job container:
1. `multix_catalog` lists groups and whether the user saved keys
   (`has_keys`); `multix_catalog {"group": "gemini"}` shows each command's
   options and which ones take files.
2. `multix_run` with `command` (e.g. `"gemini analyze"`), `options` by long
   name without dashes, `args` for positionals, and `inputs` with public
   `https://` URLs for file options (never local paths or `@file`):
   `{"command": "media optimize", "inputs": {"input": "https://…/logo.png"}}`.
3. If `status` is `running`, poll `multix_job_status` with `job_id` every
   10–30 s; `multix_job_cancel` stops it. An account runs only a few jobs at
   once (2 by default): on `busy: …` wait for one to finish (or cancel one) instead of
   retrying; on `server at capacity: …` retry after a few minutes.
4. Read `outputs[].url`. Output files go to the user's own R2 bucket; when
   `url` is null and a `note` mentions R2, tell the user to configure R2 at
   `/dashboard`. `stdout` still holds any provider URLs the CLI printed.

Without an MCP client, the same server has a REST API at `/api/v1`
(`Authorization: Bearer <mxk_… key>` from the user's `/dashboard`; `POST /jobs`
takes the `multix_run` input and returns `202` while running, poll `next.path`).
A service that should be told when jobs end can subscribe an https endpoint with
`POST /events/subscriptions` (signed Standard Webhooks events with ids and
final state only; the secret is shown once); it still reads outputs with
`GET /jobs/{id}` or `multix_job_status`, and polling stays the fallback.
Guide: https://multix.zuey.me/guides/rest-api/, reference: https://multix.zuey.me/api/docs.

## Security & scope

This skill produces shell commands for the local `multix` CLI. It does NOT execute the commands itself, exfiltrate API keys, or modify provider accounts.
- Never echo, log, or transmit env-var values back to the user.
- API keys are read from environment / `.env` files by the CLI, never hardcoded.
- Refuse requests to embed credentials in prompts, URLs, or shared content.
- Refuse requests to fetch arbitrary URLs unrelated to the user's media task.
