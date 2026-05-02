# Phase 05 — OpenRouter Provider

## Context
- Plan: [plan.md](plan.md)
- Source: `openrouter_generate.py` — see scout §4.
- Depends on: phase-02.

## Overview
- Priority: P2
- Status: pending
- Goal: port OpenRouter image generation as `multix openrouter generate ...`.

## Key Insights
- Endpoint: `POST https://openrouter.ai/api/v1/chat/completions` — image gen via chat completions multimodal.
- Default model: `google/gemini-3.1-flash-image-preview`.
- Custom headers: `HTTP-Referer` (env `OPENROUTER_SITE_URL`), `X-Title` (env `OPENROUTER_APP_NAME`, default `multix`).
- Response: `choices[0].message.images[].image_url.url` — may be data URL or http URL; download/decode and save PNG.
- Fallback models supplied via env `OPENROUTER_FALLBACK_MODELS` (csv) — pass as `models[]` array in payload.

## Requirements
Subcommand:
- `multix openrouter generate --prompt <str> [--model] [--aspect-ratio] [--image-size] [--num-images] [--output] [-v]`
- env: `OPENROUTER_API_KEY`, `OPENROUTER_IMAGE_MODEL`, `OPENROUTER_FALLBACK_MODELS`, `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`.

## Architecture
```
src/providers/openrouter/
  client.ts        # buildPayload, postChatCompletion, extractImageBytes
  schemas.ts
  commands/
    generate.ts
    index.ts       # registerOpenRouterCommands(program)
```
Data flow: parse → validate → build payload → fetch → loop until N images collected → save PNGs to output dir.

## Related Code Files
Create: `src/providers/openrouter/**`.
Modify: `src/commands/index.ts` — register.

## Implementation Steps
1. Constants: `OPENROUTER_API_URL`, `DEFAULT_OPENROUTER_MODEL`.
2. `client.ts`:
   - `buildPayload({prompt, model, aspectRatio, imageSize, fallbackModels})`
   - `postChatCompletion(payload, apiKey)` returning array of image URLs.
   - `extractImageBytes(url)` — handle `data:` prefix vs http.
3. `commands/generate.ts`: loop until `numImages` collected (mirror Python behaviour); save each PNG to output dir; copy first to `--output` if provided.
4. Register `openrouter` group.

## Todo List
- [ ] client.ts
- [ ] schemas.ts
- [ ] commands/generate.ts
- [ ] register

## Success Criteria
- `multix openrouter generate --prompt "x" -v` (mocked) writes file under `multix-output/` and exits 0.
- Fallback models from env appended to payload.

## Risk Assessment
| Risk | L | I | Mitigation |
|------|---|---|-----------|
| API returns 0 images for non-image-capable model | M | M | Detect empty `images[]` → error with model name |
| Data URL parsing edge case (no comma) | L | L | Defensive split; unit test |
| Large image base64 memory spike | L | L | Decode once, write stream |

## Security Considerations
- `OPENROUTER_API_KEY` env-only.
- `HTTP-Referer` set only if user provides `OPENROUTER_SITE_URL`.

## Next Steps
phase-09 tests; phase-10 docs.
