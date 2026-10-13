# Research: Cloudflare Containers job runner + user-supplied R2 uploads

Date: 2026-10-13. Scope: the `worker/` remote MCP server (workers-oauth-provider, KV, no DOs today) gains a job runner that executes the multix Node CLI in Cloudflare Containers and uploads outputs to the caller's own R2 bucket.

## Recommendation

1. **Use the default scheduling policy with the `Container` class. Give each job its own instance (`env.JOBS.getByName(jobId)`), and run a small HTTP job server inside the image.** The Worker returns a `jobId` at once. The Durable Object (DO) starts the job, polls the container through `schedule()`, keeps the final status and URLs in DO storage, and then calls `destroy()`. User secrets travel in the POST body, never in the image, `vars` or instance env. This uses only GA, documented APIs. Each job gets its own Firecracker microVM, so users are isolated.
2. **Alternative: `ctx.container.exec()` (argv, per-process env, `cwd`, `uid:gid`).** It removes the job server. It is documented only next to the `durable_object` policy, which is beta, and that policy cannot be changed once an application exists. Consider it after checking that it works under `default`.
3. **Rejected: a shared pool via `getRandom()`.** Different users' jobs and secrets would land in the same VM, and the docs say autoscaling is not available yet.

Use **aws4fetch** for R2 in both the Worker (credential check, presigning) and the container (PUT upload). One small client that works in either runtime follows the AGENTS.md rule that clients stay free of `node:*` imports. Switch to `@aws-sdk/client-s3` only if objects can exceed 5 GiB, which would need multipart upload.

## 1. Cloudflare Containers

| Item | Finding | Source |
|---|---|---|
| Status | Containers and Sandboxes have been GA since 2026-04-13. The `durable_object` scheduling policy is still marked beta. | [GA changelog](https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/), [scheduling policy](https://developers.cloudflare.com/containers/configuration/scheduling-policy/) |
| Plan | Workers Paid plan ($5 per month). Not available on Free. | [pricing](https://developers.cloudflare.com/containers/pricing/) |
| Included per month | 25 GiB-hours of memory, 375 vCPU-minutes, 200 GB-hours of disk, and 1 TB egress (NA/EU) | same |
| Rates beyond that | Memory $0.0000025/GiB-s and disk $0.00000007/GB-s, both billed on the **provisioned** size. CPU $0.000020/vCPU-s, billed on **active use** only. Egress $0.025/GB (NA/EU). | same |
| Cold start | Often 1–3 s, depending on image size and entrypoint work. After the first deploy, allow several minutes of provisioning. | [architecture](https://developers.cloudflare.com/containers/concepts/architecture/), [get started](https://developers.cloudflare.com/containers/get-started/) |
| Disk | Ephemeral. Every start gets a fresh disk from the image. | [FAQ](https://developers.cloudflare.com/containers/faq/) |
| Shutdown | The platform sends SIGTERM, waits up to 15 minutes, then sends SIGKILL. | [architecture](https://developers.cloudflare.com/containers/concepts/architecture/) |
| Arch | `linux/amd64`, running in a Firecracker microVM with its own kernel | [platform details](https://developers.cloudflare.com/containers/platform-details/) |
| Ingress | HTTP only, and only through the DO. End users cannot open raw TCP or UDP to a container. | same |
| Account limits | 6 TiB memory, 1,500 vCPU and 30 TB disk running at once. 50 GB of total image storage. Image size is capped at the instance disk size. | [limits](https://developers.cloudflare.com/containers/platform-details/limits/) |

**Instance types** (`instance_type`; custom sizes go up to 4 vCPU / 12 GiB / 20 GB, with at least 3 GiB per vCPU):

| type | vCPU | memory | disk |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |
| standard-2 | 1 | 6 GiB | 12 GB |
| standard-3 | 2 | 8 GiB | 16 GB |
| standard-4 | 4 | 12 GiB | 20 GB |

The multix CLI spends most of its time waiting on provider HTTP calls, so start with `basic`. Example cost: a 2-minute job on `basic` uses 120 GiB-s of memory, so the free 90,000 GiB-s covers about 750 such jobs a month before CPU charges matter. Move up to `standard-1` only if large media files are buffered in memory.

**Versions:** `@cloudflare/containers` **0.3.7** is the latest (published 2026-06-04, so it passes the 14-day rule). It still has 0.x semver, so pin it exactly. Its dist imports only `cloudflare:workers` and no `node:*`, so it passes `worker/scripts/check-bundle.mjs`. Wrangler is at **4.150.0** (released 2026-10-13, too new under the 14-day rule). The repo's pinned **4.149.0** schema already supports `containers`, `instance_type` (named or `{vcpu, memory_mib, disk_mb}`), `scheduling_policy` and declarative `exports`; I checked this in the packed `config-schema.json`.

**Docker at deploy:** `wrangler deploy` uploads the Worker, then **builds and pushes the image with your local Docker**, so Docker must be running (`docker info`). CI also needs Docker, which GitHub's ubuntu runners have. To skip the local build, `image` can point at a prebuilt registry image; GA added Docker Hub support. Worker code goes live before the container rollout finishes. ([get started](https://developers.cloudflare.com/containers/get-started/), [platform details](https://developers.cloudflare.com/containers/platform-details/))

### wrangler.jsonc additions

The docs now show `exports` instead of `migrations`, and the two cannot be combined. The worker has no DOs yet, so use `exports`.

```jsonc
"containers": [
  {
    "class_name": "JobContainer",
    "image": "../container/Dockerfile",   // or a registry image ref
    "instance_type": "basic",
    "max_instances": 20                   // also caps total concurrent jobs
  }
],
"durable_objects": {
  "bindings": [{ "name": "JOBS", "class_name": "JobContainer" }]
},
"exports": {
  "JobContainer": { "type": "durable-object", "storage": "sqlite" }
}
```

The legacy equivalent is `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["JobContainer"] }]`.

### `@cloudflare/containers` API (0.3.7)

Sources: [Container class](https://developers.cloudflare.com/containers/api/container-class/) and the [repo README](https://github.com/cloudflare/containers).

- Class fields: `defaultPort`, `requiredPorts`, `sleepAfter` (default `"10m"`, reset by every `fetch`/`containerFetch`), `envVars` (applied on every start), `entrypoint`, `enableInternet` (default `true`), `pingEndpoint` (default `"ping"`), `allowedHosts`, `deniedHosts`, `interceptHttps`, and static `outbound` / `outboundByHost`.
- `startAndWaitForPorts({ ports, startOptions: { envVars, entrypoint, enableInternet, labels }, cancellationOptions: { portReadyTimeoutMS = 20000, instanceGetTimeoutMS = 8000 } })`.
- `start(startOptions, waitOptions)` starts without waiting for every port, which suits portless jobs.
- `fetch(req)` proxies to `defaultPort`, starts the container if needed, and is the only method that handles WebSockets. `containerFetch(url, init?, port?)` is plain HTTP; use it inside an overridden `fetch` or an RPC method.
- `stop()` sends SIGTERM. `destroy()` sends SIGKILL. `getState()` returns `running | healthy | stopping | stopped | stopped_with_code`, plus `exitCode`.
- Hooks: `onStart`, `onStop({ exitCode, reason })`, `onError`, `onActivityExpired` (the default calls `stop()`). Use `renewActivityTimeout()` to keep the container alive during background work.
- `schedule(secondsOrDate, "methodName", payload)` replaces `alarm()`. **Do not override `alarm()`.**
- Helpers: `getContainer(binding, name = "cf-singleton-container")`, `await getRandom(binding, n = 3)` and `switchPort(req, port)`. You can also use `env.JOBS.getByName(name)` directly.

### Request duration, concurrency and long jobs

- **Duration:** No Containers page documents a cap on Worker→container request time. DO requests have "no hard limit while the caller stays connected". DO CPU time is 30 s by default and can be raised to 5 min, but time spent waiting on I/O does not count. Alarm handlers are limited to **15 minutes of wall time**. If the client disconnects, the request work is cancelled. ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/))
- **Practical limit:** MCP clients usually time out tool calls after about 60 s. Never block a tool call on a multi-minute job. Return a `jobId` and add a `job_status` tool.
- **Concurrency:** Each container instance has exactly one DO, addressed by name. The DO runs single-threaded but proxies concurrent requests while it awaits I/O. The process inside the container handles its own concurrency. Fan-out happens by addressing more names, because there is no autoscaling yet. `max_instances` caps the application.
- **Long jobs:** Requests reset `sleepAfter`. If nobody polls, the container stops when `sleepAfter` expires, even in the middle of a job. Either set `sleepAfter` longer than the maximum job duration, or self-poll with `schedule()`, because each `containerFetch` renews activity.

### Per-request secrets

Secrets in `envVars` / `startOptions.envVars` are read **once, at container start**. A running process keeps that environment, and later updates do not reach it ([env vars and secrets example](https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/)). They are therefore per instance, not per request. `build_vars` are not runtime env vars and must never hold secrets.

With one instance per job, per-start `envVars` would be safe. Sending secrets in the job POST body is still the more robust choice: the server hands only the keys the job needs to the child process, and nothing leaks if instances are ever reused. Do not keep secrets in DO storage. Store only status, result URLs and an owner `accountId`.

### Egress

Internet access is **on by default**. Setting `enableInternet = false` blocks it and opens only ports 80 and 443. `allowedHosts` turns egress into a deny-by-default allowlist that accepts `*` globs. `deniedHosts` accepts hosts and CIDRs. Both filters apply to HTTPS **only when `interceptHttps = true`**. In that mode the container must trust the ephemeral CA at `/etc/cloudflare/certs/cloudflare-containers-ca.crt`; for Node, set `NODE_EXTRA_CA_CERTS` to that path in the entrypoint. The Worker entrypoint must also export `ContainerProxy`. ([outbound traffic](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/index.md))

### Sketch (Worker / DO side)

```ts
// worker/src/jobs/job-container.ts
import { Container } from "@cloudflare/containers";

type JobRecord = { owner: string; status: "running" | "done" | "failed"; result?: unknown; error?: string };

export class JobContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "20m"; // longer than the max job; destroy() ends it early

  async startJob(owner: string, spec: JobSpec /* argv + provider keys + r2 creds */) {
    await this.startAndWaitForPorts();
    const res = await this.containerFetch("http://container/jobs", {
      method: "POST",
      body: JSON.stringify(spec),
      headers: { "content-type": "application/json" },
    });
    if (res.status !== 202) throw new Error(`job rejected: ${res.status}`);
    await this.ctx.storage.put<JobRecord>("job", { owner, status: "running" });
    await this.schedule(10, "poll");
  }

  async poll() {
    const res = await this.containerFetch("http://container/jobs/current"); // also renews activity
    const body = (await res.json()) as { state: "running" | "done" | "failed"; result?: unknown; error?: string };
    if (body.state === "running") return void (await this.schedule(10, "poll"));
    const job = (await this.ctx.storage.get<JobRecord>("job"))!;
    await this.ctx.storage.put("job", { ...job, status: body.state, result: body.result, error: body.error });
    await this.destroy();
  }

  async status(owner: string) {
    const job = await this.ctx.storage.get<JobRecord>("job");
    return job && job.owner === owner ? job : null; // never reveal other accounts' jobs
  }
}

// worker/src/index.ts: keep `export default new OAuthProvider(...)` and add
export { JobContainer } from "./jobs/job-container";
// MCP tool: const jobId = crypto.randomUUID(); await env.JOBS.getByName(jobId).startJob(accountId, spec);
```

Handle crashes in `onStop({ exitCode })` as well: if the record is still `running`, mark it `failed`, so a status poll never hangs on a dead job.

## 2. R2 over the S3 API

- Endpoint: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` (path style `/<bucket>/<key>`). Region `auto` and service `s3` are required by SDKs but ignored by R2. ([aws4fetch example](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/), [presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/))
- Presigned URLs allow GET, HEAD, PUT and DELETE, with an expiry from **1 s to 604,800 s (7 days)**. They work **only on the S3 API domain, not on custom domains**.
- Public URLs: use a custom domain, which must be a zone in the bucket owner's account, or `r2.dev`, which is rate-limited and meant for development only. The object URL is `<publicBaseUrl>/<key>`. ([public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/))
- Limits: a single PUT can be up to 5 GiB (4.995 GiB), multipart allows up to 10,000 parts, and keys can be up to 1,024 bytes. ([limits](https://developers.cloudflare.com/r2/platform/limits/))
- Token types: Object Read & Write tokens can be scoped to specific buckets and **cannot ListBuckets**. Access Key ID = token id. Secret = SHA-256 of the token value. ([tokens](https://developers.cloudflare.com/r2/api/tokens/))

```ts
// runtime-neutral client: src/providers/r2/r2-client.ts (no node:*); works in the Worker and in Node 20+
import { AwsClient } from "aws4fetch";

export function r2(c: { accountId: string; accessKeyId: string; secretAccessKey: string }) {
  const endpoint = `https://${c.accountId}.r2.cloudflarestorage.com`;
  const aws = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, service: "s3", region: "auto" });
  const objUrl = (bucket: string, key: string) =>
    `${endpoint}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    // cheap check: works with bucket-scoped Object tokens (ListBuckets does not)
    check: (bucket: string) => aws.fetch(`${endpoint}/${bucket}?list-type=2&max-keys=1`),
    put: (bucket: string, key: string, body: BodyInit, type: string) =>
      aws.fetch(objUrl(bucket, key), { method: "PUT", body, headers: { "content-type": type } }),
    del: (bucket: string, key: string) => aws.fetch(objUrl(bucket, key), { method: "DELETE" }),
    presignGet: async (bucket: string, key: string, seconds = 604_800) => {
      const u = new URL(objUrl(bucket, key));
      u.searchParams.set("X-Amz-Expires", String(Math.min(seconds, 604_800)));
      return (await aws.sign(new Request(u), { aws: { signQuery: true } })).url;
    },
  };
}
```

**Validating credentials in the dashboard:**

- Read check: `ListObjectsV2 max-keys=1`. A 200 means the read works, 403 means wrong keys or a token not scoped to this bucket, and 404 `NoSuchBucket` means the bucket does not exist. ListObjectsV2 with `max-keys` is the safer probe because the docs grant "list objects" to every token type. `HEAD /<bucket>` (HeadBucket) is implemented, but the docs do not say which token types may call it.
- Write check: a read-only token passes the list probe, so to confirm write access, PUT and then DELETE a 0-byte `.multix-write-check` object.
- Input validation before any fetch, which also prevents host or path injection: `accountId` must match `^[0-9a-f]{32}$`, `bucket` must match `^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`, and `publicBaseUrl` must be `https:` with no query string. Store the secret with the existing AES-GCM `ACCOUNTS_KV` scheme.

Inside the container, upload with the same client using `put(bucket, key, await readFile(path), mime)`, which needs Node ≥ 20 for global `fetch` and WebCrypto. Use `@aws-sdk/client-s3` with `@aws-sdk/lib-storage` `Upload` only if outputs can exceed 5 GiB.

## 3. Security

**Run the CLI with argv only, never through a shell.**

```js
// inside the container job server (Node)
const dir = await mkdtemp(join(tmpdir(), "job-"));
try {
  const { stdout } = await execFileP(process.execPath, ["/app/dist/cli.js", ...argv, "--output", dir], {
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, ...providerKeys }, // only what this job needs
    timeout: 15 * 60_000,
    maxBuffer: 8 << 20,
    shell: false,
  });
  // upload files found in dir, then build public or presigned URLs
} finally {
  await rm(dir, { recursive: true, force: true });
}
```

- Build `argv` on the server from validated MCP tool input: an allowlist of subcommands and flags, with enum and length checks. Never pass a raw string from the client. Put `--` before free-text positionals such as prompts so they cannot be read as flags. The server forces `--output`, so users cannot choose filesystem paths.
- **Isolation:** one instance per job means one microVM per job. Never share an instance between accounts. Call `destroy()` after the job finishes, so neither disk nor memory outlives it. Check the job owner on every status read.
- **Temp files:** use one `mkdtemp` directory per job, removed in `finally`. Disk is ephemeral anyway and the VM is destroyed.
- **Image:** run as a non-root `USER`, pin the base image digest, and keep no secrets in the image or in `build_vars`.
- **Egress:** the default (internet on) is acceptable at first. To harden, set `enableInternet = false` with `allowedHosts` covering the provider APIs and `*.r2.cloudflarestorage.com`. This requires `interceptHttps` plus CA trust, adds complexity, and should be tested first.
- **Logs:** never log the job body, keys or presigned URLs, because those URLs work as bearer tokens for up to 7 days (AGENTS.md also forbids this). Container logs go to Workers Logs for 7 days when observability is enabled.
- The job server is reachable only through its DO, since there is no public ingress, so it needs no separate authentication.

## Trade-offs

| Option | Complexity | Isolation | Maturity | Long-job fit | Rank |
|---|---|---|---|---|---|
| Per-job instance with HTTP job server (default policy) | Medium (about 60 lines of job server) | Strong (VM per job) | GA | Good: `schedule` self-poll | **1** |
| Per-job instance with `ctx.container.exec()` | Low | Strong | `durable_object` policy is beta; exec under `default` not confirmed | Good; per-process `env`/`cwd`/`user`, no built-in timeout | 2 |
| Shared pool via `getRandom` | Low | Weak (cross-tenant) | GA | Same | Rejected |

**Adoption risk:** the platform is GA, but `@cloudflare/containers` is still 0.x with frequent releases (14 between Oct 2025 and Jun 2026), so pin it exactly. The `exports` config is new and has only release notes beyond the get-started example. Scheduling policy cannot be changed later; switching means creating a new application.

## Limitations

- I found no documented cap on how long a single Worker→container HTTP request may run, so the design avoids relying on long requests.
- `allowedHosts` filtering without `interceptHttps` (for example SNI-based) is not documented, and HTTPS interception was not tested.
- Pricing: no real job timings were measured. The figures are list-price arithmetic.

## Unresolved questions

1. The [DO Container API page](https://developers.cloudflare.com/containers/api/durable-object-container/) says `ctx.container.start()` "takes no options" under the `default` policy, yet the `Container` class (0.3.7 typings) and the get-started page pass `envVars` and `entrypoint`. Confirm with a deploy test. The recommended design does not depend on it, because secrets go in the POST body.
2. Is `exec()` available under the `default` policy? This decides whether option 2 is viable.
3. Should R2 jurisdiction endpoints (`<id>.eu.r2.cloudflarestorage.com`, FedRAMP) be an optional dashboard field?
4. What is the maximum job duration and output size? These set `sleepAfter`, the instance type, and whether multipart upload is needed.
5. Can bucket-scoped Object tokens call HeadBucket? Only matters if HeadBucket is preferred over ListObjectsV2.

Status: DONE
Summary: Use GA Containers (default policy) with one instance per job, keyed by `jobId`, and an internal HTTP job server. Return the job id immediately, self-poll with `schedule()`, and send secrets in the job request body. Use aws4fetch for R2 in both runtimes: check credentials with ListObjectsV2 max-keys=1 plus a write probe, and presign GET URLs for at most 7 days.
