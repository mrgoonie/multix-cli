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
| `multix_model_catalog` | The [model and provider catalogue](/commands/catalog/), read-only: `view` is `providers`, `models`, `show` (with `offering`) or `compare` (one exact request: `task`, `resolution`, `duration_s`, `audio`, `aspect_ratio`, `images`). For `providers`, `models` and `compare`, the same payload as the `data` of `multix catalog <view> --json` (`show` returns the offering without the CLI's local usage, ratings and notes); readiness comes from your saved keys. Usage, ratings, reviews and notes stay local and are not served. |
| `multix_run` | Run one CLI command in its own container with your saved keys. Waits up to `wait_seconds` (default 25, max 40, container start included), then returns the result or a job ID to poll. At most 2 running jobs per account by default (`MULTIX_MAX_JOBS_PER_ACCOUNT`). |
| `multix_job_status` | Read a `multix_run` job: status, output URLs, stdout and the tail of stderr. |
| `multix_job_cancel` | Stop a running job and its container. |
| `multix_skills` | Read-only access to the [skills catalogue](#skills): `search` for a skill, `get` its entry, `read` one of its text files. |
| `multix_skills_manage` | [Author your own skills](#author-your-own-skills): drafts, publishing, revisions, settings and team sharing. It never runs a skill. |

`multix_catalog`, `multix_model_catalog` and `multix_skills` are always listed. `multix_run`,
`multix_job_status` and `multix_job_cancel` appear only when the Worker has its job bindings
(`MULTIX_JOBS` and `MULTIX_JOB_QUOTA`, see [Deploy](#deploy)). `multix_skills_manage` appears only
when the Worker has the `MULTIX_SKILLS` binding.

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
  tool error. A run the caps cannot bound needs it when the server runs such
  runs in `budget` mode (see below).
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
sent when a video command's default is unknown or longer; `leonardo video`,
which takes no `--duration` and renders up to 8 s, is refused when the cap is
below 8) and resolution (`MULTIX_MCP_ALLOWED_RESOLUTIONS`). The server chooses the output
directory, `--output` must be a plain file name, options the CLI turns into part of a
file name (such as `elevenlabs voices design --output-prefix` or a dub
language) accept only letters, digits, `_` and `-`, the OpenAI image commands
always use the API driver, the Gemini video commands always use Gemini Omni
Flash (an allowed resolution, 720p when permitted, is sent when the caller
omits it), and `@file` values are rejected. Commands that
change your own provider account (for example deleting an ElevenLabs voice)
run like any other, with your key.

**Runs the caps cannot bound.** Some runs spend more than the caps above can
see. `multix_catalog` marks them with `uncapped_spend` (on the command, or on
the option that makes a run uncapped):

- pass-through request bodies: `fal run`, `replicate run`, `atlas run`,
  `heygen run`, `topview run`, `--input` of `replicate image` and
  `replicate video`, `--input` / `--text-field` of `fal tts`, and `--param`
  of `sume image`;
- runs billed by the length of their source or script: `heygen video`,
  `heygen translate`, `heygen lipsync`, `elevenlabs dub`, `topview
  video-avatar`, `topview product-avatar`, and `heygen video-agent` /
  `heygen template`, where the agent or template sets the length;
- `sume video`, where the model's catalog row sets the price and lip-sync and
  captions models bill by the length of the source media;
- `atlas image`, `atlas image-to-image`, `sume image` and `replicate image`
  without `--num-images` / `--num-outputs`, where the model picks the number of
  outputs. Passing the count (at most `MULTIX_MCP_MAX_OUTPUTS`) makes the run
  capped again.

The operator decides what such a run needs with `MULTIX_MCP_UNCAPPED_SPEND`.
In `budget` mode (the default) the call must give `max_cost_usd`, and the job
starts only when the price estimate proves the run fits (`cost_policy` is
treated as `strict` for these runs, since the estimate cannot see the uncapped
part). None of these
commands is priced yet, so in practice `budget` refuses them, closed rather
than open. `deny` always refuses them; `allow` runs them as before, on the
caller's own keys. An `estimate: true` call is answered in every mode, since it
starts nothing. The REST API (`POST /api/v1/jobs`) takes the same
`max_cost_usd` and `cost_policy` fields and applies the same rule.

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

**Sume and TopView.** Both groups run remotely. Give file flags (Sume
`--image`, `--end-image`, `--reference-image`, `--video` and `--audio`; the
TopView Legacy file flags and the `topview upload` file) as `https://` URLs in
`inputs`. `sume estimate` uploads nothing, so it takes its media as plain
`https://` URLs. `sume image --num-images` and `topview product-anyshoot
--count` are capped by `MULTIX_MCP_MAX_OUTPUTS`, and `sume video --duration` and `--resolution` by the
video limits; pass a `--duration` the model's catalog row lists, because
without one the server sends its own default length. `topview run --input`
must be inline JSON, since `@file` values are rejected. `sume image`,
`sume video`, `topview run` and the TopView Legacy commands other than
`product-avatar` do not wait by default: set `"wait": true` in `options`, or
resume later with `sume status <id> --wait --download`,
`topview status <kind> <taskId> --wait --download` or
`topview prediction <id> --wait --download`. See
[Sume](/commands/sume/) and [TopView](/commands/topview/).

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
- Without the job container, only `multix_catalog`, `multix_model_catalog` and
  `multix_skills` are listed, so no command can run.
- `multix catalog` commands: they read your local usage and reviews. Use
  `multix_model_catalog` for offerings, prices and comparisons.

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
  "API secret", HeyGen, Sume, TopView with `TOPVIEW_API_KEY` and
  `TOPVIEW_UID`, and TopView Platform), plus the Cloudflare Workers AI
  account ID, API token and optional AI Gateway ID.
  `TOPVIEW_UID` is an account ID, not a secret, so it has a plain text input
  instead of a password field. A `topview` job gets all three TopView values;
  the Legacy commands need `TOPVIEW_API_KEY` and `TOPVIEW_UID`, the API
  Platform commands `TOPVIEW_PLATFORM_API_KEY`.

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
   `durable_objects` and `exports`; only `multix_catalog`, `multix_model_catalog`
   and `multix_skills` are then listed (built-in skills only). The
   `MULTIX_JOB_QUOTA` binding (class `AccountJobQuota`) holds the running-job
   counts per account and server-wide, and is required together with
   `MULTIX_JOBS`. The `MULTIX_EVENTS` binding (class `AccountEvents`) holds
   each account's [webhook subscriptions](/guides/rest-api/#job-event-webhooks)
   and deliveries, from the REST API and from
   [MCP Events](#mcp-events-protocol-2026-07-28); without it the
   `/api/v1/events` routes answer `503` and `server/discover` does not offer
   events. The `MULTIX_SKILLS` binding (class `AccountSkills`) holds each
   account's private and team [skills](#skills); without it only the built-in
   skills are served, `multix_skills_manage` is not listed and the
   `/api/v1/skills` routes answer `503`.
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

## Skills

The server serves a catalogue of agent skills: the `SKILL.md` instructions that tell an agent how to use multix. Reading a skill
never runs or activates it, and the server never executes skill files.

The built-in skills are the repository's `skill/` directory, bundled into the
Worker when it is built (`npm run skills` in `worker/`, run automatically
before `dev`, `build`, `typecheck`, `test` and `deploy`):

- `skill://multix/SKILL.md`: the entry skill, the same text the npm package
  installs locally.
- `skill://multix/<name>/SKILL.md` for the task skills `image-generation`,
  `video-production`, `speech-production`, `media-qa`,
  `document-conversion` and `3d-generation`. Each one tells the agent to pick a
  model live with `multix models --task <task> --ready` or
  `multix models --model <id>`.

Two more URI spaces are reserved for account skills, kept per account in the
`AccountSkills` Durable Object as immutable revisions with content-addressed
(SHA-256) files: `skill://private/<name>/<file>` for your own skills and
`skill://team/<ownerId>/<name>/<file>` for team skills you own or were granted.
You publish and share them yourself (see
[Author your own skills](#author-your-own-skills)). Another account's skills
are never visible unless it granted you a team skill and you added it: an
unknown skill and a forbidden one get the same answer.

### Protocol 2026-07-28 clients

`server/discover` declares `resources` and the
`io.modelcontextprotocol/skills` extension with `directoryRead: true`. The
client can then call:

| Method | Returns |
|---|---|
| `skills/list` | Skill entries, 50 per page; pass the opaque `nextCursor` back as `cursor`. |
| `skills/get` `{ uri }` | One skill entry, by the URI of its `SKILL.md`. |
| `resources/read` `{ uri }` | One file of a skill. |
| `resources/directory/read` `{ uri, cursor? }` | The direct children of a skill directory; directories have mimeType `inode/directory`. |

A skill entry has its `uri` (its `SKILL.md`), its `frontmatter` (the YAML
verbatim, as JSON), its `resources` (`uri`, `digest` as `sha256:<hex>`,
`size`), and `_meta["me.zuey.multix/skill"]` with `id`, `version`, `revision`,
`manifestDigest`, `status`, `visibility`, `tags` and `capabilities`. The cache
hints are 5 minutes, `public`, for built-in skills only, and 1 minute,
`private`, once account skills are included.

Errors are JSON-RPC `-32602` with a fixed message (such as
`No skill is served at <uri>` or `Invalid cursor`) and the stable code in
`data.code`: `INVALID_URI`, `UNKNOWN_SKILL`, `NOT_FOUND`, `NOT_DIRECTORY` or
`INVALID_CURSOR`.

### 2025 clients

The extension methods answer `-32601`, but `resources/list` lists every
`SKILL.md` and `resources/read` reads any file. The `multix_skills` tool,
offered on both protocol revisions, covers the rest:

- `{"action": "search", "query": "trim", "task": "video"}`: find skills by
  words, a task (a `multix models --task` value), or both.
- `{"action": "get", "uri": "skill://multix/media-qa/SKILL.md"}`: the same
  entry as `skills/get`.
- `{"action": "read", "uri": "…", "revision": 3}`: one text file. Pass the
  `revision` or `digest` from an earlier `get` to get `STALE_REVISION: …` if it
  changed since. Binary files answer `BINARY_FILE: …` and text files over
  256 KiB `PAYLOAD_TOO_LARGE: …`; read those with `resources/read`.

Tool errors start with the same stable codes, plus `STALE_REVISION`,
`BINARY_FILE` and `PAYLOAD_TOO_LARGE`.

### Which skill describes which CLI

The skill installed with the npm package matches your installed CLI. The remote
catalogue serves the `skill/` of the deployed Worker, and its `version` (in the
frontmatter and in `_meta`) is that Worker's CLI version. When they differ, an
agent using this server should follow the remote catalogue, and an agent
running the CLI locally should follow the local skill.

### Author your own skills

`multix_skills_manage` and the REST routes under
[`/api/v1/skills`](/guides/rest-api/#skills) create, publish and share your
own skills. Both use the same code, so checks, conflicts and limits are the
same. Every write goes to your own registry: no account can change another
account's skills. Nothing here runs a skill; readers use the methods above.

The workflow, as MCP `action` (REST route in parentheses):

1. `save_draft` (`PUT /skills/{skill}/draft`): add or replace `files` (a
   `path` with `text`, or `base64` for any file type) and remove `delete`
   paths. A new draft starts from the served revision, from `from_revision`,
   or from no files with `replace`. A draft is never served.
2. `get_draft` and `read_file` (`GET …/draft`, `GET …/files?path=`) show it;
   `read_file` with `revision` reads a stored revision instead.
3. `publish` (`POST …/publish`): the draft becomes the next immutable
   revision, served at `skill://private/<name>/SKILL.md`, or at
   `skill://team/<your account id>/<name>/SKILL.md` when `visibility` is
   `team`. The `name` in its `SKILL.md` frontmatter must be the skill name.
   `visibility`, `tags` and `capabilities` (task ids or `any`) can be set with
   it; a new skill is `private`.

Revision numbers count up per skill and are never reused, even after a
revision is deleted. `revisions` and `revision` list and inspect them;
`set_current` (`POST …/current`) serves another stored revision (roll back or
forward); `unpublish` stops serving the skill and keeps its revisions;
`delete_revision` removes any revision except the served one; `delete` removes
the skill with every revision, its draft and its grants. `update`
(`PATCH /skills/{skill}`) changes `visibility`, `tags` and `capabilities`; a
visibility change moves the skill to the other URI and revokes every grant.

To avoid overwriting a concurrent change, send the value you last read
(`get` returns `draft.digest` and `skill.current_revision`); a mismatch fails
with `CONFLICT` (REST `409`):

- `expected_digest`: the draft digest, on `save_draft`, `discard_draft` and
  `publish`. Over REST, `null` on a draft update means you expect no draft.
- `expected_revision`: the served revision, on `publish`, `set_current`,
  `unpublish` and `update`. "None served" is `0` over MCP and `null` over
  REST.

Team sharing is opt-in for the grantee. The owner of a team skill calls
`grant` with an account id (`gh-<digits>`, the `id` of `GET /api/v1/me`);
`grants` lists them and `revoke` withdraws one. A grant adds nothing to the
grantee's catalogue: the grantee calls `add_shared` with the skill's `uri`
(`skill://team/<owner>/<name>/SKILL.md`) to list it in `skills/list` and
`multix_skills`, and `remove_shared` to drop it. In `list`, a shared skill
shows `available: false` once the owner revoked the grant, unpublished or
deleted the skill. A revoke ends that listing even if the owner grants access
again; the grantee then has to add it again.

Tool errors start with `INVALID_INPUT`, `NOT_FOUND` or `CONFLICT` (REST `400`,
`404`, `409`). Limits:

- per account: 200 skills, 200 drafts and 200 listed shared skills;
- per skill: 100 stored revisions (delete old ones to publish more), 100
  grants, 512 files and 16 MiB, 1 MiB per file;
- one draft update carries at most 8 MiB of decoded files.

MCP requests are capped at 64 KiB, so spread files over several `save_draft`
calls, and upload a file that does not fit in one request with
`PUT /api/v1/skills/{skill}/draft` (a body of up to about 11 MiB).

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
| `MULTIX_MCP_UNCAPPED_SPEND` | `budget` | Runs the caps above cannot bound (marked `uncapped_spend` in `multix_catalog`): `budget` runs one only with a `max_cost_usd` its price estimate proves (an unknown price is refused), `deny` refuses it, `allow` runs it. Any other value means `budget`. |
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
  [Running CLI commands](#running-cli-commands)). A run those caps cannot
  bound (a pass-through JSON body, a price set by the source length, a count
  the model picks) is refused unless `max_cost_usd` proves its price, or as
  `MULTIX_MCP_UNCAPPED_SPEND` sets. A caller can also set `max_cost_usd` to
  refuse any run that may cost more.
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
