---
title: Remote MCP server on Cloudflare Workers
description: Deploy the multix MCP server to Cloudflare Workers so remote AI agents can run multix CLI commands in a Cloudflare Container, over Streamable HTTP, with GitHub sign-in, OAuth and a dashboard for each account's provider keys and R2 bucket.
---

The repository ships an optional, stateless [Model Context Protocol](https://modelcontextprotocol.io)
server in `worker/`. It serves MCP tools over **Streamable HTTP** at `/mcp`, so
agents that cannot run the CLI locally (hosted assistants, web IDEs, other
servers) can run almost any `multix` CLI command remotely: each run gets its
own [Cloudflare Container](https://developers.cloudflare.com/containers/) with
the CLI, ffmpeg and ImageMagick installed, and output files are uploaded to the
caller's own R2 bucket. Every provider call goes through `multix_run`.

The worker is a separate package. It is not part of the published npm CLI and
does not change how `multix` behaves on your machine.

## What it exposes

| Tool | Purpose |
|---|---|
| `multix_catalog` | The CLI commands `multix_run` can run. Without `group`: every group, its commands and whether you saved keys for it (`has_keys`). With `group`: each command's positionals and options, which ones take files, and the values the server forces. With `task` (such as `speech`): only the commands and verified models for that task; add `group` to stay in one group. With `model`: a verified model's inputs, voices and output formats and how to pass it to `multix_run`, or `verified: null` when its inputs are unknown. |
| `multix_price_book` | Providers, model offerings and their sourced list prices, the same data as `multix catalog --json`. `view`: `providers` (tasks, docs, pricing page, whether you saved the keys), `models` (price status; filter by `task`, `provider`, `family`, `priced`, `verified`), `show` with `ref` (`<provider>:<model>`: every rate with source, check date and freshness) or `compare` with `family` (one family across providers, like-for-like quotes ranked cheapest first, the rest listed with the reason they cannot be ranked). Quote with `resolution`, `duration`, `aspect_ratio`, `audio`, `count`. Unknown prices stay unknown, never $0; list prices say nothing about quality. Read-only; never returns key values. See [Catalog commands](/commands/catalog/). |
| `multix_run` | Run one CLI command in its own container with your saved keys. Waits up to `wait_seconds` (default 25, max 40, container start included), then returns the result or a job ID to poll. At most 2 running jobs per account by default (`MULTIX_MAX_JOBS_PER_ACCOUNT`). |
| `multix_job_status` | Read a `multix_run` job: status, output URLs, stdout and the tail of stderr. |
| `multix_job_cancel` | Stop a running job and its container. |

`multix_catalog` and `multix_price_book` are always listed. `multix_run`, `multix_job_status` and
`multix_job_cancel` appear only when the Worker has its job bindings
(`MULTIX_JOBS` and `MULTIX_JOB_QUOTA`, see [Deploy](#deploy)).

## Running CLI commands

`multix_run` takes the same command and options you would type locally, as
JSON:

- `command`: the command path, for example `"gemini generate"` or
  `"media optimize"`. `multix check` and `multix update` cannot run.
- `options`: options by long name without dashes. Values are strings,
  numbers, `true` for a flag (including `no-*` flags), or a list for an option
  that repeats.
- `args`: positionals, in order.
- `inputs`: public `https://` URLs for options and positionals that take a
  file, keyed by their name. The container downloads them (at most 10 files,
  200 MB each) and passes the local paths to the CLI. Plain file paths are
  rejected. Where a provider accepts its own asset ID, `asset:<id>` can be
  given as the value instead.
- `wait_seconds`: how long the call waits for the job, counted from the
  call, so starting the container is included (0–40, default 25).
- `estimate`: `true` prices the run like the CLI's `--estimate` and returns
  `{ estimate_only, command, estimate, budget? }` without starting a job.
- `max_cost_usd`: a number ≥ 0. The job does not start unless the cost fits,
  under the same rules as the CLI's `--max-cost`; a refusal comes back as a
  tool error.
- `cost_policy`: `"strict"` (default, proven ceiling only) or `"estimate"`
  (accept the estimated high end). See
  [Cost](/reference/for-ai-agents/#cost-estimate-spend-guard-and-receipt) for
  which commands are priced.

Call `multix_catalog` with a group to see exactly which options a command
takes and which of them are files. An example call:

```json
{
  "command": "gemini analyze",
  "options": { "prompt": "Summarise this clip in three bullet points" },
  "inputs": { "files": "https://cdn.example.com/clip.mp4" },
  "wait_seconds": 40
}
```

The result is always the same shape:

```json
{
  "job_id": "4b0c…",
  "status": "succeeded",
  "outputs": [{ "name": "frame.png", "url": "https://…", "bytes": 48213 }],
  "stdout": "…",
  "stderr_tail": "",
  "exit_code": 0
}
```

`status` is `running`, `succeeded`, `failed`, `timed_out` or `canceled`.
While it is `running`, the result has a `next` hint: call `multix_job_status`
with the `job_id` every 10–30 seconds. One 30-minute limit covers the whole
job: downloading inputs, running the CLI and uploading outputs. The job's
record is kept for 7 days. Only the account that started a job can read or
cancel it.

**Webhooks instead of polling.** A script or service can also be told when a
job ends: subscribe an https endpoint with an [account API key](#api-keys-for-the-rest-api)
and the server POSTs a signed event (`multix.job.completed`, `failed`,
`canceled`, `timed_out`, plus `multix.asset.ready` per stored output). Events
carry ids and final state only, so read the outputs with `multix_job_status`
when one arrives; polling stays the fallback. See
[Job event webhooks](/guides/rest-api/#job-event-webhooks).

**Concurrency.** Each account can have at most **2** jobs running at once
(`MULTIX_MAX_JOBS_PER_ACCOUNT`). One more `multix_run` fails with
`busy: you already have 2 running jobs; wait for one to finish or cancel it`
until one ends; cancel one with `multix_job_cancel` if needed. A job's slot is
given back when it ends, and frees itself after about 45 minutes if the job was
lost. When the server already runs `MULTIX_MAX_JOBS_TOTAL` jobs (default 10)
across all accounts, the call fails with `server at capacity` instead; retry
after a few minutes.

**Error codes.** A failed tool call keeps its message as text and adds
`structuredContent.error` with `code`, `retryable` and `hint`, the same codes as
the CLI's `--json` envelope (see [For AI agents](/reference/for-ai-agents/#exit-codes-and-error-codes)).
`busy` and `server at capacity` come back as `RATE_LIMITED` with
`retryable: true`. A job that ran and failed reports a non-zero `exit_code`, and
its `stderr_tail` ends with the CLI's `code:`, `hint:` and `next:` lines, which
name the error class.

**Output files need R2.** The files the CLI writes are uploaded to your own R2
bucket under `<directory>/<account hash>/<job id>/<name>` (the directory is
`multix` unless you choose another one), and `outputs` lists their
public or presigned URLs. At most 50 files are reported per job, and a file
over 500 MB is listed with `url: null` instead of being uploaded. If you have not saved an R2 bucket, the job still
runs, but each output has `url: null` and the result carries a `note` asking
you to configure R2 in `/dashboard`. stdout (with any provider URLs
the CLI prints) is returned either way. Keys never appear in `stdout` or
`stderr_tail`: the values of your saved keys are replaced with `[redacted]`.

Server limits apply to `multix_run` too: the output count
(`MULTIX_MCP_MAX_OUTPUTS`), video length (`MULTIX_MCP_MAX_VIDEO_SECONDS`, also
sent when a video command's default is unknown or longer) and resolution
(`MULTIX_MCP_ALLOWED_RESOLUTIONS`). The server chooses the output directory,
`--output` must be a plain file name, options the CLI turns into part of a
file name (such as `elevenlabs voices design --output-prefix` or a dub
language) accept only letters, digits, `_` and `-`, the OpenAI image commands
always use the API driver, the Gemini video commands always use Gemini Omni
Flash (an allowed resolution, 720p when permitted, is sent when the caller
omits it), and `@file` values are rejected. Commands that
change your own provider account (for example deleting an ElevenLabs voice)
run like any other, with your key.

**Gemini edit and extend.** `gemini extend-video --duration` is the length of
the new continuation and is capped like any other duration, but the returned
video also contains the source. The cap therefore bounds each call, not the
clip: extending a stored interaction again (`--interaction-id`) makes it longer
each time, and `gemini edit-video` keeps the source's length. The server cannot
see a stored interaction's length, so it does not bound a chain beyond
Google's own limit of 40 seconds in total; every call is billed to your own
Gemini key.

**Runway.** `runway video` and `runway image` can run remotely; give
`--image` and each `--reference` as `https://` URLs in `inputs`, and
`--duration` is capped by `MULTIX_MCP_MAX_VIDEO_SECONDS`. A prompt must not
start with `@`, so put text before an `@tag` (`"a portrait of @hero"`).
`runway video` does not wait by default, so the job ends with only a task ID:
set `"wait": true` in `options` to get the video, or run
`runway status <id> --wait --download` later.

**Speech.** `speech generate` must name `--provider`. The job gets only the
keys of the providers named by `--provider` and `--fallback`, not every speech
key you saved. Give `--text-file` as an `https://` URL in `inputs`.
`speech models --ready` is rejected remotely because it would describe the
container; `multix_catalog` reports `has_keys` for your saved keys instead.
See [Speech commands](/commands/speech/).

### Not available remotely

- Local files: give a public `https://` URL in `inputs` instead.
- Interactive and local-only features: `multix update`, `multix check`, the
  Codex image driver, `--stdin-ext`, and reading values from `@file`.
- Choosing where files go: the server sets the output directory. Download
  outputs from their R2 URLs.
- Without the job container, only `multix_catalog` is listed, so no command
  can run.

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
  `REPLICATE_API_KEY` as fallback, Runway's `RUNWAYML_API_SECRET` as
  "API secret", HeyGen), plus the Cloudflare Workers AI
  account ID, API token and optional AI Gateway ID.

### API keys for the REST API

The **API keys** card in `/dashboard` creates and revokes account API keys
(`mxk_…`, shown once, at most 10 per account) for the REST API at `/api/v1`,
which lets scripts and CI manage provider keys and R2 storage and run jobs
without MCP. See [REST API](/guides/rest-api/) and the reference at `/api/docs`.

### R2 storage

Each account can also save its own Cloudflare R2 bucket. `multix_run` uploads
every output file there; without a bucket, jobs still run but return no file
URLs.

1. In the Cloudflare dashboard, create a bucket and an R2 API token with
   **Object Read & Write** on that bucket.
2. In the **R2 storage** card at `/dashboard`, enter the account ID (32 hex
   characters), the token's access key ID and secret access key, the bucket
   name and, optionally, an `https://` public base URL (a custom domain or
   `r2.dev` address serving the bucket). Without a public URL, files get
   presigned links valid for up to 7 days. **Directory path** (default
   `multix`) is the folder in the bucket that outputs go to, for example
   `agents/outputs`. It may use letters, digits, `.`, `_`, `-` and `/`
   (at most 256 characters, no `.` or `..` segments); surrounding slashes are
   dropped.
3. **Check and save** lists the bucket (`ListObjectsV2`, one key), uploads an
   empty `.multix-probe-*` object into the directory path and deletes it again. Nothing is saved if a
   step fails; the page says which one (credentials refused, bucket missing,
   read-only token, probe could not be deleted, R2 unreachable). Bucket-scoped
   tokens are recommended: an account-wide token can reach every bucket.

The settings are stored as one AES-GCM record under `r2:<account>` in
`ACCOUNTS_KV`, like provider keys. The page shows only the bucket name and
public URL; replacing the settings asks for the secret again. **Remove**
deletes them.

## Deploy

Requirements: Node 20+, a Cloudflare account with a zone for your domain, and
`wrangler` (installed as a worker dev dependency). The CLI runner also needs
the [Workers Paid plan](https://developers.cloudflare.com/containers/pricing/)
(Containers) and Docker running on the machine that deploys: `wrangler deploy`
builds `worker/container/Dockerfile` from the repository root and pushes the
image to Cloudflare.

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
   configured for `multix.zuey.me`. Its `containers` entry (class
   `MultixJobContainer`, instance type `basic`, at most 10 instances) and the
   `MULTIX_JOBS` Durable Object binding enable `multix_run`. To deploy without
   the CLI runner (no Docker, Workers Free), remove `containers`,
   `durable_objects` and `exports`; only `multix_catalog` is then listed. The
   `MULTIX_JOB_QUOTA` binding (class `AccountJobQuota`) holds the running-job
   counts per account and server-wide, and is required together with
   `MULTIX_JOBS`. The `MULTIX_EVENTS` binding (class `AccountEvents`) holds
   each account's [webhook subscriptions](/guides/rest-api/#job-event-webhooks)
   and deliveries, from the REST API and from
   [MCP Events](#mcp-events-protocol-2026-07-28); without it the
   `/api/v1/events` routes answer `503` and `server/discover` does not offer
   events.
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
unreadable. Those keys then count as not saved (`has_keys: false` in
`multix_catalog`) until each account
saves its keys again. Replacing
`SESSION_SECRET` signs everyone out of the dashboard.

Check it is up (this endpoint is public and returns only `{ "ok": true }`):

```bash
curl https://mcp.example.com/health
```

### Sharing a host with another site

The Worker only needs these paths: `/mcp`, `/dashboard`, `/oauth/*`,
`/.well-known/oauth-*`, `/health` and `/api/*`. Path routes take priority over a Custom
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
access. `multix_catalog` reports `has_keys: false` for a group whose keys you
have not saved; save them in the dashboard before running its commands.

A typical flow, for example a video: `multix_catalog` → `multix_catalog` with
the group (such as `replicate`) → `multix_run` → repeat `multix_job_status`
every 10–30 seconds until `status` is `succeeded`, `failed`, `timed_out` or
`canceled` → read `outputs`.

## MCP Events (protocol 2026-07-28)

The server speaks two MCP protocol revisions on the same `/mcp` endpoint:

- **2025 clients** (the `initialize` handshake, any 2025 protocol revision)
  get the tools exactly as before. Nothing changes for them.
- **2026-07-28 clients** negotiate through `server/discover` and send the
  protocol version on every request. `server/discover` lists `2026-07-28`
  and, when the Worker has the `MULTIX_EVENTS` binding, the
  `events` capability, so the client can subscribe to
  [MCP Events](https://developers.openai.com/plugins/build/mcp-events) with
  `events/list`, `events/subscribe` and `events/unsubscribe`.

| Event | When |
|---|---|
| `multix.job.completed` | A `multix_run` job you started succeeded. |
| `multix.job.failed` | It failed. |
| `multix.job.canceled` | It was canceled. |
| `multix.job.timed_out` | It ran out of time. |
| `multix.asset.ready` | One of its output files was stored in your R2 bucket. |

Every event takes one optional argument, `job_id`, to narrow it to one job you
own; without it the subscription covers all your jobs. `events/list` gives
each event's `payloadSchema`: the same `data` as the
[REST webhooks](/guides/rest-api/#job-event-webhooks) (ids, final status,
command, provider, times, exit code and output names and sizes), never keys,
prompts, logs or signed URLs.

Each delivery is a `POST` with the MCP Events body
`{ "eventId", "name", "timestamp", "data", "cursor": null }`, the
`webhook-id` (equal to `eventId`), `webhook-timestamp` and `webhook-signature`
headers, and `X-MCP-Subscription-Id`. Failed deliveries are retried with
backoff and then dead-lettered, as for REST subscriptions; dedupe on
`eventId`.

Subscriptions use **webhook** delivery only:

- The callback must be `https://` on the default port with a public host
  name, and every address the name resolves to must be public. IP literals,
  credentials, `localhost`-style names and private, loopback, link-local,
  CGNAT and ULA addresses are refused with `-32602`, before anything is sent.
- The client supplies a `whsec_` secret (base64 of 24–64 bytes). Before a
  subscription is accepted the server POSTs a signed
  `{ "type": "verification", "challenge": … }` message
  ([Standard Webhooks](https://www.standardwebhooks.com) headers) and expects
  a 2xx answer echoing the challenge within 10 seconds. Redirects are not
  followed. A failure answers `-32015` with `data.reason` (`challenge_failed`,
  `timeout`, `connection_refused`, `http_4xx` or `http_5xx`; a callback host
  that cannot be resolved also reports `connection_refused`) and stores
  nothing. Refreshing a live subscription with the same callback and secret
  is not verified again.
- Subscribing again with the same event, arguments and callback refreshes the
  existing subscription (same `id`). Changing the secret keeps signing with the
  old one too for one hour. Lifetimes default to 24 hours and are clamped to
  between 5 minutes and 7 days; `ttlMs: null` gets 7 days, never unlimited.
  Refresh before `refreshBefore`.
- MCP and REST subscriptions share one store per account (the `AccountEvents`
  Durable Object) and its limit of 10 active subscriptions, so no account can
  read, refresh or remove another's. They also show in
  `GET /api/v1/events/subscriptions`, marked `"source": "mcp"` and with
  `job_id` when narrowed to one job. Disconnecting a client in the dashboard
  removes the subscriptions it created or last refreshed, and for 10 minutes
  refuses that client's `events/subscribe` with `-32600`, so a request still in
  flight cannot bring one back. A refresh that finds its subscription disabled
  or expired verifies the callback again. Past events are not replayed: a
  `cursor` from an earlier subscription answers `truncated: true`.

`subscriptions/listen` is not served (the tool list is fixed per deployment).

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
| `MULTIX_MCP_MAX_OUTPUTS` | `4` (ceiling 10) | Maximum output count (for example `--num-images`) per `multix_run` call. |
| `MULTIX_MCP_MAX_VIDEO_SECONDS` | `10` (ceiling 15) | Maximum video duration per call (for `gemini extend-video`, the new continuation). When a caller omits it and the command's default is unknown or longer, the server sends `min(5, cap)` seconds. |
| `MULTIX_MCP_ALLOWED_RESOLUTIONS` | `480p,720p,768p,1080p` | Video resolutions a caller may request (`768p` is a HeyGen Video size). Anything else (for example `4k`), given or the command's default, is rejected before the job starts. |
| `MULTIX_MCP_ALLOWED_ORIGINS` | none | Exact browser origins (for example `https://app.example.com`) allowed to call `/mcp`. `*` and other wildcards are not supported: `*` only matches a literal `*` origin, which browsers never send. After the access token is checked, requests with any other `Origin` header get `403`; requests without an `Origin` (server-side clients) are allowed. Listed origins get CORS headers. `OPTIONS` preflights are answered for any origin by the OAuth layer. |
| `MULTIX_MAX_JOBS_PER_ACCOUNT` | `2` (ceiling 50) | `multix_run` jobs one account may run at the same time. |
| `MULTIX_MAX_JOBS_TOTAL` | `10` (ceiling 1000) | `multix_run` jobs the server may run at the same time across all accounts. Keep it at or below the container `max_instances` in `wrangler.jsonc`, which is the platform ceiling. |

Two [Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
bindings in `wrangler.jsonc` bound abuse; excess requests get `429`:

- `MCP_RATE_LIMITER`: about 60 requests per minute per account, shared by
  `/mcp` and the REST API.
- `AUTH_RATE_LIMITER`: about 30 requests per minute per client IP on sign-in,
  authorization, client registration, token, dashboard writes and REST API
  requests with a missing or invalid API key.

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
  (bounded string lengths, list sizes and numbers), and `multix_run` options
  are checked against the CLI's command catalog. Request bodies over 64 KiB are rejected with `413`. JSON-RPC
  batches (array bodies) are rejected with `400` / `-32600`, so one HTTP
  request is always one tool call and the rate limit bounds calls too.
- **SSRF guard:** every URL in `multix_run` `inputs` must be `https://` on the
  default port, with a public DNS host name. IP literals, credentials in the
  URL, `localhost`, `.local`/`.internal` style names, and cloud metadata hosts
  are rejected before the job starts.
- **Spend guard:** `multix_run` caps output count, video duration and video
  resolution on the options the server knows for each command (see
  [Running CLI commands](#running-cli-commands)). Other inputs that may change
  the price, such as the raw JSON `--input` of `replicate run` or
  `atlas run`, are not capped. A caller can also set `max_cost_usd` to refuse
  a run that may cost more.
- **Logging and redaction:** successful calls are logged at `info` with tool
  name, command (or catalog group), outcome, and latency only. Prompts are never logged as
  a field. Failed calls are logged at `warn` (expected errors) or `error`, with
  an extra `detail` field. It holds the validation or job error message,
  scrubbed of configured secrets, bearer tokens, and URL query strings, and
  truncated. A provider error that echoes part of a prompt (for example a
  moderation message) can therefore appear there. The same scrubbed text is
  returned to the client.
- **CLI runner:** each `multix_run` job gets its own container (one Durable
  Object per job) running as a non-root user. The Worker builds the argument
  list from the CLI's command catalog and rejects unknown commands and
  options, `@file` values, file paths and NUL characters; values are passed as
  `--name=value` and positionals after `--`, and the CLI is started without a
  shell. The CLI process gets only the keys for the command's provider group (for
  `speech generate`, the providers it routes to),
  a fresh temporary home directory and `MULTIX_DISABLE_HOME_ENV=1`. Input URLs
  go through the same SSRF guard in the Worker and again in the container on
  every redirect; the container also resolves each host and refuses to
  connect when any address is private, loopback, link-local, CGNAT or ULA,
    connecting only to the addresses it checked (at most 5 redirects). Output
  files are streamed to R2 without being loaded into memory. The temporary
  directory is deleted when the job ends, stdout and stderr are scrubbed of key
  values and then cut to 16 KB, and only the job ID and status are logged. The `job:<id>` record in `ACCOUNTS_KV` holds the
  owner, command and start time, never keys.
- **Event callbacks:** subscribe-time checks (MCP Events and the REST API)
  refuse non-public callbacks by name and by every resolved address (DNS over
  HTTPS), and the address check runs again right before every delivery, so a
  host re-pointed to a private address later (DNS rebinding) gets nothing: the
  attempt is retried and finally dead-lettered. Callback requests never follow
  redirects, and only the failure category of a verification is returned or
  logged. The Worker cannot pin a connection to the address it checked, so a
  name that flips between the check and the connection is not caught.
- **Stateless MCP:** no MCP sessions. Each request builds a fresh server with
  the caller's keys. OAuth state and accounts live in KV; event subscriptions
  live in a Durable Object per account.

The Worker bundle is checked in CI to contain no `node:*` module, no bare Node
built-in import (`fs`, `child_process`, `path`, …), no `commander` or `execa`,
and no CLI entry code. The Worker source is also type-checked without Node
typings.
