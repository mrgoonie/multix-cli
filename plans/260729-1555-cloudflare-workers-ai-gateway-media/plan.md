---
title: "Cloudflare Workers AI and AI Gateway Media"
description: "Add secure Cloudflare Workers AI and AI Gateway media generation for images, video, and speech."
status: completed
priority: P1
effort: "10-14h"
branch: "codex/cloudflare-workers-ai-gateway-media"
tags: [feature, api, media, cloudflare, tdd]
blockedBy: []
blocks: []
created: 2026-07-29
---

# Cloudflare Workers AI and AI Gateway Media

## Outcome

`multix cloudflare generate` creates an image with `@cf/black-forest-labs/flux-1-schnell`; `multix cloudflare generate-speech` creates MP3 speech with `@cf/myshell-ai/melotts`; and `multix cloudflare generate-video` creates/polls a `prunaai/p-video` prediction through Cloudflare AI Gateway's documented Replicate route. Native image and speech use direct Workers AI by default and AI Gateway REST when `CLOUDFLARE_AI_GATEWAY_ID` is set.

## Constraints and non-goals

- Node 20, TypeScript, native `fetch`, Commander, Vitest; no Cloudflare SDK.
- Direct: `POST .../ai/run/{model}` with the native model input. Gateway: `POST .../ai/run` with `{ model, input }`, bearer auth, and `cf-aig-gateway-id`.
- Static catalog only: documented native image/TTS contracts plus the documented `prunaai/p-video` Gateway Replicate video contract. Reject arbitrary model IDs and do not scrape catalogs.
- Gateway calls send `cf-aig-collect-log-payload: false` unless explicitly opted in; never log credentials, auth headers, request bodies, or token-bearing URLs.
- No native Workers AI video. No Fal protocol, arbitrary provider passthrough, dashboard mutation, or release publication in this plan.

## Acceptance criteria

- [x] `cloudflare generate` validates prompt/steps/seed/model, saves a JPEG decoded from the documented base64 image response, and supports `--output`.
- [x] `cloudflare generate-speech` validates text/language/model and saves the documented `audio/mpeg` binary response as MP3; unmodeled JSON is rejected safely.
- [x] `cloudflare generate-video` creates and polls a `prunaai/p-video` prediction through AI Gateway, saves a completed output URL, and returns a usable job ID for pending work.
- [x] Direct and Gateway requests preserve each model input; Gateway only adds the documented envelope/header.
- [x] Missing/malformed configuration and non-2xx/invalid result shapes fail safely with no credential disclosure.
- [x] `multix check`, documentation, help smoke tests, unit tests, typecheck, lint, build, and full tests cover the feature.

## Phases

| # | Phase | Depends on | Status |
|---|---|---|---|
| 1 | [Contract catalog and safe transport](./phase-01-start.md) | — | Complete |
| 2 | [Workers AI text to speech](./phase-02-workers-ai-text-to-speech.md) | 1 | Complete |
| 3 | [Workers AI image generation](./phase-03-workers-ai-image-generation.md) | 1, 2 | Complete |
| 4 | [Diagnostics, docs, and release validation](./phase-04-diagnostics-documentation-and-release-validation.md) | 2, 3 | Complete |

## Key design

`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` are required for native image/speech. Optional `CLOUDFLARE_AI_GATEWAY_ID` selects Gateway REST for those commands. Video additionally requires nonblank `CLOUDFLARE_AI_GATEWAY_ID` and `REPLICATE_API_TOKEN`: the latter is sent only as the Replicate `Authorization` value, while the former Cloudflare token is sent only as `cf-aig-authorization`. Optional `CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` permits payload logging. `CLOUDFLARE_AI_IMAGE_MODEL` and `CLOUDFLARE_AI_TTS_MODEL` are optional validated overrides. Direct requires Workers AI permissions; Gateway requires the documented AI Gateway permissions.

## Evidence and handoff

Research: [Cloudflare media research](../reports/planner-260729-1558-cloudflare-media-research.md). Source evidence is linked there. No cross-plan dependency was found. Video is intentionally limited to Cloudflare's documented `prunaai/p-video` Gateway prediction/status contract.
