---
title: REST API and account API keys
description: Use the multix MCP server's REST API from scripts and CI with an account API key to manage provider keys and R2 storage, read the CLI catalog, and run, poll and cancel CLI jobs.
---

The [remote MCP server](/guides/mcp-server/) also serves a JSON REST API at
`/api/v1` for scripts and CI that do not speak MCP. It works on the same
account as the dashboard and `/mcp`: the same provider keys, the same R2
bucket, and the same CLI runner as `multix_run`, with the same input checks,
job caps and output scrubbing.

- Base URL of the hosted instance: `https://multix.zuey.me/api/v1` (invited
  GitHub accounts only). On your own deploy it is `<origin>/api/v1`.
- Interactive reference: [`/api/docs`](https://multix.zuey.me/api/docs),
  rendered from the public OpenAPI 3.1 document at
  [`/api/v1/openapi.json`](https://multix.zuey.me/api/v1/openapi.json). The
  OpenAPI document is the authority for request and response schemas; this
  page explains how to use them.

## Create an API key

1. Sign in at `/dashboard`.
2. In the **API keys** card, enter a name (for example `laptop` or `CI`, 1–64
   printable characters) and choose **Create API key**.
3. Copy the key (`mxk_…`) right away. It is shown **once**; only its SHA-256
   hash is stored, so a lost key cannot be recovered. Revoke it and create
   another.

An account can hold at most **10** keys. The card lists each key's name, its
first characters and when it was created; **Revoke** deletes it. A revoked key
can keep working for up to about a minute in other Cloudflare locations,
because the key store (KV) is eventually consistent.

A key acts as your account: it can read which provider keys are set, change
provider keys and R2 storage, run jobs that spend your provider credits, and
revoke API keys. It cannot create API keys; that is only possible in the
dashboard. Treat it like a password and keep it in a secret store or an
environment variable, not in source code.

## Authenticate

Send the key as a bearer token on every request except `openapi.json`:

```bash
export MULTIX_API_KEY="mxk_your-key-here"   # better: load it from your secret store
curl -s https://multix.zuey.me/api/v1/me \
  -H "Authorization: Bearer $MULTIX_API_KEY"
```

Every request checks the key, then the sign-in allowlist
(`MULTIX_ALLOWED_USERS`, so removing an account from it also blocks its API
keys), then the per-account rate limit. Request bodies are JSON
(`Content-Type: application/json`, at most 64 KiB).

## Endpoints

All paths are relative to `/api/v1`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/openapi.json` | OpenAPI 3.1 document. Public, no key needed. |
| `GET` | `/me` | The calling account (`id`, `login`, `name`) and the id of the API key used. |
| `GET` | `/provider-keys` | Every provider key name with `set` and `updated_at`. Values are never returned. |
| `PATCH` | `/provider-keys` | Set and remove several keys at once: `{ "keys": { "NAME": "value" \| null } }`. The whole body is validated before anything is written. |
| `PUT` | `/provider-keys/{name}` | Set one key: `{ "value": "…" }`. |
| `DELETE` | `/provider-keys/{name}` | Remove one key. |
| `GET` | `/storage` | R2 settings without credentials, or `{ "configured": false }`. |
| `PUT` | `/storage` | Check access to the bucket, then save the R2 settings. |
| `DELETE` | `/storage` | Remove the R2 settings. |
| `GET` | `/catalog[?group=]` | CLI commands the server can run; same payload as `multix_catalog`. |
| `POST` | `/jobs` | Run one CLI command; same input as `multix_run`. |
| `GET` | `/jobs/{id}` | Job status, outputs, stdout and the tail of stderr. |
| `POST` | `/jobs/{id}/cancel` | Stop a running job. |
| `GET` | `/api-keys` | The account's API keys (`id`, `name`, `prefix`, `created_at`), never the keys. |
| `DELETE` | `/api-keys/{id}` | Revoke an API key. A key may revoke itself. |

Provider key names are the env names the CLI reads (for example
`GEMINI_API_KEY`), plus the Cloudflare Workers AI names; `GET /provider-keys`
lists all of them. A value must be 1–1024 printable characters without spaces.

## Provider keys

Set one key, reading the value from your environment so it does not land in
shell history:

```bash
curl -s -X PUT https://multix.zuey.me/api/v1/provider-keys/GEMINI_API_KEY \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"value\": \"$GEMINI_API_KEY\"}"
```

Set and remove several in one request (`null` removes a key). The response
lists names only: `{ "saved": [...], "removed": [...] }`.

```bash
curl -s -X PATCH https://multix.zuey.me/api/v1/provider-keys \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"keys\": {\"GEMINI_API_KEY\": \"$GEMINI_API_KEY\", \"OPENAI_API_KEY\": \"$OPENAI_API_KEY\", \"FAL_KEY\": null}}"
```

An unknown name rejects the whole request with `400`, so nothing is half
saved.

### Sync keys from a local `.env`

This Node.js script (Node 20+, no dependencies) asks the server which names it
accepts, picks those names from a local `.env`, and sends them in one `PATCH`.
It prints only key names, never values. Save it as `sync-multix-keys.mjs`:

```js
// Usage: MULTIX_API_KEY=… node sync-multix-keys.mjs [path/to/.env]
import { readFileSync } from "node:fs";

const base = process.env.MULTIX_API_URL ?? "https://multix.zuey.me/api/v1";
const headers = {
  authorization: `Bearer ${process.env.MULTIX_API_KEY}`,
  "content-type": "application/json",
};

// Names the server accepts.
const listed = await fetch(`${base}/provider-keys`, { headers });
if (!listed.ok) throw new Error(`GET /provider-keys: HTTP ${listed.status}`);
const accepted = new Set((await listed.json()).keys.map((k) => k.name));

// KEY=value lines; comments, blank lines and unknown names are skipped.
const keys = {};
for (const line of readFileSync(process.argv[2] ?? ".env", "utf8").split(/\r?\n/)) {
  const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!m || !accepted.has(m[1])) continue;
  const value = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  if (value) keys[m[1]] = value;
}
if (Object.keys(keys).length === 0) throw new Error("No provider keys found in the .env file");

const res = await fetch(`${base}/provider-keys`, {
  method: "PATCH",
  headers,
  body: JSON.stringify({ keys }),
});
const body = await res.json();
if (!res.ok) throw new Error(`PATCH /provider-keys: ${body.error?.code}: ${body.error?.message}`);
console.log(`saved: ${body.saved.join(", ")}`);
```

Run it with `node sync-multix-keys.mjs ~/.multix/.env` or any other `.env`
path. It never removes a key: names missing from the file are left as they are.

## R2 storage

`PUT /storage` takes the same fields as the dashboard's **R2 storage** card
(see [R2 storage](/guides/mcp-server/#r2-storage)). Before saving, the server
lists the bucket, uploads an empty probe object and deletes it again; if any
step fails, nothing is saved and the response is
`422 storage_check_failed` naming the failed step.

```bash
curl -s -X PUT https://multix.zuey.me/api/v1/storage \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"account_id\": \"$R2_ACCOUNT_ID\", \"access_key_id\": \"$R2_ACCESS_KEY_ID\", \"secret_access_key\": \"$R2_SECRET_ACCESS_KEY\", \"bucket\": \"my-multix-outputs\", \"public_base_url\": \"https://files.example.com\"}"
```

`public_base_url` is optional. The response, like `GET /storage`, never
includes the access keys.

## Run a job and poll it

`POST /jobs` takes the `multix_run` input (`command`, `options`, `args`,
`inputs`, `wait_seconds`; see
[Running CLI commands](/guides/mcp-server/#running-cli-commands)). Use
`GET /catalog?group=gemini` to see a command's options and which take files.

```bash
curl -s -X POST https://multix.zuey.me/api/v1/jobs \
  -H "Authorization: Bearer $MULTIX_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "command": "gemini analyze",
    "options": { "prompt": "Summarise this clip in three bullet points" },
    "inputs": { "files": "https://cdn.example.com/clip.mp4" },
    "wait_seconds": 40
  }'
```

The body has the same shape as a `multix_run` result (`job_id`, `status`,
`outputs`, `stdout`, `stderr_tail`, `exit_code`, and `note` when R2 is not
configured). The HTTP status tells you whether to poll:

- `200`: the job ended (`succeeded`, `failed`, `timed_out` or `canceled`).
- `202`: the job is still `running`; `next.path` is the URL to poll, for
  example `/api/v1/jobs/<job_id>`.

Poll every 10–30 seconds until the status is no longer `202`:

```bash
JOB_ID="<job_id from the response>"
while [ "$(curl -s -o job.json -w '%{http_code}' \
  https://multix.zuey.me/api/v1/jobs/$JOB_ID \
  -H "Authorization: Bearer $MULTIX_API_KEY")" = "202" ]; do
  sleep 15
done
cat job.json   # outputs[].url holds the files in your R2 bucket
```

Stop a running job with `POST /jobs/{id}/cancel`. Only the account that
started a job can read or cancel it; anyone else gets `404`.

## Errors

Errors are JSON with a stable `code` and a message that never contains
submitted values:

```json
{ "error": { "code": "bad_request", "message": "keys is empty" } }
```

| Status | `code` | When |
|---|---|---|
| `400` | `bad_request` | Invalid JSON, field or value, unknown provider key name, or a command, option or input `multix_run` would reject. |
| `401` | `unauthorized` | Missing, malformed, unknown or revoked API key. |
| `403` | `forbidden` | The account is no longer in the sign-in allowlist. |
| `404` | `not_found` | Unknown path, job or API key, or a job of another account. |
| `405` | `method_not_allowed` | Wrong method; the `Allow` header lists the accepted ones. |
| `413` | `payload_too_large` | Body over 64 KiB. |
| `415` | `unsupported_media_type` | Body not sent as `application/json`. |
| `422` | `storage_check_failed` | The R2 access check failed; nothing was saved. |
| `429` | `rate_limited` | Too many requests; retry after the `Retry-After` seconds. |
| `429` | `busy` | Job caps reached: the account's running-job limit or the server's total. Wait for a job to end (or cancel one) instead of retrying at once. |
| `503` | `unavailable` | The server has no job container, so jobs cannot run. |
| `500` | `internal` | Unexpected server error. |

The set of codes is defined in `worker/src/api/api-http.ts`.

## Limits

- **Rate limit:** about 60 requests per minute per account, shared with
  `/mcp` (`MCP_RATE_LIMITER`). Requests with a missing or invalid key are
  limited per client IP (`AUTH_RATE_LIMITER`, about 30 per minute). Both are
  approximate; see [Configuration](/guides/mcp-server/#configuration).
- **Jobs:** the same caps as `multix_run`: `MULTIX_MAX_JOBS_PER_ACCOUNT`
  running jobs per account (default 2), `MULTIX_MAX_JOBS_TOTAL` on the server
  (default 10), `wait_seconds` 0–40 (default 25), one 30-minute limit per job,
  and the server's output, video length and resolution caps.
- **API keys:** at most 10 per account; created only in the dashboard.
- **Bodies:** JSON objects up to 64 KiB.
