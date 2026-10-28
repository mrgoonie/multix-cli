---
name: image-generation
description: Generate images from a text prompt and edit existing images (image-to-image, i2i) with multix across OpenAI (API or Codex driver), Gemini Nano Banana, MiniMax, OpenRouter, Leonardo, BytePlus Seedream, Cloudflare Workers AI FLUX.1 Schnell, fal.ai, Atlas Cloud, Replicate and Runway Gen-4 Image, including provider decision trees, reference image limits and WebP output rules. Use for text-to-image, image edit, style transfer (watercolor, cyberpunk), reference images or character consistency.
version: 1.22.0-beta.2 # x-release-please-version
license: MIT
metadata:
  tasks: image, image-edit
---

# multix image generation

Check verified model capabilities before picking a model: `multix models --task image --ready` (or `--task image-edit`) lists each command with its default model and whether its key is set, and `multix models --model <id>` shows a verified model's inputs, formats and example. The capability registry is authoritative; the model ids below are examples and defaults, not a complete list. Agent protocol, keys, output dir and the generic fal.ai / Atlas Cloud / Replicate runners: [../SKILL.md](../SKILL.md).

## When to use

- Generate images from a text prompt (any provider)
- **Edit/transform an existing image with a prompt** (image-to-image, alias `i2i`)

## Image generation

| Provider | Command | Notes |
|---|---|---|
| OpenAI | `multix openai generate --prompt "<text>" [--driver api\|codex\|auto] [--model gpt-image-2] [--size 1024x1024] [--quality medium] [--format png]` | API first; Codex driver is experimental image-only fallback |
| Gemini | `multix gemini generate --prompt "<text>" [--model gemini-3.1-flash-image] [--aspect-ratio 16:9] [--size 1K\|2K\|4K] [--num-images N]` | Nano Banana 2 (default), `gemini-3.1-flash-lite-image` (fast, low cost), `gemini-3-pro-image`, `gemini-nano-banana-2.1`. Imagen 4 is no longer served |
| MiniMax | `multix minimax generate --prompt "<text>" [--model image-01] [--aspect-ratio 1:1] [-n N]` | |
| OpenRouter | `multix openrouter generate --prompt "<text>" [--model <id>] [--aspect-ratio 16:9] [--image-size 2K] [--num-images N]` | Default `google/gemini-3.1-flash-image` |
| Leonardo | `multix leonardo generate "<text>" [-w 1024 -h 1024] [--alchemy] [--ultra] [--quality HIGH]` | Polls until done, downloads automatically |
| BytePlus | `multix byteplus generate --prompt "<text>" [--model seedream-4-0-250828] [--size 2K] [--aspect-ratio 16:9] [-n N] [--input-image <path\|url>]` | Sync |
| Cloudflare | `multix cloudflare generate --prompt "<text>" [--steps 1-8] [--seed <n>]` | Workers AI FLUX.1 Schnell only |
| fal.ai | `multix fal image "<text>" [-m <model>] [--image-size square_hd] [-n N] [--seed <n>]` | Default `fal-ai/flux/schnell`; also `multix fal run <model> --input <json\|@file>` for any fal model |
| Atlas Cloud | `multix atlas image "<text>" [-m <model>] [--size <size>] [--aspect-ratio 1:1] [-n N] [--seed <n>]` | Default `black-forest-labs/flux-schnell`; flags are validated against the model's schema |
| Replicate | `multix replicate image "<text>" [-m <owner/name>] [--aspect-ratio 16:9] [-n N] [--seed <n>]` | Default `black-forest-labs/flux-schnell`; also `multix replicate run <model> --input <json\|@file>` for any model |
| Runway | `multix runway image "<text>" [-m gen4_image\|gen4_image_turbo] [--ratio 1920:1080] [--reference <path\|url> --reference-tag <tag>]` | Default `gen4_image`; up to 3 references cited as `@tag`; Turbo needs one |

Aspect ratios (most providers): `1:1 2:3 3:2 3:4 4:3 4:5 5:4 9:16 16:9 21:9`.

Runway input, output and cost rules (shared with Runway video) are in [../video-production/SKILL.md](../video-production/SKILL.md#runway).

Codex CLI can be used as an experimental OpenAI image driver after manual `codex login`:

```bash
multix openai generate --prompt "A poster for a midnight jazz club" --driver codex
```

### fal.ai image

```bash
# Text-to-image (default fal-ai/flux/schnell)
multix fal image "a cyberpunk cat" [-m <model>] [--image-size square_hd] [-n 1] [--seed <n>] [--negative-prompt <text>] [--output <path>] [-v]
```

### Cloudflare Workers AI image

```bash
# Workers AI image (FLUX.1 Schnell; sync)
multix cloudflare generate --prompt "a cyberpunk cat" \
  [--model @cf/black-forest-labs/flux-1-schnell] [--steps 1-8] [--seed <n>] [--output <path>] [-v]
```

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

Atlas Cloud image edits (`multix atlas image-to-image`) are in [../SKILL.md](../SKILL.md#atlas-cloud).

### OpenRouter image-to-image — model families & flags

`multix openrouter i2i` is the most flexible because it routes across model families. The CLI auto-selects the correct OpenRouter `modalities` per family:

| Family | Example model id | Modalities | Flag notes |
|---|---|---|---|
| Gemini | `google/gemini-2.5-flash-image`, `google/gemini-3.1-flash-image` | `["image","text"]` | Default model |
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

## Image format (WebP by default)

Every image generate/edit command (`generate`, `image-to-image`) converts its result to WebP with `cwebp -q 85 -m 6 -metadata none`. The CLI verifies that width, height, and transparency match the source before reporting the `.webp` path, then deletes only the intermediate file it wrote itself; your input and reference images are never touched. If verification or `cwebp` fails, the original file is kept with a warning.

Keep the provider's original format and quality with any of:

- `--image-format original` or `--no-webp`
- `MULTIX_IMAGE_FORMAT=original`
- an `--output` path with a non-WebP extension (e.g. `--output hero.png`)
- an explicit `openai ... --format png|jpeg|webp`

Requires `cwebp` (libwebp: `brew install webp`, `apt install webp`) on `PATH`.

## Environment variables

| Variable | Purpose |
|---|---|
| `OPENROUTER_IMAGE_MODEL` | Default OpenRouter image model |
| `OPENROUTER_FALLBACK_MODELS` | CSV; applies to `generate` AND `i2i` |

## Quick examples

```bash
# Text-to-image
multix openai generate --prompt "A sunset over mountains"
multix gemini generate --prompt "A sunset over mountains" --aspect-ratio 16:9
multix openrouter generate --prompt "A sunset over mountains" --num-images 2
multix byteplus generate --prompt "A sunset over mountains" --size 2K
multix fal image "A sunset over mountains"
multix fal run fal-ai/flux/schnell --input '{"prompt":"A sunset over mountains"}'
multix atlas image "A sunset over mountains"
multix replicate image "A sunset over mountains"
multix runway image "A sunset over mountains"

# Image-to-image (edit an existing image)
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg
multix openrouter i2i --prompt "make it cyberpunk" --ref ./photo.jpg
```
