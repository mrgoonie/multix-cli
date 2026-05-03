---
phase: 5
title: "Reference-to-video"
status: completed
priority: P2
effort: "3h"
dependencies: [4]
---

# Phase 5: Reference-to-video

## Overview
Multimodal video gen with up to 12 references (≤9 images + ≤3 videos + ≤3 audio). Each ref carries an optional `role` (`subject`, `environment`, `style`, `audio`, etc.).

## Requirements
- `multix byteplus reference-to-video --prompt <p>` with repeatable `--ref-image`, `--ref-video`, `--ref-audio`
- Optional per-ref role via paired `--role` flags or `path:role` syntax
- ≤12 total refs enforced client-side
- Reuse video submit/poll/download
- Same async/wait-timeout/output flags as Phase 3-4

## Architecture
KISS approach for repeatable role pairing — adopt `path:role` colon syntax:
```
--ref-image ./hero.jpg:subject \
--ref-image ./bg.jpg:environment \
--ref-video ./style.mp4:style \
--ref-audio ./music.mp3:audio
```
Path with literal colon (Windows `C:\...`) → escape with `\:` or use repeated `--role` flags. Document edge case.

Body extension:
```json
{
  "model": "seedance-2.0",
  "content": [
    {"type": "text", "text": "prompt --rs 1080p ..."},
    {"type": "image_url", "image_url": {"url": "...", "role": "subject"}},
    {"type": "video_url", "video_url": {"url": "...", "role": "style"}},
    {"type": "audio_url", "audio_url": {"url": "...", "role": "audio"}}
  ]
}
```
Exact field names verified from ARK docs at integration time.

## Related Code Files
**Create:**
- `src/providers/byteplus/commands/reference-to-video.ts` — Commander subcommand
- `src/providers/byteplus/reference-input.ts` — `parseRefSpec`, `resolveAudioInput`, `resolveVideoInput` (extends Phase 4 helper)

**Modify:**
- `src/providers/byteplus/generators/video.ts` — `buildVideoTaskBody` accepts `references: ResolvedRef[]`
- `src/providers/byteplus/commands/index.ts` — register `reference-to-video`
- `src/providers/byteplus/types.ts` — `RefKind`, `ResolvedRef`

## Implementation Steps
1. Define `RefKind = "image" | "video" | "audio"` and `ResolvedRef = { kind, url|dataUrl, mime, role? }`.
2. Implement `resolveVideoInput` and `resolveAudioInput` mirroring Phase 4's image helper (URL passthrough or local→base64 with MIME from extension: `.mp4`, `.webm`, `.mp3`, `.wav`, `.m4a`, `.flac`).
3. Implement `parseRefSpec(input: string): { path: string; role?: string }` handling `\:` escape.
4. Commander accepts `.option("--ref-image <spec...>", "...")` (variadic), same for `--ref-video`, `--ref-audio`.
5. Validate counts: image ≤9, video ≤3, audio ≤3, total ≤12. Throw before submission.
6. Build body with all refs ordered: text first, images, videos, audio.
7. Submit + poll + download using existing helpers.
8. Tests: `tests/unit/byteplus/reference-input.test.ts` for spec parsing edge cases (Windows path, missing role).

## Success Criteria
- [ ] `multix byteplus reference-to-video --prompt "..." --ref-image a.jpg:subject --ref-image b.jpg:environment` works
- [ ] >12 refs rejected with clear error before HTTP call
- [ ] Mixed local + URL refs supported
- [ ] Unit tests for spec parser pass
- [ ] Build + tests pass

## Risk Assessment
- **Field naming** (`video_url`/`audio_url`/`role`) speculative — verify against ARK docs at first call. Add `-v` body logging to debug.
- **Large multimodal payload** — 9 images + 3 videos base64 may exceed practical limits. Strongly recommend URLs in help text + README.
- **Colon-in-path** — Windows-only papercut. Document `\:` escape; suggest URL alternative.
- **Scope creep** — keep MVP role list minimal (`subject`, `environment`, `style`, `audio`). Defer `mask`, `pose`, etc. unless ARK explicitly requires them.
