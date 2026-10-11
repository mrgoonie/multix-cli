---
title: Remote MCP server on Cloudflare Workers
description: Deploy the multix MCP server to Cloudflare Workers so remote AI agents can generate images and video over Streamable HTTP with bearer authentication.
---

The repository ships an optional, stateless [Model Context Protocol](https://modelcontextprotocol.io)
server in `worker/`. It exposes multix's remote-friendly provider calls as MCP
tools over **Streamable HTTP** at `/mcp`, so agents that cannot run the CLI
locally (hosted assistants, web IDEs, other servers) can start image and video
jobs and poll them.

The worker is a separate package. It is not part of the published npm CLI and
does not change how `multix` behaves on your machine.

## What it exposes

| Tool | Purpose |
|---|---|
| `multix_list_providers` | Which providers are enabled and configured, allowed models, and server limits. |
| `multix_generate_image` | Text-to-image on `replicate` or `atlascloud`. Waits up to `wait_seconds` (default 20, max 25), then returns either the output URLs or a prediction ID to poll. |
| `multix_generate_video` | Text- or image-to-video on `replicate`, `atlascloud`, `heygen`, or `cloudflare` (Replicate via AI Gateway). Never blocks: returns a prediction ID. |
| `multix_prediction_status` | Poll a prediction by provider and ID. |
| `multix_prediction_cancel` | Cancel a running prediction (Replicate only). |

Results contain provider-hosted **URLs**, never file bytes. Some providers
return signed URLs that expire; download them promptly. When a job is still
running, the result includes a `next` hint with the exact
`multix_prediction_status` arguments to call.

### Not available remotely

Everything that needs the local file system or local binaries stays CLI-only:
`--output`/downloads, local file inputs (only public `https://` image URLs are
accepted), `doc-to-md`, ffmpeg and ImageMagick commands, Gemini/OpenAI/MiniMax
and the other providers without a runtime-neutral client, Cloudflare Workers AI
image and speech generation (they return bytes), the Codex image driver, and
`multix update`.

## Credential model

The server is **single-tenant**. Provider keys are Worker secrets owned by
whoever deploys it, and every authenticated caller spends that account's
credits. Callers never send provider keys. Share the `MCP_AUTH_TOKEN` only
with clients you would trust with those keys' budget, and use the allowlists
and limits below to bound what they can do.

## Deploy

Requirements: Node 20+, a Cloudflare account, and `wrangler` (installed as a
worker dev dependency).

```bash
npm ci --prefix worker
cd worker
npx wrangler login

# Required: the bearer token clients must send (at least 32 characters)
openssl rand -hex 32 | npx wrangler secret put MCP_AUTH_TOKEN

# Provider keys: set only the ones you want to expose
npx wrangler secret put REPLICATE_API_TOKEN
npx wrangler secret put ATLASCLOUD_API_KEY
npx wrangler secret put HEYGEN_API_KEY
# Cloudflare video needs all four:
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_AI_GATEWAY_ID
# (plus REPLICATE_API_TOKEN above)

cd ..
npm run deploy:mcp
```

Check it is up (this endpoint is public and returns only `{ "ok": true, "version": "…" }`):

```bash
curl https://multix-mcp.<your-subdomain>.workers.dev/health
```

### Run locally

Copy `worker/.dev.vars.example` to `worker/.dev.vars` (git-ignored), fill in a
token and the keys you need, then:

```bash
npm run dev:mcp   # http://localhost:8787/mcp
```

## Connect a client

Any MCP client that supports Streamable HTTP with custom headers works. Send
the token as a bearer header:

```json
{
  "mcpServers": {
    "multix": {
      "type": "http",
      "url": "https://multix-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

With Claude Code:

```bash
claude mcp add --transport http multix https://multix-mcp.<your-subdomain>.workers.dev/mcp \
  --header "Authorization: Bearer $MULTIX_MCP_TOKEN"
```

A typical video flow is `multix_generate_video` → repeat
`multix_prediction_status` every 10–30 seconds until `done` is `true` → read
`outputs`.

## Configuration

Set these as `vars` in `worker/wrangler.jsonc` or as secrets:

| Variable | Default | Effect |
|---|---|---|
| `MCP_AUTH_TOKEN` | — (required) | Bearer token. If unset or shorter than 32 characters, `/mcp` returns `503` (fail closed). |
| `MULTIX_MCP_ALLOWED_PROVIDERS` | all | Comma-separated provider allowlist, e.g. `replicate,heygen`. |
| `MULTIX_MCP_ALLOWED_MODELS` | any | Comma-separated `provider:model` allowlist, e.g. `replicate:black-forest-labs/flux-schnell,heygen:heygen-video-1`. When set, every model (including defaults) must be listed. |
| `MULTIX_MCP_MAX_OUTPUTS` | `4` (ceiling 10) | Maximum `num_outputs` per image call. |
| `MULTIX_MCP_MAX_VIDEO_SECONDS` | `10` (ceiling 15) | Maximum video `duration`. |
| `MULTIX_MCP_ALLOWED_ORIGINS` | none | Browser origins allowed to call `/mcp`. Requests with any other `Origin` header get `403`; requests without an `Origin` (server-side clients) are allowed. |

The `MCP_RATE_LIMITER` binding in `wrangler.jsonc` uses the
[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
to allow 60 requests per minute per client IP; excess requests get `429`.
Adjust `simple.limit`/`simple.period` there.

## Security model

- **Authentication:** every `/mcp` request needs `Authorization: Bearer <token>`.
  The comparison is constant-time over SHA-256 digests. Failures return a bare
  `401` with no detail.
- **Input validation:** all tool arguments are validated with zod schemas
  (prompt ≤ 4000 characters, IDs restricted to `[A-Za-z0-9_-]`, bounded
  numbers). Request bodies over 64 KiB are rejected with `413`.
- **SSRF guard:** `image_url` must be `https://` on the default port, with a
  public DNS host name. IP literals, credentials in the URL, `localhost`,
  `.local`/`.internal` style names, and cloud metadata hosts are rejected
  before any provider call.
- **Spend guard:** output count and video duration are capped, Atlas Cloud
  schema defaults are re-checked before submit, and video calls never wait.
  Replicate models that apply their own default duration cannot be inspected
  in advance; use `MULTIX_MCP_ALLOWED_MODELS` to pin vetted models.
- **Redaction:** logs are structured JSON with tool name, provider, model,
  outcome, and latency only. Prompts are never logged. Provider error text is
  scrubbed of configured secrets, bearer tokens, and URL query strings before
  it reaches logs or clients.
- **Stateless:** no sessions, no storage. Each request builds a fresh server.

The Worker bundle is checked in CI to contain no `node:fs`,
`node:child_process`, `commander`, `execa`, or CLI entry code.
