---
phase: 4
title: "Image-to-video helper"
status: completed
priority: P1
effort: "3h"
dependencies: [3]
---

# Phase 4: Image-to-video helper

## Overview
`multix byteplus image-to-video <imagePath|url> --prompt "..."` (alias `i2v`). Adds local-path-or-URL helper used by both i2v and reference-to-video.

## Requirements
- Accept local file path OR `https?://` URL
- Local path → read + base64 + content-type detection (jpg/png/webp)
- URL → pass through unchanged
- Reuse video task submit/poll/download from Phase 3
- All Phase 3 flags supported (`--async`, `--wait-timeout`, etc.)

## Architecture
New helper `image-input.ts` exposes:
```ts
export type ResolvedImage =
  | { kind: "url"; url: string }
  | { kind: "data"; dataUrl: string; mime: string };

export async function resolveImageInput(input: string): Promise<ResolvedImage>;
```
Detection: `^https?://` → url; else read file, infer MIME from extension (`.jpg|.jpeg→image/jpeg`, `.png→image/png`, `.webp→image/webp`), base64-encode, return `data:<mime>;base64,<b64>` form.

Warn at `-v` if base64 payload >10MB. Hard error at >25MB (server reject).

i2v request body uses `content` array:
```json
{
  "model": "seedance-2.0",
  "content": [
    {"type": "text", "text": "prompt --rs 1080p ..."},
    {"type": "image_url", "image_url": {"url": "<https-or-data-url>"}}
  ]
}
```

## Related Code Files
**Create:**
- `src/providers/byteplus/image-input.ts` — `resolveImageInput`
- `src/providers/byteplus/commands/image-to-video.ts` — Commander subcommand + alias `i2v`

**Modify:**
- `src/providers/byteplus/commands/index.ts` — register `image-to-video` and `i2v` alias
- `src/providers/byteplus/generators/video.ts` — extend `buildVideoTaskBody` from Phase 3 to accept `imageInputs?: ResolvedImage[]` (shared with Phase 5 refs)
- `src/providers/byteplus/commands/generate.ts` (Phase 2) — refactor multi-image input to use `resolveImageInput` if not already

## Implementation Steps
1. Implement `resolveImageInput` with URL/path branching, MIME detection table, fs.promises.readFile + base64.
2. Add unit tests `tests/unit/byteplus/image-input.test.ts` covering: URL passthrough, jpg local file, unknown extension throws, missing file throws.
3. Refactor video body builder to accept `imageInputs?: ResolvedImage[]` → emit `content[]` with text + per-image entries.
4. Commander: `image-to-video <image> --prompt <p> [all video flags] [--last-frame <path|url>]`. Alias declared via `.alias("i2v")`.
5. If `--last-frame` provided: emit second `image_url` content with `role: "last_frame"` (or whatever ARK convention is — verify on first call; document in code).
6. Reuse `submitVideoTask` + `waitForVideoTask` (Phase 3) + `downloadVideo` directly. Output `byteplus-i2v-{ts}.mp4`.

## Success Criteria
- [ ] `multix byteplus i2v ./photo.jpg --prompt "camera pans left"` produces MP4
- [ ] `multix byteplus i2v https://example.com/img.jpg --prompt "..."` works without local file
- [ ] Unit tests for `resolveImageInput` pass
- [ ] >10MB warning at `-v`
- [ ] `--async` short-circuits
- [ ] Build + tests pass

## Risk Assessment
- **`image_url` payload field name** — ARK may expect `{ url: "..." }` (OpenAI-compat) or `{ image: "..." }`. Verify on first integration test; capture in `types.ts`.
- **Last-frame role naming** — speculative. If ARK doesn't support last-frame, drop the flag rather than fake it.
- **Base64 size** — large local images bloat memory + request. 25MB hard cap reflects typical API gateway limits.
