---
phase: 3
title: "Workers AI image generation and AI Gateway video"
status: completed
priority: P1
effort: "2-3h"
dependencies: [1, 2]
---

# Phase 3: Workers AI image generation and AI Gateway video

## Overview

Expose the documented JSON FLUX.1 schnell contract as `multix cloudflare generate`, then add a separately-typed `generate-video`/`video-status` flow for Cloudflare's documented AI Gateway `prunaai/p-video` tutorial. The two transports must not share a payload adapter.

## Requirements

- Default/only curated image model: `@cf/black-forest-labs/flux-1-schnell`.
- Required `--prompt`; optional `--steps` within the documented 1–8 range and `--seed`; optional `--output`.
- Parse the successful Cloudflare envelope and `result.image` base64 only. Do not claim that the Flux image command supports FLUX.2 multipart, image editing, multi-image, or video.
- Video creates a Replicate prediction at `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/replicate/predictions` with `version: "prunaai/p-video"`, a Replicate bearer token, and Cloudflare `cf-aig-authorization`.
- Video accepts only documented prompt, duration, aspect ratio, resolution, and fps fields; completed predictions download their output URL, while pending predictions expose a safe status command.

## Related code files

- Create: `src/providers/cloudflare/commands/generate.ts` — Commander action and flags.
- Modify: `src/providers/cloudflare/commands/index.ts` — register image command.
- Modify: `src/providers/cloudflare/media-output.ts` — save the image using the shared safe writer.
- Create: `tests/unit/providers/cloudflare/generate.test.ts` — input/envelope/file-output cases.
- Create: `src/providers/cloudflare/commands/generate-video.ts` and `video-status.ts` — typed prediction creation/polling.
- Create: `tests/unit/providers/cloudflare/video.test.ts` — create, status, completed/pending/error, and download cases.

## Tests first

1. Assert prompt/defaults, `steps` boundaries, seed, explicit output, and direct/Gateway request preservation.
2. Stub a success envelope with base64 JPEG and assert exact saved bytes/name.
3. Cover missing prompt, invalid steps/seed/model, `success:false`, missing result/image, malformed base64, and output write failure.
4. Assert the video create/status URLs, distinct authorization headers, documented body, completed output download, pending ID, and failed prediction handling.
5. Assert `--wait` sends `Prefer: wait`, while the default creates a job and `video-status --wait` polls it; `--download` implies wait. Cover timeout and no-output paths.
6. Stub signed output URLs for successful, HTTP-failure, and network-failure downloads. Assert all resulting errors redact query strings and credentials.

## Implementation steps

1. Register `generate` with only documented options; use the catalog validator rather than accepting arbitrary Cloudflare IDs.
2. Build `{prompt, steps?, seed?}`, call the shared transport, validate the response envelope, and write a `.jpg` safely.
3. Print saved path and model; do not dump raw response or request payload under `--verbose`.
4. Implement `generate-video` with default asynchronous creation; `--wait` requests Replicate's documented synchronous preference and `--download` implies `--wait`. Implement `video-status` for explicit polling.
5. Keep video independent of the native transport: reject blank gateway ID or missing Replicate token before fetch, poll only the documented Gateway prediction status path, and download only an explicit completed output URL through a URL-sanitizing helper.
6. Run focused tests and `npm run typecheck`.

## Success criteria

- [ ] The request matches FLUX.1 schnell’s documented JSON contract in both transports.
- [ ] One valid base64 result becomes a JPEG with deterministic test coverage.
- [ ] A completed P-video prediction becomes a local video; a pending or failed prediction never creates a fake output.

## Risks and rollback

FLUX.2 uses multipart and is deliberately excluded. P-video depends on a separate Replicate token and can exceed its synchronous window; keep its polling protocol model-specific instead of adding generic video flags.
