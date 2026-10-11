---
title: Environment variables
description: Configure multix credentials, model defaults, and output location with environment variables.
---

`multix` reads configuration in this order: process environment, a `.env` file
in the current project, then `~/.multix/.env` (plus [legacy `.claude` files](#legacy-claude-env-files)
when enabled). Keep API keys out of shell
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
| `ATLASCLOUD_API_KEY` | Atlas Cloud |
| `REPLICATE_API_TOKEN` or `REPLICATE_API_KEY` | Replicate (direct API) |
| `HEYGEN_API_KEY` | HeyGen (API credits are billed separately from web plans) |

```bash
export GEMINI_API_KEY="your-key"
export MULTIX_OUTPUT_DIR="./multix-output"
multix check
```

## Gemini key rotation

Add extra Gemini keys as `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, and so on (any
numeric suffix). `multix` uses `GEMINI_API_KEY` first, then the numbered keys in
ascending order; duplicate values are ignored. Numbered keys work on their own,
without `GEMINI_API_KEY`.

- A key that returns HTTP 429, or 400/403 with `RESOURCE_EXHAUSTED`, cools down
  for the server's `Retry-After` or `retryDelay`, else 60 seconds, and the same
  request is retried with the next ready key. When every key is cooling, only
  the key that recovers first is tried once. Other errors are not rotated.
- Multi-step requests stay on one key. If the generate call that follows a Files
  API upload is rate-limited, the next key uploads the file again, because an
  uploaded file belongs to the key that created it.
- Veo rotates only on submit. Once a job is accepted, polling and download use
  that key, so a later rate limit never starts a second, separately billed job.
- `multix doc convert` stops its own retries on a rate limit, because rotation
  already tried every ready key.
- Cooldowns last for the current process only. Logs name the env var, never the
  key value.
- `multix check` lists the keys in rotation and pings each one.
- Gemini quotas apply per Google Cloud project. Keys from the same project share
  one quota, so rotation only helps with keys from different projects.

## Legacy `.claude` env files

Older AgentKit installs kept keys in `.claude` folders. Set
`MULTIX_LEGACY_CLAUDE_ENV=1` (in the shell, the project `.env` or
`~/.multix/.env`) to also read them. This is off by default. The files load
after `~/.multix/.env`, never override earlier values, and the first file that
sets a variable wins:

1. `.claude/skills/ai-multimodal/.env`, then `.claude/skills/ak-ai-multimodal/.env`
2. `.claude/skills/.env`
3. `.claude/.env`

Project folders are read first, then the same files under your home directory.
Only credential names are taken from these files: names ending in `_API_KEY`
(optionally numbered, such as `GEMINI_API_KEY_2`), `_API_TOKEN`, `_ACCOUNT_ID`
or `_GATEWAY_ID`, plus `FAL_KEY` and `ARK_API_KEY`. Endpoint, proxy and runtime
settings such as `*_BASE_URL` are ignored, so a cloned repository cannot send
your keys to another host. The flag itself is ignored inside these files.
`multix check` mentions legacy files it finds while the flag is off, and
`multix check -v` lists every env file that was loaded (paths only, never
values). Moving the keys to `.env` or `~/.multix/.env` is still recommended.

## Model and endpoint overrides

Use explicit overrides only when you need a different default. Available
settings include `IMAGE_GEN_MODEL`, `VIDEO_GEN_MODEL`, `MULTIMODAL_MODEL`,
`GEMINI_TTS_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_TTS_MODEL`,
`OPENAI_STT_MODEL`, `OPENROUTER_IMAGE_MODEL`, `LEONARDO_BASE_URL`,
`BYTEPLUS_BASE_URL`, `BYTEPLUS_IMAGE_MODEL`, `BYTEPLUS_VIDEO_MODEL`,
`BYTEPLUS_3D_MODEL`, `FAL_BASE_URL`, `FAL_IMAGE_MODEL`, `FAL_VIDEO_MODEL`, and
`FAL_VIDEO_IMAGE_MODEL` (fal's image-to-video default, used when
`multix fal video --image-url` is passed without `-m`). Replicate accepts
`REPLICATE_BASE_URL` (API root for mocks or proxies), `REPLICATE_IMAGE_MODEL`
(default `black-forest-labs/flux-schnell`), and `REPLICATE_VIDEO_MODEL`
(default `prunaai/p-video`). Cloudflare AI Gateway video reads only
`REPLICATE_API_TOKEN`. `MULTIX_MAX_DOWNLOAD_MB` sets the size limit for each
downloaded Replicate output file (default 2048); see
[Replicate](/commands/replicate/#outputs) for the download policy.

Atlas Cloud accepts `ATLASCLOUD_BASE_URL` (media API base, default
`https://api.atlascloud.ai/api/v1`) and one default-model override per command:
`ATLASCLOUD_IMAGE_MODEL`, `ATLASCLOUD_IMAGE_EDIT_MODEL`,
`ATLASCLOUD_VIDEO_MODEL`, `ATLASCLOUD_IMAGE_TO_VIDEO_MODEL`,
`ATLASCLOUD_TTS_MODEL`, `ATLASCLOUD_STT_MODEL`, `ATLASCLOUD_TEXT_TO_3D_MODEL`,
and `ATLASCLOUD_IMAGE_TO_3D_MODEL`. See [Atlas Cloud](/commands/atlascloud/)
for the built-in defaults. `ATLASCLOUD_MAX_UPLOAD_MB` sets the size limit for
local files uploaded to Atlas Cloud (default 200).

`HEYGEN_BASE_URL` overrides the HeyGen API base (default
`https://api.heygen.com`) for proxies and tests. It must be `https://`; plain
`http://` is accepted only for `localhost`, `127.0.0.1`, or `[::1]`.

### Base URL overrides and trust

A `*_BASE_URL` override decides where your API key is sent, so `multix` only
trusts it from the shell environment or `~/.multix/.env`:

- A `*_BASE_URL` that comes only from the project `.env` (the current
  directory) is ignored, and `multix` prints one warning naming the variable
  and the file (never the value). If `~/.multix/.env` sets the same variable,
  that value is used instead; otherwise the provider default applies. This
  stops a cloned repository from redirecting your key to another host.
- To allow project overrides (for example a local mock server), set
  `MULTIX_ALLOW_PROJECT_BASE_URL=1` in your shell or `~/.multix/.env`. The
  opt-in is ignored when it is set in the project `.env` itself.
- Whenever a non-default base URL is in effect, `multix` prints one warning per
  run naming the provider and only the hostname, never the key or the full URL.
  Warnings go to stderr, so stdout stays machine-readable.

The per-provider rules above (for example `https://` only for HeyGen) still
apply.

Cloudflare accepts only the built-in Workers AI image and speech model IDs;
`CLOUDFLARE_AI_IMAGE_MODEL` and `CLOUDFLARE_AI_TTS_MODEL` are therefore useful
only to make that supported choice explicit. Set
`CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` only when request-payload
collection is intended.

Run `multix check --verbose` after changing a credential or endpoint to see
which providers are usable.
