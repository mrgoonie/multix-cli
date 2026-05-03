---
phase: 2
title: "Seedream image generate"
status: completed
priority: P1
effort: "3h"
dependencies: [1]
---

# Phase 2: Seedream image generate

## Overview
Implement `multix byteplus generate` — text-to-image and multi-image input via Seedream 4.0. Sync call, downloads result to `MULTIX_OUTPUT_DIR`.

## Requirements
- `multix byteplus generate --prompt "..." [opts]` produces JPEG file(s)
- Support multi-image input (Seedream's edit/fusion mode)
- Aspect ratio + size options
- `--num-images`, `--seed`, `--watermark`/`--no-watermark`

## Architecture
Endpoint: `POST {base}/images/generations` (OpenAI-compat).
Request body:
```json
{
  "model": "seedream-4-0-250828",
  "prompt": "...",
  "image": ["url-or-base64", ...],
  "size": "2K" | "1024x1024",
  "response_format": "url" | "b64_json",
  "watermark": true,
  "seed": 12345,
  "n": 1
}
```
Response: `{ data: [{ url? , b64_json? }, ...] }`. Use `response_format=url` then download via existing `core/http-client` utility (or fetch + write file). Reuse `output-dir.ts` for save path.

## Related Code Files
**Create:**
- `src/providers/byteplus/commands/generate.ts` — Commander subcommand definition + handler
- `src/providers/byteplus/generators/image.ts` — pure function `generateSeedream(client, opts) → SavedFile[]`

**Modify:**
- `src/providers/byteplus/commands/index.ts` — register `generate`
- `src/providers/byteplus/types.ts` — extend with Seedream-specific request fields if needed

## Implementation Steps
1. Define `GenerateImageOptions` interface in `generators/image.ts`: `prompt, model?, size?, aspectRatio?, numImages?, seed?, watermark?, inputImages?, output?, logger`.
2. Map `--aspect-ratio 16:9` → BytePlus `size` string. Accept both `--size 2K|1K|4K|WxH` and `--aspect-ratio` (mutually exclusive; warn if both).
3. POST to `/images/generations`, force `response_format: "url"`.
4. For each returned URL, download bytes (`core/http-client` or `fetch`) and write to `MULTIX_OUTPUT_DIR/byteplus-image-{ts}-{i}.jpg`. Allow `--output <path>` for single-image override.
5. Pretty-print: model used, prompt, output paths, seed (if returned).
6. Wire Commander: `multix byteplus generate --prompt <p> --model <m> --size <s> --aspect-ratio <r> --num-images <n> --seed <n> --no-watermark --input-image <path|url...> --output <path> -v`.
7. `--input-image` is repeatable; resolve each via the helper from Phase 4 if it exists, otherwise inline base64 (extract helper if needed early — coordinate with Phase 4).
8. Handle errors: `HttpError` 401 → "check BYTEPLUS_API_KEY"; 429 → mention 500 IPM rate limit.

## Success Criteria
- [ ] `multix byteplus generate --prompt "a sunset"` saves a JPEG to `multix-output/`
- [ ] `--num-images 3` saves 3 files
- [ ] `--aspect-ratio 16:9` and `--size 2K` both work
- [ ] `--input-image ./photo.jpg` performs image edit
- [ ] `-v` logs request/response summary, redacted key
- [ ] `npm run build` and `npm test` pass

## Risk Assessment
- **`size` vs `aspect_ratio` ambiguity** — official Seedream takes `size` only ("1024x1024", or named "1K"/"2K"/"4K"). Compute size from aspect_ratio + a target long edge. Document mapping in code comments.
- **Multi-image edit semantics** — exact field name (`image` array vs `images`) needs first-call verification. Add `-v` request body logging early to debug.
- **Watermark default** — assume `true` server-side; expose `--no-watermark` to override.
