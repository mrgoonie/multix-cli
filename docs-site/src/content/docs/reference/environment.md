---
title: Environment variables
description: Configure multix credentials, model defaults, and output location with environment variables.
---

`multix` reads configuration in this order: process environment, a `.env` file
in the current project, then `~/.multix/.env`. Keep API keys out of shell
history and never commit them.

## Provider credentials

| Variable | Used by |
| --- | --- |
| `GEMINI_API_KEY` (plus optional `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, …) | Gemini |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `MINIMAX_API_KEY` | MiniMax |
| `LEONARDO_API_KEY` | Leonardo |
| `BYTEPLUS_API_KEY` or `ARK_API_KEY` | BytePlus |
| `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI |
| `CLOUDFLARE_AI_GATEWAY_ID` and `REPLICATE_API_TOKEN` | Cloudflare AI Gateway video |
| `ELEVENLABS_API_KEY` | ElevenLabs |
| `FAL_KEY` | fal.ai |

```bash
export GEMINI_API_KEY="your-key"
export MULTIX_OUTPUT_DIR="./multix-output"
multix check
```

## Gemini key rotation

Add extra Gemini keys as `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, and so on (any
numeric suffix). `multix` uses `GEMINI_API_KEY` first, then the numbered keys in
ascending order; duplicate values are ignored.

- A key that returns HTTP 429 or `RESOURCE_EXHAUSTED` cools down for the
  server's `Retry-After`, or 60 seconds, and the same request is retried with
  the next key. Other errors fail immediately.
- Multi-step requests stay on one key: a Files API upload and the generate call
  that references it, and Veo submit, polling and download.
- Cooldowns last for the current process only. Logs name the env var, never the
  key value.
- `multix check` reports how many keys are in rotation.

## Model and endpoint overrides

Use explicit overrides only when you need a different default. Available
settings include `IMAGE_GEN_MODEL`, `VIDEO_GEN_MODEL`, `MULTIMODAL_MODEL`,
`GEMINI_TTS_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_TTS_MODEL`,
`OPENAI_STT_MODEL`, `OPENROUTER_IMAGE_MODEL`, `LEONARDO_BASE_URL`,
`BYTEPLUS_BASE_URL`, `BYTEPLUS_IMAGE_MODEL`, `BYTEPLUS_VIDEO_MODEL`,
`BYTEPLUS_3D_MODEL`, `FAL_BASE_URL`, `FAL_IMAGE_MODEL`, `FAL_VIDEO_MODEL`, and
`FAL_VIDEO_IMAGE_MODEL` (fal's image-to-video default, used when
`multix fal video --image-url` is passed without `-m`).

Cloudflare accepts only the built-in Workers AI image and speech model IDs;
`CLOUDFLARE_AI_IMAGE_MODEL` and `CLOUDFLARE_AI_TTS_MODEL` are therefore useful
only to make that supported choice explicit. Set
`CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` only when request-payload
collection is intended.

Run `multix check --verbose` after changing a credential or endpoint to see
which providers are usable.
