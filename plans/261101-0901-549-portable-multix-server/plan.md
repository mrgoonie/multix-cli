# Portable self-hosted Multix server (issue #549)

Status: in progress · Branch: `claude/relaxed-clarke-wyecmp` → `dev`

## Outcome
`multix-server`: a Node.js container that serves the same Worker code (`/mcp`,
`/dashboard`, OAuth, `/api/v1`, `/api/docs`, `/health`) with no Cloudflare
binding, durable on one SQLite file on a PVC.

## Approach (no fork)
The Worker already depends only on narrow binding interfaces. The standalone
runtime supplies Node implementations of them instead of copying the app:

| Binding | Standalone adapter (`worker/server/`) |
|---|---|
| `OAUTH_KV`, `ACCOUNTS_KV` | SQLite-backed KVNamespace subset (TTL, metadata, prefix list) |
| `MULTIX_SKILLS`, `MULTIX_EVENTS` | In-process Durable Object host: SQLite storage, alarms, `blockConcurrencyWhile` |
| `MCP_RATE_LIMITER`, `AUTH_RATE_LIMITER` | In-memory fixed-window limiter (single replica) |
| `MULTIX_JOBS`, `MULTIX_JOB_QUOTA` | Not bound: `multix_run` is not offered (job execution is #550) |
| `global_fetch_strictly_public` | undici dispatcher refusing non-public addresses at connect time |
| `cloudflare:workers` | Small shim (`DurableObject`, `WorkerEntrypoint`) aliased at bundle time |

Shared-code change: optional local sign-in (`MULTIX_LOCAL_AUTH=true`) with a
single-use bootstrap admin, so GitHub OAuth is optional.

## Acceptance criteria
Those of #549: fresh container initializes securely, dashboard, MCP OAuth,
`multix_catalog`; restart keeps state; no unauthenticated access; Worker tests
pass; tagged image, no floating `latest`.

## Non-goals (MVP)
Job execution / object storage (#550), multi-replica, PostgreSQL adapter
(design note only).
