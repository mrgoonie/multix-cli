---
title: Self-hosted server (Docker, Kubernetes)
description: Run the multix MCP server, dashboard and REST API as one Node.js container without Cloudflare, with SQLite on a persistent volume, local admin sign-in, optional job execution in the same container, health probes and a Kubernetes deployment contract.
---

`multix-server` runs the same application as the
[Cloudflare Worker](/guides/mcp-server/) (`/mcp`, `/dashboard`, OAuth,
`/api/v1`, `/api/docs`, `/health`) as one Node.js process, with no Cloudflare
account. It does not copy the Worker: `worker/server/` gives the Worker code
Node implementations of its Cloudflare bindings and keeps all state in one
SQLite file. Use it on your own host, in Docker Compose or on Kubernetes.

## What is different from the Cloudflare deployment

- **Jobs run in the server container, and only when enabled.** There are no
  per-job containers. With `MULTIX_LOCAL_JOBS=true` the server runs each
  `multix_run` job as a child process of itself (see
  [Job execution](#job-execution)). Without it, `multix_run`,
  `multix_job_status` and `multix_job_cancel` are not listed, the REST job
  routes answer `503`, and a workflow cannot start a run. `multix_catalog`,
  `multix_model_catalog`, skills, events, accounts, API keys and the dashboard
  work either way.
- **Storage:** OAuth state, accounts, encrypted provider keys, skills and event
  subscriptions are kept in `$MULTIX_DATA_DIR/multix.sqlite` (default
  `/data/multix.sqlite`, WAL mode) instead of KV and Durable Objects.
- **Single replica.** Rate limits are counted in memory and one process owns
  the SQLite file. Run exactly one instance.
- **Sign-in:** username and password sign-in with a single-use bootstrap admin
  (`MULTIX_LOCAL_AUTH=true`), so a GitHub OAuth App is optional. There is no
  public sign-up.
- **Outbound requests** (GitHub sign-in, client metadata documents, provider
  APIs, event webhooks) may only connect to public addresses, checked on the
  address actually dialled, like the Worker's strictly-public `fetch`.

Provider keys are never read from the server's environment: each account saves
its own in the dashboard, as on Cloudflare.

## Image

Each release publishes `ghcr.io/mrgoonie/multix-server` for `linux/amd64` and
`linux/arm64` with two immutable tags, `<version>` (for example the npm
version) and `sha-<12 hex digits of the commit>`. There is no `latest` tag. Pin
a version, or better the digest shown in the
[publish workflow](https://github.com/mrgoonie/multix-cli/blob/main/.github/workflows/publish-server-image.yml)
run summary.

The image runs as the non-root `node` user, listens on port `3000`, declares
`/data` as a volume, and works with a read-only root file system when `/tmp` is
a writable tmpfs. For jobs it also contains the `multix` CLI built from the
same source (same version), `ffmpeg` and ImageMagick 7. No secret is baked in.
To build it yourself from the repository root:

```bash
docker build -f worker/server/Dockerfile -t multix-server:dev .
```

The image is not the job container (`worker/container/Dockerfile`), which must
never be exposed to the Internet.

## Quick start with Docker

Create the secrets once and keep them: replacing `SECRETS_ENCRYPTION_KEY` makes
every saved provider key unreadable, and replacing `SESSION_SECRET` signs
everyone out.

```bash
umask 077
cat > multix.env <<EOF
SESSION_SECRET=$(openssl rand -hex 32)
SECRETS_ENCRYPTION_KEY=$(openssl rand -base64 32)
MULTIX_PUBLIC_URL=http://localhost:3000
MULTIX_LOCAL_AUTH=true
MULTIX_LOCAL_JOBS=true
MULTIX_MCP_UNCAPPED_SPEND=deny
EOF

docker run -d --name multix-server \
  --env-file multix.env \
  -p 127.0.0.1:3000:3000 \
  -v multix-data:/data \
  --read-only --tmpfs /tmp:size=2g \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --stop-timeout 30 \
  ghcr.io/mrgoonie/multix-server:<version>

docker logs multix-server   # prints the bootstrap token on first start
```

Open `http://localhost:3000/dashboard/setup`, enter the bootstrap token, and
create the admin (see [First sign-in](#first-sign-in)). If you mount a host
directory instead of a named volume, it must be writable by the `node` user
(uid 1000).

## Quick start with Docker Compose

[`worker/server/compose.yaml`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/compose.yaml)
builds the image from the checkout and runs it on `http://localhost:3000` with
a named volume, a read-only root file system, a 2 GB `/tmp` tmpfs for job
files, a readiness health check, and job execution on
(`MULTIX_LOCAL_JOBS=true`, one job at a time, `MULTIX_MCP_UNCAPPED_SPEND=deny`;
set them in `.env` to change them):

```bash
cp worker/server/server.env.example worker/server/.env   # fill in the two secrets
docker compose -f worker/server/compose.yaml up --build
```

[`worker/server/server.env.example`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/server.env.example)
lists every setting with how to generate each secret. `worker/server/.env` is
git-ignored; never commit it.

## First sign-in

With `MULTIX_LOCAL_AUTH=true`, the server has no account until you create the
bootstrap admin at `<origin>/dashboard/setup`. The form asks for a bootstrap
token:

- If `MULTIX_BOOTSTRAP_TOKEN` is set (a secret of at least 32 characters), use
  it. Shorter values are ignored.
- Otherwise every start generates a random token, stores only its hash, and
  prints it once to stdout (the container log). A restart replaces it, and
  setting `MULTIX_BOOTSTRAP_TOKEN` later revokes it.

The token works once: after the admin exists, `/dashboard/setup` answers `404`
and the token is void. The username is 3 to 32 lower-case letters, digits,
`.`, `_` or `-`; the password is 12 to 256 characters. Where logs are
collected centrally, set `MULTIX_BOOTSTRAP_TOKEN` from your secret store so the
token never reaches a log.

The admin is the only local account. Other people sign in with GitHub: set
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (callback
`<origin>/oauth/github/callback`) and list them in `MULTIX_ALLOWED_USERS`. With
`MULTIX_LOCAL_AUTH` unset, GitHub is the only sign-in and the local admin can
no longer sign in.

Then connect clients exactly as in
[Connect a client](/guides/mcp-server/#connect-a-client), with your origin's
`/mcp`.

## Job execution

Job execution is off unless `MULTIX_LOCAL_JOBS=true`. When it is on, the
server checks at start that the `multix` CLI is on `PATH` (the image has it)
and refuses to start otherwise. The `server_started` log line reports
`"jobs":"enabled"` or `"jobs":"disabled"`, and `/health/ready` reports `jobs`
the same way.

How a job runs:

- `multix_run`, `multix_job_status`, `multix_job_cancel` and
  `POST /api/v1/jobs`, `GET /api/v1/jobs/{id}`,
  `POST /api/v1/jobs/{id}/cancel` use the same code, input checks, caps and
  spend guard as on Cloudflare. Only the place the CLI runs changes.
- Each job is one `multix` process started with an argument list (never a
  shell) in its own directory under `/tmp`, removed when the job ends. Input
  URLs are downloaded only from public HTTPS addresses, checked on the address
  actually connected to. The whole job has a 30-minute limit.
- The account's provider keys are passed to the process in memory for that job
  only. They are never written to disk; stdout and stderr are returned with
  the key values replaced by `[redacted]`.
- Output files are uploaded to the account's Cloudflare R2 bucket set in
  `/dashboard` (Storage) and returned as links. Without a bucket, the files are
  not kept: the result lists their names and sizes with `url: null`, and
  provider URLs printed by the CLI are returned unchanged.
- Job records (status, result, owner; no keys, no arguments) are kept in
  `$MULTIX_DATA_DIR/jobs` (mode `0700`) for 7 days.

Concurrency:

- `MULTIX_LOCAL_MAX_CONCURRENT_JOBS` (1 to 64, default `1`) is the number of
  CLI processes that may run at once. The server-wide cap
  `MULTIX_MAX_JOBS_TOTAL` is lowered to this value, so a job over the limit is
  refused with `server at capacity` (MCP error, REST `429`) before any
  provider is called. `MULTIX_MAX_JOBS_PER_ACCOUNT` (default `2`) still limits
  each account.
- Size CPU, memory and `/tmp` for that many jobs: a job may download up to
  200 MB per input file, and video jobs run `ffmpeg`.

Restart and shutdown:

- On `SIGTERM` running jobs are stopped and recorded as `failed` with an
  `interrupted` explanation; their slots are freed.
- A job that was running when the process died is recorded the same way at
  the next start. It is never run again, so a billed provider call is not
  repeated: the caller starts a new job to retry.

One replica per volume: the executor holds a lock socket in
`$MULTIX_DATA_DIR/jobs`, which stops a second process on the same host from
using the same directory. It cannot see a process on another node, so never
share the data volume between replicas (use a `ReadWriteOnce` volume and
`replicas: 1`).

Spend: set `MULTIX_MCP_UNCAPPED_SPEND=deny` (the template default) so a run
whose cost the operator caps cannot bound is refused. Without it the code
default is `budget`, which runs such a command only when the caller gives
`max_cost_usd` and the price is known and fits.

## Configuration

Required:

| Variable | Effect |
|---|---|
| `MULTIX_PUBLIC_URL` | The external origin users and MCP clients reach, for example `https://multix.example.com` (`http://` only for `localhost`). Every request URL is rebuilt on it; `Host` and `X-Forwarded-*` headers are ignored, so they cannot steer OAuth metadata or redirects. Without a valid value the app answers `503` and readiness fails. |
| `SESSION_SECRET` | At least 32 characters (`openssl rand -hex 32`). Signs dashboard cookies and form tokens. |
| `SECRETS_ENCRYPTION_KEY` | Base64 of exactly 32 random bytes (`openssl rand -base64 32`). Encrypts saved provider keys. |
| `MULTIX_LOCAL_AUTH` or `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | At least one sign-in method. `MULTIX_LOCAL_AUTH=true` enables local sign-in. |

Sign-in:

| Variable | Effect |
|---|---|
| `MULTIX_BOOTSTRAP_TOKEN` | Optional bootstrap token (32+ characters). Without it a token is generated and printed at each start until the admin exists. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Optional GitHub sign-in. |
| `MULTIX_ALLOWED_USERS` | GitHub logins or verified emails allowed to sign in with GitHub. Empty allows no GitHub account. |

Server:

| Variable | Default | Effect |
|---|---|---|
| `HOST` | `0.0.0.0` | Listen address. |
| `PORT` | `3000` | Listen port. |
| `MULTIX_DATA_DIR` | `/data` | Directory of `multix.sqlite`. Must be persistent. |
| `MULTIX_TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the server that append to `X-Forwarded-For` (0 to 10). `0` uses the socket peer as the client IP for per-IP rate limits; set `1` behind one ingress. |
| `MULTIX_SHUTDOWN_TIMEOUT_MS` | `20000` | Time open requests and background work get to finish after `SIGTERM` (0 to 300000). |
| `MULTIX_MAX_BODY_BYTES` | `16777216` | Largest request body the listener accepts (64 KiB to 64 MiB); larger bodies get `413`. Route limits such as the 64 KiB `/mcp` limit still apply. |
| `MULTIX_MCP_RATE_LIMIT` | `60` | Requests per minute per account on `/mcp` and the REST API. |
| `MULTIX_AUTH_RATE_LIMIT` | `30` | Requests per minute per client IP on sign-in and other auth routes. |

Jobs:

| Variable | Default | Effect |
|---|---|---|
| `MULTIX_LOCAL_JOBS` | off | `true` runs `multix_run` jobs as child processes of the server (needs the `multix` CLI on `PATH`). |
| `MULTIX_LOCAL_MAX_CONCURRENT_JOBS` | `1` | CLI processes that may run at once (1 to 64). Also caps `MULTIX_MAX_JOBS_TOTAL`. |
| `MULTIX_MAX_JOBS_PER_ACCOUNT` | `2` | Jobs one account may run at once. |
| `MULTIX_MCP_UNCAPPED_SPEND` | `budget` | `deny` refuses runs the operator caps cannot bound (recommended, the template default); `budget` needs `max_cost_usd`; `allow` runs them. |

The `MULTIX_MCP_*` tool limits in the [Worker configuration](/guides/mcp-server/#configuration)
are read the same way. An invalid number in the server table stops the process
at start with a message naming the variable. The parser is
[`worker/server/server-config.ts`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/server-config.ts).

## Health, shutdown and smoke test

- `GET /health` (liveness): `{ "ok": true }` while the process serves requests.
- `GET /health/ready` (readiness): `200` when the database is writable and the
  configuration is complete (and, with jobs enabled, the job executor accepts
  jobs), otherwise `503` with `checks` naming the failing part. It also
  answers `503` while the server is draining. `jobs` says `enabled` or
  `disabled`.

On `SIGTERM` or `SIGINT` readiness turns `503`, the listener stops accepting,
open requests and background work get `MULTIX_SHUTDOWN_TIMEOUT_MS` to finish,
running jobs are stopped and recorded as interrupted, then the database is
closed. Give the orchestrator a longer grace period than
that timeout.

`npm run smoke:server` in `worker/` checks a running server end to end as an
MCP client would: readiness, admin setup or sign-in, client registration, PKCE
authorization with consent, then `tools/list` and a `multix_catalog` call (no
provider is contacted). On a fresh server it creates the admin with the given
credentials.

```bash
npm ci --prefix worker
cd worker
MULTIX_SMOKE_URL=http://localhost:3000 \
MULTIX_SMOKE_USERNAME=admin \
MULTIX_SMOKE_PASSWORD='<12+ characters>' \
MULTIX_SMOKE_BOOTSTRAP_TOKEN='<token from the log>' \
npm run smoke:server
```

`MULTIX_SMOKE_URL` must equal the server's `MULTIX_PUBLIC_URL`. The bootstrap
token is needed only while setup is still open.

## Kubernetes (TOSE) contract

What a Kubernetes or TOSE deployment must provide:

| Item | Contract |
|---|---|
| Image | `ghcr.io/mrgoonie/multix-server`, pinned by version tag or digest. |
| Replicas | Exactly `1`, with strategy `Recreate`. A rolling update would run two processes on one SQLite file. |
| Port | Container port `3000` (`PORT`), HTTP. Terminate TLS at the ingress. |
| Volume | A persistent volume (PVC, `ReadWriteOnce`) at `/data`. An `emptyDir` loses every account at the next restart. |
| Writable paths | Only `/data` and `/tmp` (an `emptyDir`, sized for the job files); the root file system can be read-only. |
| User | Non-root `node` (uid 1000); set `fsGroup: 1000` so the volume is writable. |
| Environment | `MULTIX_PUBLIC_URL` (the ingress origin), `MULTIX_LOCAL_AUTH=true` and/or GitHub sign-in, `MULTIX_TRUST_PROXY_HOPS=1` behind one ingress; for jobs `MULTIX_LOCAL_JOBS=true`, `MULTIX_LOCAL_MAX_CONCURRENT_JOBS` and `MULTIX_MCP_UNCAPPED_SPEND=deny`. |
| Secrets | `SESSION_SECRET`, `SECRETS_ENCRYPTION_KEY`, `MULTIX_BOOTSTRAP_TOKEN`, and `GITHUB_CLIENT_SECRET` / `MULTIX_ALLOWED_USERS` if used, injected from the secret store, never written into manifests. |
| Probes | Liveness `GET /health`, readiness `GET /health/ready`. |
| Shutdown | `terminationGracePeriodSeconds` above `MULTIX_SHUTDOWN_TIMEOUT_MS` (for example 30 s for the 20 s default). |
| Resources | With jobs enabled, the CLI processes (and `ffmpeg`) run inside this container: size CPU, memory and `/tmp` for `MULTIX_LOCAL_MAX_CONCURRENT_JOBS` jobs. The values below are a starting point for one job at a time, not a benchmark; adjust them from observed usage. |

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: multix-server
spec:
  replicas: 1
  strategy:
    type: Recreate
  selector:
    matchLabels: { app: multix-server }
  template:
    metadata:
      labels: { app: multix-server }
    spec:
      terminationGracePeriodSeconds: 30
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: multix-server
          image: ghcr.io/mrgoonie/multix-server:<version>
          ports:
            - containerPort: 3000
          env:
            - { name: MULTIX_PUBLIC_URL, value: https://multix.example.com }
            - { name: MULTIX_LOCAL_AUTH, value: "true" }
            - { name: MULTIX_TRUST_PROXY_HOPS, value: "1" }
            - { name: MULTIX_LOCAL_JOBS, value: "true" }
            - { name: MULTIX_LOCAL_MAX_CONCURRENT_JOBS, value: "1" }
            - { name: MULTIX_MCP_UNCAPPED_SPEND, value: deny }
          envFrom:
            - secretRef:
                name: multix-server-secrets   # SESSION_SECRET, SECRETS_ENCRYPTION_KEY, MULTIX_BOOTSTRAP_TOKEN
          livenessProbe:
            httpGet: { path: /health, port: 3000 }
          readinessProbe:
            httpGet: { path: /health/ready, port: 3000 }
          resources:
            requests: { cpu: 500m, memory: 512Mi }
            limits: { memory: 2Gi }
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: multix-data
        - name: tmp
          emptyDir: { sizeLimit: 2Gi }
```

## Backup and restore

Everything except the secrets is in `/data`: `multix.sqlite` plus its
`multix.sqlite-wal` and `multix.sqlite-shm` files while the server runs, and
the job records in `/data/jobs`.

- **Offline:** stop the server (or scale to 0), copy the whole `/data`
  directory, start it again.
- **Online:** use SQLite's backup, which reads a consistent copy including the
  WAL, from a tool that mounts the same volume, for example
  `sqlite3 /data/multix.sqlite ".backup '/backup/multix.sqlite'"`. The image
  does not include the `sqlite3` CLI. Copying only `multix.sqlite` from a
  running server can miss recent writes.

Back up `SECRETS_ENCRYPTION_KEY` with the data: without it the saved provider
keys in a restored database cannot be read. To restore, stop the server,
replace the contents of `/data`, and start it.

## PostgreSQL (design note, not implemented)

The server supports only SQLite. A PostgreSQL adapter is not implemented. It
would not change the Worker code: it would provide the same binding interfaces
the SQLite adapters implement today
([`sqlite-kv-namespace.ts`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/sqlite-kv-namespace.ts)
for the KV namespaces, [`durable-object-host.ts`](https://github.com/mrgoonie/multix-cli/blob/main/worker/server/durable-object-host.ts)
for Durable Object storage and alarms) on PostgreSQL tables equivalent to the
`kv`, `do_storage` and `do_alarm` tables. PostgreSQL alone would not allow
more than one replica: the rate limiters are in memory, and each Durable Object
instance and its alarms run inside one process, so several replicas would also
need shared rate limiting and a single owner per object.
