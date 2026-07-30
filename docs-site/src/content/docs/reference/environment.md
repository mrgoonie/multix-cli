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
| `GEMINI_API_KEY` | Gemini |
| `OPENAI_API_KEY` | OpenAI |
| `OPENROUTER_API_KEY` | OpenRouter |
| `MINIMAX_API_KEY` | MiniMax |
| `LEONARDO_API_KEY` | Leonardo |
| `BYTEPLUS_API_KEY` or `ARK_API_KEY` | BytePlus |
| `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` | Cloudflare Workers AI |
| `CLOUDFLARE_AI_GATEWAY_ID` and `REPLICATE_API_TOKEN` | Cloudflare AI Gateway video |
| `ELEVENLABS_API_KEY` | ElevenLabs |

```bash
export GEMINI_API_KEY="your-key"
export MULTIX_OUTPUT_DIR="./multix-output"
multix check
```

## Model and endpoint overrides

Use explicit overrides only when you need a different default. Available
settings include `IMAGE_GEN_MODEL`, `VIDEO_GEN_MODEL`, `MULTIMODAL_MODEL`,
`GEMINI_TTS_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_TTS_MODEL`,
`OPENAI_STT_MODEL`, `OPENROUTER_IMAGE_MODEL`, `LEONARDO_BASE_URL`,
`BYTEPLUS_BASE_URL`, `BYTEPLUS_IMAGE_MODEL`, `BYTEPLUS_VIDEO_MODEL`, and
`BYTEPLUS_3D_MODEL`.

Cloudflare accepts only the built-in Workers AI image and speech model IDs;
`CLOUDFLARE_AI_IMAGE_MODEL` and `CLOUDFLARE_AI_TTS_MODEL` are therefore useful
only to make that supported choice explicit. Set
`CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` only when request-payload
collection is intended.

Run `multix check --verbose` after changing a credential or endpoint to see
which providers are usable.
