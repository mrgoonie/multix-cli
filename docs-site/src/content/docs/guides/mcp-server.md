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

Check it is up (this endpoint is public and returns only `{ "ok": true }`):

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
| `MULTIX_MCP_MAX_VIDEO_SECONDS` | `10` (ceiling 15) | Maximum video `duration`. When a caller omits `duration`, the server sends a length explicitly instead of leaving the provider default: `min(5, cap)` seconds on Replicate, HeyGen and Cloudflare; on Atlas Cloud see [Spend guard](#security-model). |
| `MULTIX_MCP_ALLOWED_RESOLUTIONS` | `480p,720p,768p,1080p` | Video resolutions a caller may request (`768p` is a HeyGen Video size). Anything else (for example `4k`) is rejected before the provider call. An omitted resolution uses the model default; on Atlas Cloud that default (and any `output_resolution`, `target_resolution`, resolution-valued `quality`, `size`, `width` or `height`, or a resolution named in the model ID) is checked against this list too. |
| `MULTIX_MCP_ALLOWED_ORIGINS` | none | Exact browser origins (for example `https://app.example.com`) allowed to call `/mcp`. `*` and other wildcards are not supported: `*` only matches a literal `*` origin, which browsers never send. Requests with any other `Origin` header get `403`; requests without an `Origin` (server-side clients) are allowed. Listed origins get CORS headers, and their `OPTIONS` preflight is answered without a token. The real request still needs the bearer token. |

The `MCP_RATE_LIMITER` binding in `wrangler.jsonc` uses the
[Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
to allow about 60 requests per minute per client IP; excess requests get `429`.
The limit is approximate: Cloudflare counts per location and the counters are
eventually consistent, so treat it as abuse protection, not an exact budget.
Adjust `simple.limit`/`simple.period` there. `namespace_id` must be unique
within your Cloudflare account. If another Worker already uses `1001`, pick a
different integer, or the two Workers will share counters.

## Security model

- **Authentication:** every `/mcp` request needs `Authorization: Bearer <token>`.
  The comparison is constant-time over SHA-256 digests. Failures return a bare
  `401` with no detail.
- **Input validation:** all tool arguments are validated with zod schemas
  (prompt ≤ 4000 characters, IDs restricted to `[A-Za-z0-9_-]`, bounded
  numbers). Request bodies over 64 KiB are rejected with `413`. JSON-RPC
  batches (array bodies) are rejected with `400` / `-32600`, so one HTTP
  request is always one tool call and the rate limit bounds calls too.
- **SSRF guard:** `image_url` must be `https://` on the default port, with a
  public DNS host name. IP literals, credentials in the URL, `localhost`,
  `.local`/`.internal` style names, and cloud metadata hosts are rejected
  before any provider call.
- **Spend guard:** output count, video duration, and video resolution are
  capped, and video calls never wait. On Replicate, HeyGen and Cloudflare a
  video `duration` is always sent explicitly (the caller's value or
  `min(5, cap)`), so a provider default can never exceed the cap. Replicate
  models that name their length input something other than `duration` cannot
  be capped this way.

  Atlas Cloud fills any field left out from the model schema, so the Worker
  reads the schema first and applies these rules before submit. Every
  rejection happens before any billable call.

  - **No schema:** if the model schema cannot be loaded (catalog error, or a
    model the public catalog does not list), every Atlas video call is
    rejected, whatever the caller passed, and nothing is sent. Only a retry
    once the schema loads helps; pinning models does not lift this check.
  - **Seconds fields:** `duration`, `seconds`, `length`, `num_seconds` and
    `video_length`. Values may be numbers or strings such as `"8"` or `"8s"`,
    and an `anyOf`/`oneOf` with a single non-null member is unwrapped. A
    seconds field whose type cannot be read this way is rejected.
  - **Caller passed `duration`:** it goes to the first seconds field, in the
    schema's format (`4` becomes `"4s"` when the enum is `"4s"`/`"8s"`).
  - **Every other seconds field is sent explicitly:** its schema default when
    that is within the cap, the cap when the default is longer, and
    `min(5, cap)` when there is no positive default. The value is snapped to
    the schema's allowed values: the largest enum value at or below it (else
    the smallest one within the cap), inside `minimum`/`maximum`. Zero and
    negative values (often "auto" or "smart" length) are never sent. If no
    allowed value fits within the cap, the call is rejected.
  - **Frame counts** (`num_frames`, `frames`): capped at `cap × fps` using the
    schema's `fps` (or `frames_per_second`) default, and sent explicitly.
    Without a declared frame rate, one frame per second is assumed, so only a
    default of at most `cap` frames passes; anything else is rejected.
  - **Other length-like inputs:** any other field whose name contains
    `frame`, `second`, `duration` or `length`, or ends in `_len` (for example
    `frame_count` or `clip_length`), is rejected when it is numeric or its
    schema cannot be read, since the Worker cannot cap it. Image and flag
    inputs such as `first_frame` or `return_last_frame` are not affected.
  - **Final check:** every seconds and frame field, sent or filled from the
    schema default, must be within the cap. Every resolution field that will
    be rendered (the value sent or the schema default) must be in
    `MULTIX_MCP_ALLOWED_RESOLUTIONS`. The resolution fields are `resolution`,
    `output_resolution`, `target_resolution`, and `quality` when its value,
    default or enum looks like a resolution (such as `720p`, `1080p`, `2k`,
    `4k`, or an integer video height such as `1080`). An integer such as
    `1080` is read as `1080p`; `4k` and `2160p` are different allowlist
    entries. A `quality` such as `high`, `standard` or a `1`–`5` scale is not
    a resolution and is left alone; a `quality` schema this server cannot read
    (`$ref`, `allOf`) is rejected. Only `resolution` is
    a tool argument, so a model whose other resolution field is outside the
    list is rejected. A model whose ID names a resolution as a whole token
    between `/`, `-` or `_` (such as `kwaivgi/kling-video-o3-4k/...` or
    `kling-v3.0-4k`, both `4k`) renders and bills at that resolution, so it is
    rejected when that resolution is not in the list, even if its own
    resolution field defaults to an allowed value. The same applies to a
    `template` preset that names a resolution (the Tencent upscaler's default
    `anime-enhance-4k` is `4k`); with no default, every listed preset must be
    allowed, and a `template` schema this server cannot read is rejected.
    Lookalikes such as `2.4k` or `4kids` do not count. A `size`/`video_size`
    (`1920*1080`) or `width`/`height` pair must fit the largest allowed resolution at 16:9 in
    either orientation: `1080p` allows a long side up to 1920 and a short side
    up to 1080, so `1920*1920` is rejected. A value, or a schema shape
    (`$ref`, `allOf`, a union with several members and no outer default), that
    cannot be read is rejected.
  - **Other price multipliers** are sent at their cheapest values, because
    the tool has no argument for them and schema defaults are often the
    expensive choice:
    - **Cost switches** `generate_audio`, `sound`, `audio`, `bgm`,
      `enable_thinking` and `hdr` are sent off: `false`, or, when the schema
      uses an enum, its value `false`, `"no"`, `"off"`, `"none"` or
      `"disabled"`. A string `audio` with no default is an input URL and is
      left alone. A switch that has no off value is rejected. Vidu's `bgm`
      (background music) defaults to on. Neither Atlas Cloud nor Vidu
      publishes whether it changes the price, so it is treated as a price
      input and sent off.
    - **Output count** is sent as `1`. The fields are exactly `n`, `count`,
      `batch_size`, `batch_count`, `num_output`, `num_video`, `num_sample`,
      `num_generation`, `num_result`, `output_count`, `video_count`,
      `sample_count` and `generation_count` (each also with a plural `s`,
      such as `num_videos` or `videos_count`). Other `*_count` fields, such as
      `face_count`, are not output counts (`frame_count` is a length, see
      above). If the schema does not allow `1`, the call is rejected.
    - **Price tiers** use a fixed table, cheapest first: `thinking_level`
      (`minimal`, `low`, `medium`, `default`, `high`), `motion` (`low`,
      `medium`, `high`), `bitrate_mode` (`standard`, `high`) and `mode`
      (`wan-std` < `wan-pro`, `std` < `pro`, or `standard` <
      `professional`). The cheapest listed value in the schema enum is sent
      when every enum value is listed or the default is listed. Otherwise a
      listed default above the cheapest tier is rejected, and an unknown
      default is left alone. Pinning `thinking_level`, `motion` and the other
      tiers to the cheapest value can lower output quality. Operators who
      need a higher tier should call the model with the multix CLI directly
      (`multix atlas run <model> --input '{...}'`).
    - Any of these fields whose schema cannot be read is rejected.

  Limitations: the Worker does not cap other inputs that may change the
  price, such as `enable_prompt_expansion` or a `quality` field that is not
  a resolution.
  Video-extend models also bill the input video's length; the Worker cannot
  measure a remote video, and the MCP tool has no video input, so a model
  that requires one is rejected for the missing field. An explicit extension
  length field (`duration`) is capped like any other. When the schema
  declares no size field and no default, the model picks its own output size.
  Pin vetted models with `MULTIX_MCP_ALLOWED_MODELS`.
- **Logging and redaction:** successful calls are logged at `info` with tool
  name, provider, model, outcome, and latency only. Prompts are never logged as
  a field. Failed calls are logged at `warn` (expected errors) or `error`, with
  an extra `detail` field. It holds the provider or validation error message,
  scrubbed of configured secrets, bearer tokens, and URL query strings, and
  truncated. A provider error that echoes part of a prompt (for example a
  moderation message) can therefore appear there. The same scrubbed text is
  returned to the client.
- **Stateless:** no sessions, no storage. Each request builds a fresh server.

The Worker bundle is checked in CI to contain no `node:*` module, no bare Node
built-in import (`fs`, `child_process`, `path`, …), no `commander` or `execa`,
and no CLI entry code. The Worker source is also type-checked without Node
typings.

## Live smoke test

CI uses mocked provider calls only. To check a real provider end to end, run
the opt-in live test. It is skipped unless both `MULTIX_MCP_LIVE=1` and a
Replicate token are set. It runs the Worker handler in-process: `tools/list`,
then one single-output image. Add `MULTIX_MCP_LIVE_VIDEO=1` to also start a
video, read its status, and cancel it. It spends a few cents and never prints
credential values.

```bash
MULTIX_MCP_LIVE=1 REPLICATE_API_TOKEN=r8_... npm test --prefix worker -- live-smoke
```
