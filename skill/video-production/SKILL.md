---
name: video-production
description: Generate, edit and extend video with multix — text-to-video and image-to-video (i2v) on Gemini Omni Flash (plus legacy Veo), MiniMax Hailuo, OpenRouter (Veo, Seedance, Kling), Leonardo (Motion, Veo, Kling, Hailuo, Seedance, LTX), BytePlus Seedance reference-to-video, Cloudflare AI Gateway via Replicate, fal.ai and Runway Gen-4.5 / Gen-4 Turbo, plus HeyGen Video Agent, scripted avatar videos, video translation, dubbing and lipsync, and TopView product marketing videos, talking/product avatars, product photos and API Platform models (Seedance, Wan). Sume catalog video is in the root multix skill. Includes a provider decision tree and resume/cancel rules for async jobs.
version: 1.26.0-beta # x-release-please-version
license: MIT
metadata:
  tasks: video, image-to-video, video-edit, avatar-video
---

# multix video production

Check verified model capabilities before picking a model: `multix models --task video --ready` (or `--task image-to-video`, `video-edit`, `avatar-video`) lists each command with its default model and whether its key is set, and `multix models --model <id>` shows a verified model's inputs, formats and example. The capability registry is authoritative; the model ids below are examples and defaults, not a complete list. Agent protocol, keys, output dir and the generic fal.ai / Atlas Cloud / Replicate runners (including `atlas video`, `replicate video`): [../SKILL.md](../SKILL.md).

## When to use

- Generate video from text or from a reference image (image-to-video, alias `i2v`)
- **Edit or extend a Gemini Omni video** (`gemini edit-video`, `gemini extend-video`) and check/resume/cancel it (`gemini video-status`, `gemini video-cancel`)
- **Generate video via OpenRouter routed models** (Veo, Seedance, Kling — use `multix openrouter video-models` to list)
- **Generate video via BytePlus Seedance** directly (text-to-video, image-to-video, reference-to-video)
- **Generate video via Leonardo** (Motion, Veo, Kling, Hailuo, Seedance, LTX models)
- Generate Runway Gen-4.5 / Gen-4 Turbo video or Gen-4 images (with tagged reference images), or check/resume/cancel a Runway task by id
- Make HeyGen avatar videos from a prompt (Video Agent) or an exact script, translate/lipsync videos, HeyGen TTS
- Make TopView product marketing videos, talking or product avatar videos and product photos (Legacy API), or run TopView API Platform models such as Seedance, Wan and GPT Image 2 (`multix topview`)

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

# Text-to-video (default fal-ai/kling-video/v1.6/standard/text-to-video), or
# image-to-video with --image-url (default switches to fal-ai/kling-video/v1.6/standard/image-to-video when -m is omitted)
multix fal video "a dancer under neon lights" [-m <model>] [--image-url <https-url>] [--duration <n>] [--aspect-ratio 16:9] [--seed <n>] [-v]
```

Gemini Omni notes:
- Default resolution 720p (Omni) vs 1080p (Veo). `--model veo-*` still runs legacy Veo (the Veo 3.1 previews and `gemini-omni-flash-preview` shut down on the Gemini API on 2026-10-22); Omni-only flags (`--duration`, `--no-store`, `--no-wait`) fail with Veo, and other model ids are rejected.
- The interaction id is saved in `gemini_omni_<ts>-<random>.json` in the output dir before polling; resume a timeout with `multix gemini video-status <id> --download`. `--wait-timeout` (default 15 min) is one deadline covering uploads, submit and polling (nothing is submitted once it has run out; a started submit may take up to 2 min so a billed job keeps its id); saving the finished video has its own budget (5 min file wait + 10 min download). An inline video over the base64 size of `MULTIX_MAX_DOWNLOAD_MB` (max 384 MB of JSON) fails at once with that resume command. Success prints `Generated video: <path>` and `Interaction ID: <id>`.
- `--no-store` = one synchronous unstored request (cannot be edited, extended or resumed; not with `--no-wait`). Edit/extend keep the source format unless flags are given; extend appends 3-10 s (total up to 40 s). With `--interaction-id` the prompt is sent as `Edit this video: …` / `Extend this video: …` (the API takes no task there); `extend-video --video` rejects `--aspect-ratio`. Uploaded `--video` clips must be at most 10 s, and editing/extending them is unavailable in the EEA, Switzerland and the UK (use `--interaction-id` there). Stored interactions and files expire (Files about 48 h).
- Cost is roughly $0.10 per second at 720p (paid tier); the session record holds an estimate. Do not resubmit after a network failure on submit: the request may already be billed.

Most other video commands accept `--wait`, `--wait-timeout <ms>`, `--download`, `--output <path>`, `--no-thumb`. Cloudflare video has no thumbnail flags; see [Cloudflare video](#cloudflare-video) for its distinct `--wait` and `--download` behavior.

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

## Cloudflare video

Keys and the AI Gateway payload setting: [../SKILL.md](../SKILL.md#cloudflare-media).

```bash
# Replicate prunaai/p-video through Cloudflare AI Gateway; no native Workers AI video
multix cloudflare generate-video --prompt "Ocean waves" \
  [--duration 5] [--aspect-ratio 16:9] [--resolution 720p] [--fps 24] \
  [--wait] [--wait-timeout 600000] [--download] [--output <path>] [-v]
multix cloudflare video-status <predictionId> \
  [--wait] [--wait-timeout 600000] [--download] [--output <path>] [-v]
```

Video follows Cloudflare's documented [Replicate AI Gateway route](https://developers.cloudflare.com/ai-gateway/usage/providers/replicate/). `generate-video` returns a prediction ID unless `--wait` or `--download` is passed; either waits, saves the completed MP4, and prints its local path. For `video-status`, `--wait` reports the terminal status and `--download` implies waiting plus saves the MP4. No Cloudflare video command prints the provider output URL.

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

## TopView

Two APIs with separate keys and balances; neither key works on the other.
- **Legacy API** (`TOPVIEW_API_KEY` + `TOPVIEW_UID`, plan credits): `url-to-video`, `materials-to-video`, `m2v-export`, `video-avatar`, `product-avatar`, `product-anyshoot`, `status`, `upload`, `credit`.
- **API Platform** (`TOPVIEW_PLATFORM_API_KEY`, USD): `models`, `run`, `prediction`.

```bash
multix topview url-to-video <product-url> [--aspect-ratio 9:16] [--video-length-type 1-4] [--preview]
multix topview materials-to-video --file <path|url>... --product-name "<name>" --product-description "<text>"
multix topview video-avatar (--avatar-id <id> | --image <file> | --video <file>) (--tts-text "<text>" [--voice-id <id>] | --audio <file>)
multix topview product-avatar --product-image <file> --avatar-id <id> --image-edit-prompt "<text>" --mode avatar2|avatar4|avatar4Fast --tts-text "<text>" --voice-id <id>
multix topview product-anyshoot --mode try-on|background --product-image <file> ...
multix topview status <kind> <taskId> [--wait] [--download]
multix topview credit                        # remaining plan credits (a balance, not spend) and recent tasks
multix topview models [--refresh]            # verified API Platform routes with live prices (no key)
multix topview run <route> --input '<json>'|@body.json [--wait]
multix topview prediction <id> [--wait] [--download]
```

- No cancel endpoint on either API: a submitted task runs to completion and is billed.
- Legacy commands except `product-avatar` print the task ID unless `--wait`. `product-avatar` runs three paid tasks and always waits; after a failure, resume from the last good stage (`--bg-removed-file-id` or `--replace-image-id`) instead of starting over.
- Legacy submits have no idempotency key: after a network error, timeout or 5xx, check `multix topview credit` before retrying. `topview run` sends an `Idempotency-Key`; retry with `--idempotency-key <key>`.
- `payment_required` on a prediction means the workspace needs a top-up; do not resubmit, resume with `prediction <id> --wait`.
- Full reference: https://multix.zuey.me/commands/topview/

## Environment variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_VIDEO_MODEL` | Default OpenRouter video model (default `google/veo-3.1`) |

## Quick examples

```bash
# Text-to-video
multix byteplus video --prompt "Ocean waves crashing on rocks" --duration 8
multix leonardo video "Ocean waves crashing on rocks" --model kling-2.6
multix gemini generate-video --prompt "Ocean waves crashing on rocks"
multix atlas status "$(multix atlas video "Ocean waves" --async)" --wait --download
multix replicate video "A sunset timelapse" --async   # then: multix replicate status <id> --wait --download
multix runway video "A sunset timelapse"   # prints the id; then: multix runway status <id> --wait --download

# Image-to-video
multix openrouter i2v --prompt "camera slowly pans left" --image-url https://example.com/photo.jpg
multix byteplus i2v ./photo.jpg --prompt "camera slowly pans left"
```
