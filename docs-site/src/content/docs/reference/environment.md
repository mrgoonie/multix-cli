---
title: Environment variables
description: Configure multix credentials, model defaults, and output location with environment variables.
---

`multix` reads configuration in this order: process environment, a `.env` file
in the current project, then `~/.multix/.env` (plus [legacy `.claude` files](#legacy-claude-env-files)
when enabled). Keep API keys out of shell
history and never commit them.

The first source that sets a variable wins. A blank or whitespace-only value in
a `.env` file does not count as set, so a project `.env` copied from
`.env.example` (for example `GEMINI_API_KEY=` or `FAL_IMAGE_MODEL=`) does not
hide the value in `~/.multix/.env`. A shell variable always wins, even when it
is blank: run `GEMINI_API_KEY= multix ...` to ignore the key in your `.env`
files for one command.

## What a project `.env` may set

A project `.env` (the current directory, or a legacy `.claude` file under it)
may only set variables that `multix` itself reads:

- the provider credentials listed below, including `GEMINI_API_KEY_2`,
  `GEMINI_API_KEY_3`, …;
- the provider settings on this page, such as `*_BASE_URL`,
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID` and the model overrides;
- the documented `MULTIX_*` settings `MULTIX_OUTPUT_DIR` (so a project can
  choose where generated files are written), `MULTIX_IMAGE_FORMAT`,
  `MULTIX_MAX_DOWNLOAD_MB`, `MULTIX_UPLOAD_MIN_KBPS` and `MULTIX_DISABLE_HOME_ENV`
  (which has no effect there), plus `NO_COLOR`.

The opt-ins `MULTIX_ALLOW_PROJECT_BASE_URL` and `MULTIX_LEGACY_CLAUDE_ENV` are
refused: a repository must not widen what it can do with your keys or pull in
the `.claude` credentials from your home folder.

[`.env.example`](https://github.com/mrgoonie/multix-cli/blob/main/.env.example)
lists them, along with the two opt-ins. Any other name, for example `NODE_OPTIONS`, `npm_config_registry`,
`LD_PRELOAD`, `HTTPS_PROXY` or `NODE_TLS_REJECT_UNAUTHORIZED`, is not loaded,
so it never reaches `multix` or the tools it starts (`npm` during
`multix update`, ffmpeg, ImageMagick, cwebp). `multix` prints one warning on
stderr that lists the ignored names, never their values:

```text
⚠ Ignoring 2 variable(s) in project env file /repo/.env: NODE_OPTIONS, HTTPS_PROXY. A project .env may only set provider keys and documented multix settings; set anything else in your shell.
```

Set such variables in your shell instead. The shell and `~/.multix/.env` are
not filtered. On Windows the check ignores case, as the OS does.

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
| `RUNWAYML_API_SECRET` | Runway (credits, $0.01 each) |
| `HEYGEN_API_KEY` | HeyGen (API credits are billed separately from web plans) |

```bash
export GEMINI_API_KEY="your-key"
export MULTIX_OUTPUT_DIR="./multix-output"
multix check
```

Keys are never forwarded to another origin on an HTTP redirect. If an API
request is redirected to another host, or from `https://` to `http://`, multix stops and
reports the HTTP 3xx status instead of following it. A download that the
provider hands off to a storage host still works, but the key header is removed
before that redirect is followed.

## Gemini key rotation

Add extra Gemini keys as `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, and so on (any
numeric suffix). `multix` uses `GEMINI_API_KEY` first, then the numbered keys in
ascending order; duplicate values are ignored. Numbered keys work on their own,
without `GEMINI_API_KEY`. If a project `.env` leaves `GEMINI_API_KEY` blank and
`~/.multix/.env` sets it, the home key joins that project's rotation and is
tried first.

- A key that returns HTTP 429, or 400/403 with `RESOURCE_EXHAUSTED`, cools down
  for the server's `Retry-After` or `retryDelay`, else 60 seconds, and the same
  request is retried with the next ready key. When every key is cooling, only
  the key that recovers first is tried once. Other errors are not rotated.
- Multi-step requests stay on one key. If the generate call that follows a Files
  API upload is rate-limited, the next key uploads the file again, because an
  uploaded file belongs to the key that created it.
- Veo rotates only on submit. Once a job is accepted, polling and download use
  that key, so a later rate limit never starts a second, separately billed job.
- `multix doc convert` retries a file only after network errors, timeouts, 408
  and 5xx responses other than 501 and 505. It stops on a rate limit, because
  rotation already tried every ready key, and fails at once on a missing key or
  any other 4xx. A Files API upload that times out while sending the file
  bytes, or that the server redirects, is not retried either, and neither is a
  request that cannot be sent at all, such as an API key containing a
  non-ASCII character (for example a smart quote).
- Cooldowns last for the current process only. Logs name the env var, never the
  key value.
- `multix check` lists the keys in rotation and pings each one.
- Gemini quotas apply per Google Cloud project. Keys from the same project share
  one quota, so rotation only helps with keys from different projects.

## Legacy `.claude` env files

Older AgentKit installs kept keys in `.claude` folders. Set
`MULTIX_LEGACY_CLAUDE_ENV=1` (in the shell or `~/.multix/.env`; a project `.env`
cannot set it) to also read them. This is off by default. The files load
after `~/.multix/.env`, never override earlier non-blank values, and the first
file that sets a variable wins:

1. `.claude/skills/ai-multimodal/.env`, then `.claude/skills/ak-ai-multimodal/.env`
2. `.claude/skills/.env`
3. `.claude/.env`

Project folders are read first, then the same files under your home directory.
Only credential names are taken from these files: names ending in `_API_KEY`
(optionally numbered, such as `GEMINI_API_KEY_2`), `_API_TOKEN`, `_ACCOUNT_ID`
or `_GATEWAY_ID`, plus `FAL_KEY` and `ARK_API_KEY`. Endpoint, proxy and runtime
settings such as `*_BASE_URL` are ignored. Files under the current directory
are also limited to the names `multix` reads (see
[What a project `.env` may set](#what-a-project-env-may-set)); other names in
them are skipped without a warning. Account and gateway IDs from the
`.claude` files of the current directory follow the same trust rules as a
project `.env` (see [Base URL overrides and trust](#base-url-overrides-and-trust)).
The flag itself is ignored inside these files.
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
`REPLICATE_API_TOKEN`. Runway accepts `RUNWAY_BASE_URL` (API root for mocks or
proxies), `RUNWAY_VIDEO_MODEL` (default `gen4.5`), and `RUNWAY_IMAGE_MODEL`
(default `gen4_image`). `MULTIX_MAX_DOWNLOAD_MB` sets the size limit for each
downloaded Replicate, Runway, or Atlas Cloud output file (default 2048); see
[Replicate](/commands/replicate/#outputs), [Runway](/commands/runway/#outputs),
and [Atlas Cloud](/commands/atlascloud/#output) for the download policy.

`MULTIX_UPLOAD_MIN_KBPS` sets the slowest upload speed, in kilobytes (1,000
bytes) per second, that a Gemini Files API upload is given time for (default
`1000`, so 1 MB/s plus one minute; at least `1`). Lower it on a slow link so
large uploads do not time out; see [Gemini](/commands/gemini/).

Atlas Cloud accepts `ATLASCLOUD_BASE_URL` (media API base, default
`https://api.atlascloud.ai/api/v1`; it must use `https://`, and plain `http://`
is accepted only for `localhost`, `127.0.0.1` or `[::1]`) and one default-model
override per command:
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

A `*_BASE_URL` override decides where your API key is sent. So do
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID`, which choose whose
Cloudflare account and AI Gateway receive your tokens. Values from the shell
environment or `~/.multix/.env` are always used. A value from the project
`.env` (the current directory, or a legacy `.claude` file under it) is used
only when it cannot send someone else's key:

- It is used when every key the provider sends with that request comes from
  the same project file, because then the only key that travels is the
  repository's own. For example, `FAL_BASE_URL` and `FAL_KEY` both in the
  project `.env`, or `CLOUDFLARE_API_TOKEN` with the account and gateway IDs.
  Cloudflare video also sends `REPLICATE_API_TOKEN`, so that token must come
  from the same file too. This protects your key, not your data: a project
  `.env` that ships its own key and base URL routes that project's requests,
  including your prompts and any files you upload, to that host, and its key
  replaces yours from `~/.multix/.env`. Review a cloned repository's `.env`
  before running `multix` in it.
- It is ignored when a key comes from somewhere else: the shell,
  `~/.multix/.env`, a legacy file under your home directory, or a different
  project file. If `~/.multix/.env` sets the same variable, that value is used
  and `multix` prints a warning naming the variable, the file and where the key
  comes from (never the value). Otherwise the command stops with an error
  before any request is sent. It does not fall back to the vendor default, so a
  request you meant for a mock server never reaches the paid API.
- An empty project value never hides the `~/.multix/.env` value.
- `multix check` lists each of these settings that is set, and whether it is in
  effect or ignored (for example
  `FAL_BASE_URL ignored: set in project .env while FAL_KEY comes from the shell`).
  It uses the same checks as the commands, so it also flags a base URL that
  breaks the `https://` rule and a Cloudflare ID that works for image and
  speech but not for video.
- To use a project value (for example a local mock server), opt in for a single
  command from your shell:
  `MULTIX_ALLOW_PROJECT_BASE_URL=1 multix ...`. Avoid putting the opt-in in
  `~/.multix/.env`: that turns the protection off for every directory you run
  `multix` in. The opt-in is ignored when it is set in the project `.env`
  itself.
- A non-default base URL must use `https://`; plain `http://` is accepted only
  for `localhost`, `127.0.0.1`, or `[::1]`.
- Whenever a non-default base URL is in effect, `multix` prints one warning per
  variable naming the provider and only the hostname, never the key or the full
  URL. Warnings go to stderr, so stdout stays machine-readable.

A project `.env` cannot set proxy, TLS or Node variables at all (see
[What a project `.env` may set](#what-a-project-env-may-set)), but it can still
choose models and, with its own key, endpoints. Do not run `multix` inside a
repository whose `.env` you have not read.

Cloudflare accepts only the built-in Workers AI image and speech model IDs;
`CLOUDFLARE_AI_IMAGE_MODEL` and `CLOUDFLARE_AI_TTS_MODEL` are therefore useful
only to make that supported choice explicit. Set
`CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD=true` only when request-payload
collection is intended.

Run `multix check --verbose` after changing a credential or endpoint to see
which providers are usable.
