---
title: "Cloudflare media provider research"
created: 2026-07-29
scope: "Cloudflare Workers AI and AI Gateway media plan"
---

# Cloudflare media provider research

## Summary

- Ship a narrow `multix cloudflare` provider: Workers AI image + TTS, direct or through AI Gateway REST, plus one separately typed AI Gateway video route.
- Native Workers AI has no documented video model. Do not use Fal's arbitrary media proxy. Cloudflare's P-video tutorial provides the required concrete alternative: AI Gateway's Replicate prediction create/status/download contract for `prunaai/p-video`.
- Use Gateway REST `/ai/run`, not legacy/provider-native routing, for Workers AI. It preserves `@cf/...` model contracts and uses a single Cloudflare token.

## Verified contracts

| Concern | Evidence | Plan consequence |
|---|---|---|
| Direct Workers AI | [REST API](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) uses `POST /accounts/{account}/ai/run/{model}` and `Authorization: Bearer`; token needs Workers AI permissions. | Direct transport sends the model input unchanged. |
| Gateway REST | [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) defines `POST /accounts/{account}/ai/run`, `{ model, input }`, standard bearer auth, and mandatory `cf-aig-gateway-id` for `@cf/...` models. | Gateway wraps, but never translates, the Workers AI model payload. |
| Safe observability | [AI Gateway changelog](https://developers.cloudflare.com/changelog/product/ai-gateway/) documents `cf-aig-collect-log-payload: false`: retain metadata while omitting payloads from logs. | Default gateway media calls to payload collection off; explicit opt-in only. |
| Image | [FLUX.1 schnell](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell) documents `@cf/black-forest-labs/flux-1-schnell`, JSON `prompt`, optional `steps` max 8 and base64 `image`. | Curate this one JSON-compatible image model. Decode/save JPEG locally. |
| TTS | [MeloTTS](https://developers.cloudflare.com/workers-ai/models/melotts/) documents `@cf/myshell-ai/melotts`, `prompt`, optional `lang`, and an `audio/mpeg` binary output option; its JSON alternative has no stable audio-field contract on the page. | Curate the binary MP3 path only; reject unmodeled JSON rather than guessing. |
| Video | [P-video tutorial](https://developers.cloudflare.com/ai-gateway/tutorials/pruna-p-video/) documents `prunaai/p-video` at the Gateway Replicate prediction endpoint, `Prefer: wait`, pending prediction IDs, status polling, and completed output URLs. | Add a curated `generate-video` and `video-status`; require Gateway ID + Replicate token and keep this protocol separate from native Workers AI. |

## Design decisions

- Keep a static, typed catalog. Do not scrape Cloudflare’s mutable catalog at runtime.
- Infer native image/TTS direct vs Gateway REST transport from `CLOUDFLARE_AI_GATEWAY_ID`: absent is direct; present is Gateway REST. Video always uses the documented provider-native Gateway Replicate path.
- Require `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for native media. Video additionally requires gateway ID and `REPLICATE_API_TOKEN`. Model overrides must validate against the curated catalog.
- Never print tokens, `Authorization`, request bodies, copied curl commands, or complete signed output URLs. Error logs may include only status and safe endpoint kind.

## Unresolved questions

None for the curated image, TTS, and P-video release.
