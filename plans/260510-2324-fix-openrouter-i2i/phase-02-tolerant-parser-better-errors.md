---
phase: 2
title: Tolerant parser & better errors
status: completed
priority: P1
effort: 45m
dependencies:
  - 1
---

# Phase 2: Tolerant parser & better errors

## Overview
Move response parsing to the shared `payload.ts` and accept multiple shapes. Replace generic "No images" errors with diagnostic messages including model id, finish reason, and any text content. Bubble up OpenRouter HTTP error bodies.

## Requirements
- Functional: parse `choices[0].message.images[].image_url.url` (primary). Fallback: scan `choices[0].message.content[]` for `{type:"image_url", image_url:{url}}` parts and base64 markdown image links.
- Non-functional: keep helper pure (no I/O); easily unit-testable.

## Architecture
```
payload.ts (extends Phase 1)
├── interface OpenRouterChatResponse  (typed)
├── extractImagesFromResponse(data)
│   -> { urls: string[], textContent?: string, finishReason?: string, model?: string }
└── formatNoImagesError(model, parsed) -> string  (rich message)
```

`client.ts:fetchBytes` and `core/http-client.ts` — verify `httpJson` already includes response body in error. If not, extend the thrown error message to include status + body excerpt (first 500 chars).

## Related Code Files
- Modify: `src/providers/openrouter/payload.ts` (add parser + error formatter)
- Modify: `src/providers/openrouter/client.ts` (use parser; richer error)
- Modify: `src/providers/openrouter/commands/image-to-image.ts` (use parser; richer error)
- Read for context: `src/core/http-client.ts` (check error surfacing)

## Implementation Steps
1. In `payload.ts`, add:
   ```ts
   export interface ParsedImageResponse {
     urls: string[];
     textContent?: string;
     finishReason?: string;
     model?: string;
   }
   export function extractImagesFromResponse(data: unknown): ParsedImageResponse;
   export function formatNoImagesError(model: string, parsed: ParsedImageResponse): string;
   ```
2. Implementation:
   - Defensive narrow on `data` (treat as `Record<string, unknown>`).
   - Primary: `choices[0].message.images[].image_url.url` → push to `urls`.
   - Fallback: if `urls.length===0` and `message.content` is array, iterate items: collect `image_url.url` from `{type:"image_url"}` items.
   - Capture `message.content` (when string) into `textContent` for diagnostics.
   - Capture `choices[0].finish_reason` and top-level `data.model`.
3. `formatNoImagesError(model, p)` returns:
   `No images returned by '${model}' (finish_reason=${p.finishReason ?? "n/a"}). ${p.textContent ? \`Model said: "${truncate(p.textContent, 200)}". \` : ""}Hints: verify model supports image output and that 'modalities' includes 'image'.`
4. Replace existing parsing blocks in `client.ts:generateOpenRouterImage` and `image-to-image.ts:runImageToImage` to call `extractImagesFromResponse` + `formatNoImagesError`.
5. Inspect `core/http-client.ts:httpJson` — if it doesn't include response body in non-2xx errors, augment so OpenRouter HTTP errors surface upstream details (preserves cross-provider behaviour: only do minimal change if it already partially includes body).
6. `npm run build` — clean compile.

## Success Criteria
- [ ] `extractImagesFromResponse` returns urls when given canonical Gemini-shape response.
- [ ] Returns `textContent` + `finishReason` when given an empty-images response.
- [ ] Falls back to `message.content[]` `image_url` parts when `message.images` missing.
- [ ] No-images error includes: model id, finish reason, truncated text content, hint.
- [ ] HTTP errors from OpenRouter include status + response body excerpt in the thrown message.

## Risk Assessment
- Risk: over-broad fallback may match unintended content. Mitigation: only treat `{type:"image_url"}` parts; never parse arbitrary text for URLs.
- Risk: changing `http-client.ts` could affect other providers. Mitigation: only extend (don't break) — keep existing throw shape, just append body excerpt; verify with grep for callers.
