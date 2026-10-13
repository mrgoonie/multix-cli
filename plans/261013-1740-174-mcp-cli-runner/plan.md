# MCP: every provider key, per-account R2, CLI runner in Containers

Status: shipped (#175, #178) · Issues: #173 (phase 1), #174 (phase 2) · Research: `plans/reports/researcher-261013-1731-cf-containers-r2.md`

## Outcome
- `/dashboard` stores a key for every env name multix-cli reads, plus the account's own R2 credentials.
- MCP clients use a few meta tools (`multix_catalog`, `multix_run`, `multix_job_status`, `multix_job_cancel`) that run the real `multix` CLI in a per-job Cloudflare Container and return R2 URLs + stdout.

## Non-goals
- No server-owned bucket: no R2 configured → file outputs are reported as missing storage (stdout and provider URLs still returned).
- `multix update`, `multix check`, OpenAI `--driver codex|auto` (local login) are not exposed (`openai` runs force `--driver api`).
- Existing Worker tools (`multix_generate_image`, `multix_generate_video`, `multix_prediction_*`, `multix_list_providers`) stay unchanged in this change; removing them is a separate decision.

## Shared contract (phase 1 provides, phase 2 consumes)
- `worker/src/config.ts`: `PROVIDER_SECRET_NAMES` = every key env name in `src/providers/provider-keys.ts` (primary + fallback) plus `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_AI_GATEWAY_ID`; generated from that table (import it; it must stay free of `node:*` — verify the bundle check) or, if it pulls Node code, a test asserting the Worker list equals the table.
- `worker/src/accounts/r2-settings.ts`: `interface R2Settings { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; publicBaseUrl?: string }`; `AccountStore.r2Settings(userId): Promise<R2Settings | null>` (decrypted per request, same AES-GCM as provider keys, own KV entry `r2:<userId>`), `saveR2Settings`, `deleteR2Settings`.
- `AccountStore.providerKeys(userId)` keeps returning `ProviderKeys` (now all names).

## Phase 1 — #173, branch `feat/mcp-dashboard-keys-r2` (PR to main)
Files: `worker/src/config.ts`, `worker/src/accounts/**`, `worker/src/pages/dashboard-page.ts` (split if > 200 lines), `worker/src/routes/dashboard-routes.ts`, new `worker/src/storage/r2-client.ts` (aws4fetch, runtime-neutral), tests, docs (README MCP section, docs-site EN/VI mcp-server guide, skill/SKILL.md).
- Group key inputs by provider (label, env name, where-to-get link from provider-keys.ts).
- R2 form: validate account id (32 hex), bucket name, https public URL; probe ListObjectsV2 max-keys=1 + PUT/DELETE of a 0-byte `.multix-probe` key; error messages never contain the secret. Show "Configured: bucket X" + Remove.
- Dependency: `aws4fetch` (exact pin) in worker.
Validation: `npm run check:mcp`, worker tests for save/remove/validation/CSRF.

## Phase 2 — #174, branch `feat/mcp-cli-runner` (stacked on phase 1)
Files: `worker/container/**` (Dockerfile, job server), `worker/scripts/build-cli-catalog.*` + generated `worker/src/cli-catalog.json`, `worker/src/jobs/**`, `worker/src/mcp-server.ts` (register new tools), `worker/src/index.ts` (export the Container class), `worker/wrangler.jsonc` (`containers`, DO binding, `exports`/migrations), tests, docs.
- Catalog: script builds `new Command()` + `registerCommands()` and dumps groups/commands/args/options (flags, description, required, takes value, variadic, default, negatable). Hand-maintained overlay marks file-input options/positionals, output options, excluded commands. Test fails when the committed JSON is stale.
- `multix_run` input: `{ command: "gemini generate", args?: string[] (positionals), options?: Record<string, string|number|boolean|string[]>, inputs?: Record<optionOrPositional, httpsUrl|httpsUrl[]>, wait_seconds?: 0–50 }`. Validate against catalog; reject unknown options, `@file` values, values for file options outside `inputs`, option values starting with `-` where ambiguous; enforce operator caps on `--duration`, `-n/--num-*`, `--resolution`. Build argv server-side.
- Job: id = random; KV `job:<id>` → `{ userId, command, createdAt }`; ownership checked on status/cancel. Durable Object (Container class, one instance per job via `getByName(id)`) POSTs `{ argv, env, inputs, r2 }` to the job server, persists final result in DO storage, then stops the container.
- Job server (Node, no shell): fresh temp dir; download inputs (https, public host, size cap); `MULTIX_DISABLE_HOME_ENV=1`, `MULTIX_OUTPUT_DIR=<dir>/out`, cwd = dir; `execFile("multix", argv, { env })` with timeout; collect files in `out/`; upload to `<bucket>/multix/<userId-hash>/<jobId>/<name>`; URL = publicBaseUrl/key or 7-day presigned GET; stdout/stderr truncated (16 KB) with key values redacted; rm temp dir.
- Image: node:22-slim + ffmpeg + imagemagick + multix built from this repo (multi-stage), non-root user. `instance_type: basic`, `max_instances` modest, `sleepAfter` ≥ longest wait timeout.
Validation: `npm run check:mcp` (bundle must stay free of Node built-ins/commander), unit tests for catalog validation/argv building/ownership with a stubbed container, local `docker build`, then deploy and a live run (e.g. `gemini generate` / `media` command) with redacted evidence.

## Risks
- Containers require Workers Paid; deploy fails otherwise → report as blocker.
- Long jobs vs `sleepAfter`; result persisted in DO storage before stop.
- Secret exposure: keys only in the job POST body/child env, never logged; stdout redacted.
