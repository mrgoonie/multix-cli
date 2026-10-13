---
title: Remote MCP server on Cloudflare Workers
description: Deploy the multix MCP server to Cloudflare Workers so remote AI agents can generate images and video over Streamable HTTP, with GitHub sign-in, OAuth and a dashboard for each account's provider keys.
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

## Accounts and credentials

The server is **multi-account**. Each person signs in with GitHub and saves
their own provider keys in the dashboard at `/dashboard`. Every MCP request
runs with the keys of the account that approved the connection, so callers
spend their own credits. The operator does not set provider keys on the
Worker, and keys set there are ignored.

- **Who can sign in:** only GitHub users listed in `MULTIX_ALLOWED_USERS`.
  The list is checked at sign-in and again on every dashboard and `/mcp`
  request, so removing a name cuts off that account's existing connections.
- **Key storage:** keys are encrypted with AES-GCM (key `SECRETS_ENCRYPTION_KEY`,
  bound to the account and key name) and stored in the `ACCOUNTS_KV`
  namespace. The dashboard shows only whether a key is set and when; a saved
  value is never displayed again. KV is eventually consistent, so a new or
  removed key can take up to about a minute to reach every Cloudflare location.
- **GitHub token:** used once to read the profile and verified emails, then
  discarded. multix stores the GitHub user ID, login, name, avatar URL and
  verified emails.
- **Which keys:** the dashboard has an input for every key env name the CLI
  reads, grouped by provider with a link to where you create the key
  (Gemini, OpenRouter, OpenAI, MiniMax, Leonardo.Ai, BytePlus with
  `ARK_API_KEY` as fallback, ElevenLabs, fal.ai, Atlas Cloud, Replicate with
  `REPLICATE_API_KEY` as fallback, HeyGen), plus the Cloudflare Workers AI
  account ID, API token and optional AI Gateway ID. The image and video tools
  above use only the Replicate, Atlas Cloud, HeyGen and Cloudflare keys.

### R2 storage

Each account can also save its own Cloudflare R2 bucket for files that
server-side jobs create. The current image and video tools return provider
URLs and do not upload to R2.

1. In the Cloudflare dashboard, create a bucket and an R2 API token with
   **Object Read & Write** on that bucket.
2. In the **R2 storage** card at `/dashboard`, enter the account ID (32 hex
   characters), the token's access key ID and secret access key, the bucket
   name and, optionally, an `https://` public base URL (a custom domain or
   `r2.dev` address serving the bucket). Without a public URL, files get
   presigned links valid for up to 7 days.
3. **Check and save** lists the bucket (`ListObjectsV2`, one key), uploads an
   empty `.multix-probe` object and deletes it again. Nothing is saved if a
   step fails; the page says which one (credentials refused, bucket missing,
   read-only token, R2 unreachable).

The settings are stored as one AES-GCM record under `r2:<account>` in
`ACCOUNTS_KV`, like provider keys. The page shows only the bucket name and
public URL; replacing the settings asks for the secret again. **Remove**
deletes them.

## Deploy

Requirements: Node 20+, a Cloudflare account with a zone for your domain, and
`wrangler` (installed as a worker dev dependency).

1. **Create a GitHub OAuth App** at
   [github.com/settings/applications/new](https://github.com/settings/applications/new).
   Homepage URL: your public origin (for example `https://mcp.example.com`).
   Authorization callback URL: `<origin>/oauth/github/callback`.
2. **Create two KV namespaces** and put their IDs in `worker/wrangler.jsonc`
   (`OAUTH_KV` holds OAuth clients, grants and hashed tokens; `ACCOUNTS_KV`
   holds accounts and encrypted provider keys):

   ```bash
   cd worker
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler kv namespace create ACCOUNTS_KV
   ```

3. **Edit `worker/wrangler.jsonc`:** set `routes` to your host,
   and `MULTIX_PUBLIC_URL` to the public origin. The repository's file is
   configured for `multix.zuey.me`.
4. **Set the secrets** and deploy:

   ```bash
   npm ci --prefix worker
   cd worker
   npx wrangler login
   npx wrangler secret put GITHUB_CLIENT_ID
   npx wrangler secret put GITHUB_CLIENT_SECRET
   openssl rand -hex 32 | npx wrangler secret put SESSION_SECRET
   openssl rand -base64 32 | npx wrangler secret put SECRETS_ENCRYPTION_KEY
   # GitHub logins or verified emails that may sign in, comma-separated
   npx wrangler secret put MULTIX_ALLOWED_USERS
   cd ..
   npm run deploy:mcp
   ```

Keep `SECRETS_ENCRYPTION_KEY` safe: replacing it makes every saved provider key
unreadable. Those providers then report as not configured until each account
saves its keys again. Replacing
`SESSION_SECRET` signs everyone out of the dashboard.

Check it is up (this endpoint is public and returns only `{ "ok": true }`):

```bash
curl https://mcp.example.com/health
```

### Sharing a host with another site

The Worker only needs these paths: `/mcp`, `/dashboard`, `/oauth/*`,
`/.well-known/oauth-*` and `/health`. Path routes take priority over a Custom
Domain on the same host, so another Worker (for example a docs site) can keep
serving every other path. `multix.zuey.me` is set up this way.

### Run locally

Create a second GitHub OAuth App with the callback
`http://localhost:8787/oauth/github/callback`. Copy
`worker/.dev.vars.example` to `worker/.dev.vars` (git-ignored), fill in its
values, then:

```bash
npm run dev:mcp   # http://localhost:8787/mcp and /dashboard
```

## Connect a client

1. Sign in at `<origin>/dashboard` and save the provider keys you want to use.
2. Add the server to any MCP client that supports remote servers with OAuth
   (Claude, Claude Code, Cursor, VS Code, …). The client registers itself,
   opens a browser to sign in with GitHub, and asks you to approve the
   connection.

With Claude Code:

```bash
claude mcp add --transport http multix https://mcp.example.com/mcp
```

Then run `/mcp` in Claude Code and choose **Authenticate**. Other clients:

```json
{
  "mcpServers": {
    "multix": { "type": "http", "url": "https://mcp.example.com/mcp" }
  }
}
```

Connected clients appear in the dashboard, where **Disconnect** revokes their
access. A tool that needs a provider you have not saved a key for reports that
provider as not configured.

A typical video flow is `multix_generate_video` → repeat
`multix_prediction_status` every 10–30 seconds until `done` is `true` → read
`outputs`.

## Configuration

Secrets (set with `npx wrangler secret put <NAME>`):

| Secret | Effect |
|---|---|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth App used for sign-in. |
| `SESSION_SECRET` | At least 32 characters. Signs dashboard cookies and form tokens. |
| `SECRETS_ENCRYPTION_KEY` | Base64 of exactly 32 random bytes. Encrypts saved provider keys. |
| `MULTIX_ALLOWED_USERS` | Comma-separated GitHub logins (case-insensitive) or verified emails (entries containing `@`) that may sign in. Unset or empty allows nobody. It is a secret so the list (which may hold emails) stays out of the repository, and it changes without a deploy. |

If any of the first four is missing or invalid, or `MULTIX_PUBLIC_URL` is not an
`https://` origin, sign-in, consent and the dashboard return `503` (fail
closed). `http://localhost` is accepted for local development.

Set these as `vars` in `worker/wrangler.jsonc`:

| Variable | Default | Effect |
|---|---|---|
| `MULTIX_PUBLIC_URL` | — (required) | Public origin, for example `https://mcp.example.com`. Used for OAuth metadata, redirects and the GitHub callback. |
| `MULTIX_MCP_ALLOWED_PROVIDERS` | all | Comma-separated provider allowlist, e.g. `replicate,heygen`. |
| `MULTIX_MCP_ALLOWED_MODELS` | any | Comma-separated `provider:model` allowlist, e.g. `replicate:black-forest-labs/flux-schnell,heygen:heygen-video-1`. When set, every model (including defaults) must be listed. |
| `MULTIX_MCP_MAX_OUTPUTS` | `4` (ceiling 10) | Maximum `num_outputs` per image call. |
| `MULTIX_MCP_MAX_VIDEO_SECONDS` | `10` (ceiling 15) | Maximum video `duration`. When a caller omits `duration`, the server sends a length explicitly instead of leaving the provider default: `min(5, cap)` seconds on Replicate, HeyGen and Cloudflare; on Atlas Cloud see [Spend guard](#security-model). |
| `MULTIX_MCP_ALLOWED_RESOLUTIONS` | `480p,720p,768p,1080p` | Video resolutions a caller may request (`768p` is a HeyGen Video size). Anything else (for example `4k`) is rejected before the provider call. An omitted resolution uses the model default; on Atlas Cloud that default (and any `output_resolution`, `target_resolution`, resolution-valued `quality`, `size`, `width` or `height`, or a resolution named in the model ID) is checked against this list too. |
| `MULTIX_MCP_ALLOWED_ORIGINS` | none | Exact browser origins (for example `https://app.example.com`) allowed to call `/mcp`. `*` and other wildcards are not supported: `*` only matches a literal `*` origin, which browsers never send. After the access token is checked, requests with any other `Origin` header get `403`; requests without an `Origin` (server-side clients) are allowed. Listed origins get CORS headers. `OPTIONS` preflights are answered for any origin by the OAuth layer. |

Two [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
bindings in `wrangler.jsonc` bound abuse; excess requests get `429`:

- `MCP_RATE_LIMITER`: about 60 `/mcp` requests per minute per account.
- `AUTH_RATE_LIMITER`: about 30 requests per minute per client IP on sign-in,
  authorization, client registration, token and dashboard writes.

The limits are approximate: Cloudflare counts per location and the counters are
eventually consistent, so treat them as abuse protection, not an exact budget.
Adjust `simple.limit`/`simple.period` there. `namespace_id` must be unique
within your Cloudflare account. If another Worker already uses `1001` or
`1002`, pick different integers, or the two Workers will share counters.

## Security model

- **Authentication:** `/mcp` is an OAuth 2.1 protected resource, served with
  [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
  Clients discover it through `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server`, register dynamically
  (`/oauth/register`) or by Client ID Metadata Document, and use PKCE.
  Requests without a valid access token get `401` with a
  `WWW-Authenticate` challenge. Tokens are stored hashed in `OAUTH_KV`.
- **Sign-in and consent:** GitHub OAuth (with PKCE and `state`), then a consent
  page that names the client and its redirect address. Accounts not on
  `MULTIX_ALLOWED_USERS` are refused before anything is stored.
- **Dashboard:** cookies are `__Host-` prefixed, `Secure`, `HttpOnly`,
  `SameSite=Lax` and HMAC-signed, with a 7-day session. **Sign out** ends
  every dashboard session of the account on every device (it can take about a
  minute to reach every location); MCP connections stay until you disconnect
  them. Every form needs a per-session CSRF token and a same-origin `Origin`
  header. Pages send a strict Content Security Policy and
  `frame-ancestors 'none'`.
- **Account isolation:** each `/mcp` request loads only the keys of the
  account that granted the token. Keys never appear in pages, logs or tool
  results.
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
- **Stateless MCP:** no MCP sessions. Each request builds a fresh server with
  the caller's keys. OAuth state and accounts live in KV.

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
