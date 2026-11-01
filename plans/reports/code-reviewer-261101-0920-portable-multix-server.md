# Code review: portable self-hosted Multix server (issue #549)

Reviewer: isolated code-reviewer (did not write the code). Scope: `git diff be1719a..HEAD`
(commits 65c73bd, af478ca), worker/server/**, worker/scripts/{build-server.mjs,smoke-server.ts},
local sign-in in worker/src/**, .github/workflows/{publish-server-image.yml,release-please.yml}.

Checks run:
- `npx vitest run` in worker/ passes: 36 files, 648 tests. `tsc --noEmit` passes for both the Worker and `tsconfig.server.json`. `biome check` on the touched trees is clean.
- I ran throwaway probes from the scratchpad (nothing added to the repo) against the real `createHttpServer` + `createStandaloneApp` and `DurableObjectHost`. Their results are quoted below.
- `docker build` of worker/server/Dockerfile could not finish in this sandbox: the first `npm ci` failed on the network/CA. That is an environment problem, not a code problem, so the image itself was not verified. No image was left behind.

## Critical

None found.

## High

### H1. The DO host does not emulate input gates, so read-modify-write in Durable Objects loses updates
`worker/server/durable-object-host.ts:325-336` (RPC path) and `:377-379` (alarm path). The only
serialization is `gate.idle()`, which waits for `blockConcurrencyWhile`. Plain method calls and the
alarm run interleaved on the same instance at every `await this.ctx.storage.*`.

On Cloudflare, input gates stop other events from being delivered while a storage operation is
pending. That makes `get` → compute → `put` atomic as long as there is no `fetch` in between.
Here the storage ops resolve right away, so concurrent calls interleave at microtask boundaries.

Proof: a toy DO with `incr(){ v = await storage.get("n") ?? 0; await storage.put("n", v+1) }`.
Ten concurrent `stub.incr()` calls returned `1,1,1,1,1,1,1,1,1,1` and the final `n = 1`
(Cloudflare gives 10).

Affected Worker code that assumes the Cloudflare semantics (AccountSkills already uses
`blockConcurrencyWhile` and is fine):
- `EventHub.subscribe` (src/events/event-hub.ts:~340-354): check `active.length >= MAX_ACTIVE_SUBSCRIPTIONS`, then put. Concurrent subscribes can go over the cap.
- `EventHub.publish` (:512-551): the `seen:<id>` dedupe and the `queued` cap can both be raced, which gives duplicate webhook deliveries or a queue over the cap.
- `unsubscribe` / delivery bookkeeping running against a concurrent alarm.

Today's exposure is limited because MULTIX_JOBS is not bound, so jobs do not publish. It grows as soon as #550 lands, and the host is meant to be a general stand-in for every future DO.

Fix: run every RPC call and every alarm handler exclusively per instance. Route each call through
`inst.gate.run(...)` instead of `await inst.gate.idle()`, and run the alarm the same way. Make
`blockConcurrencyWhile`, when called from inside a call that already holds the gate, run `fn`
directly (a re-entrancy flag) so it does not deadlock. This is stricter than Cloudflare, which
reopens the gate during `fetch`, but it is never less safe. Add a regression test like the counter
probe above.

## Medium

### M1. A protocol-relative request target overrides the public origin
`worker/server/node-http-bridge.ts:59-60`:
```ts
const path = req.url?.startsWith("/") ? req.url : "/";
const url = new URL(path, origin);
```
`req.url = "//evil.example/..."` (and `"/\evil.example/..."`) starts with `/`, but WHATWG URL
parses it as a network-path reference, so `request.url` becomes `<scheme>://evil.example/...`.
This breaks the module's stated invariant ("never on the Host or X-Forwarded-* headers, so OAuth
metadata … cannot be steered by a client").

Proof against the real server: `GET //evil.example/.well-known/oauth-authorization-server`
returned 200 with `"issuer":"http://evil.example","authorization_endpoint":"http://evil.example/oauth/authorize","token_endpoint":…,"registration_endpoint":"http://evil.example/oauth/register"`.
workers-oauth-provider builds these from `new URL(request.url).origin` (it has no explicit issuer).

Impact:
- Web-cache poisoning when a caching proxy or CDN in front does not merge slashes (Caddy and Traefik do not by default). An MCP client could then be pointed at an attacker's authorization and token endpoints.
- The OAuth library's audience/resource checks are evaluated against a spoofed origin.

`sameOriginPost` and dashboard URLs use `ctx.origin`, so they are not affected.

Fix: build the URL from the path and query only, for example:
```ts
const parsed = new URL(path, "http://placeholder.invalid");
if (parsed.host !== "placeholder.invalid") { /* 400 */ }
const url = new URL(origin);
url.pathname = parsed.pathname;
url.search = parsed.search;
```
Or reject any `req.url` that starts with `//` or `/\`. Add a test for both forms. Optionally also pass an explicit issuer/origin to the OAuthProvider in `createOAuthProvider` if the library supports it.

### M2. The publish workflow runs untrusted install and test code with write and OIDC permissions
`.github/workflows/publish-server-image.yml:29-33, 76-81`. The single `image` job has
`packages: write`, `id-token: write` and `attestations: write`. In that same job it runs
`npm ci --prefix worker` (lifecycle scripts enabled) and the full test suite before logging in to
GHCR. `ACTIONS_ID_TOKEN_REQUEST_*` is in every step's environment, so a compromised dependency's
install script or test can mint an OIDC token. Checkout also persists the token in .git/config.

Fix: split the work into a `verify` job (permissions `contents: read`, `persist-credentials: false`)
and a `publish` job that `needs: verify` and holds the write and OIDC permissions. The publish job
should run only buildx, the attestation and the summary. Also consider `--ignore-scripts` for the
worker `npm ci`; the Dockerfile already does this.

### M3. A failed registry check lets an existing version be overwritten
`publish-server-image.yml:94-99`. `docker manifest inspect … > /dev/null 2>&1` treats any failure
as "absent": a registry 5xx, a rate limit, or an auth glitch. When that happens the build pushes and
moves an existing `:<version>` tag. GHCR does not enforce tag immutability on the server side.

Fix: tell "not found" apart from other errors and fail closed. For example, capture stderr and
continue only on `manifest unknown` / `not found`. Or use `docker buildx imagetools inspect` and
check the exit code and message explicitly.

## Low

- **L1** `worker/src/accounts/local-auth.ts` (`bootstrapTokenValid`) together with `standalone-bootstrap.ts:28-36`. If an earlier boot generated a token (its hash is stored) and the operator later sets MULTIX_BOOTSTRAP_TOKEN, both tokens stay valid until setup completes. The generated one has been printed to logs. Fix: delete `local-setup-token` in `prepareBootstrap` when the env token is used.
- **L2** `standalone-bootstrap.ts:43-48`. The generated bootstrap token is printed to stdout on every start until setup is done, so it can persist in aggregated logs. The behavior is intended and documented, but it should say clearly that MULTIX_BOOTSTRAP_TOKEN is the right choice for production log pipelines. The exposure is bounded because the token is invalidated once the admin exists.
- **L3** `local-auth.ts:41, 136-139`. PBKDF2-SHA256 uses 100k iterations (OWASP currently recommends 600k). The Workers runtime forces this cap. `verifyPassword` rejects `iterations > PBKDF2_ITERATIONS`, so even the Node server can never raise the work factor without changing the code. Consider an iteration cap per runtime, or accept higher stored iteration counts at verify time.
- **L4** `worker/server/Dockerfile.dockerignore`. It excludes `.env*` but not `worker/.dev.vars` (wrangler local secrets), so a developer's `.dev.vars` is copied into the build stage. The final stage copies only `dist-server/`, so it does not reach a pushed image, but it does sit in local build cache layers. Add `**/.dev.vars`.
- **L5** `Dockerfile:46-47` / `server-config.ts:48`. The default `docker stop` grace period is 10 s and the default MULTIX_SHUTDOWN_TIMEOUT_MS is 20 s. compose sets 30 s, but plain `docker run` and many orchestrators will SIGKILL mid-drain. SQLite WAL makes this safe for data, but in-flight requests are cut. Document `--stop-timeout 30`, or lower the default.
- **L6** `publish-server-image.yml:13-16, 35-37`. A tag pushed with a PAT both triggers `push: tags` and may be dispatched by release-please. The concurrency group serializes the two runs and the second fails at the "already exists" check. That is harmless, but it is a red run.
- **L7** `server-config.ts:46`. With `MULTIX_TRUST_PROXY_HOPS=0` behind a proxy, every client shares one IP, so 30 failed sign-ins a minute lock everyone out of /dashboard/login. With hops > 0 and the port also reachable directly, X-Forwarded-For is forgeable and per-IP limits can be bypassed. Both are configuration-dependent. The compose file binds to 127.0.0.1, which is good. Spell out both failure modes in the docs.

## Verified as fine

- **Cloudflare behavior with MULTIX_LOCAL_AUTH unset:**
  - `resolveAppContext` still requires both GitHub secrets.
  - `GET /dashboard/login` still starts GitHub sign-in.
  - Local `local-*` accounts are refused by `accountAllowed` (dashboard, REST, /mcp).
  - The `/oauth/github/callback` 404 branch cannot be reached when GitHub is configured.
  - The new `/dashboard/login/github` route is only an alias.
  - `isAuthRequest` additions only widen rate limiting.
  - The full worker suite passes.
- **Local sign-in:**
  - New POSTs require an exact-match Origin (`sameOriginPost`).
  - The same error is returned for an unknown user or a bad password, and an unknown user still costs a dummy PBKDF2 derivation.
  - Constant-time compare (`tokensMatch`).
  - Password length is capped before hashing.
  - Usernames are validated by regex.
  - All values rendered into pages are HTML-escaped.
  - `return_to` goes through `safeReturnTo` (only `/dashboard` or `/oauth/authorize?…`).
  - Nothing sensitive is logged (only account ids).
  - The account is re-checked against its credential record on every request, so deleting the credential locks the account out.
- **Setup race on Node:** three concurrent POST /dashboard/setup requests with a valid token returned `303, 404, 404`, and exactly one `local-user:*` row exists. After PBKDF2, the rest of the handler runs on already-resolved SQLite promises, so the re-check closes the race in one process.
- **Bootstrap token:** 256-bit, only its SHA-256 hash is stored, it is deleted when setup completes, and an env token shorter than 32 characters is ignored (fails closed).
- **Header handling:** `cf-connecting-ip` / `true-client-ip` / `cf-*` sent by clients are dropped and rebuilt from the socket or the trusted X-Forwarded-For hop (taken from the right). Host is rewritten. Hop-by-hop headers are stripped both ways. The Worker reads no `x-forwarded-*` headers.
- **Body limits:** an over-limit Content-Length gets 413 before the body is read. An over-limit chunked body (2.5 MB against a 1 MB cap) also gets 413, and in-flight drops back to 0. Both were probed.
- **Public fetch guard:**
  - It filters the address that is actually dialled, through the undici connector `lookup` (all records must be public), so DNS rebinding is covered.
  - IP literals are checked, including bracketed IPv6.
  - The IPv6 classifier covers mapped, NAT64, 6to4, Teredo, ULA, link-local and zone-id forms.
  - The caller's `dispatcher` is overridden.
  - It is installed before the OAuth provider module is evaluated.
  - Redirect hops go through the same dispatcher (undici behavior; not probed live because the sandbox has no public redirector).
- **SQLite KV:**
  - Reads past the TTL are invisible right away.
  - The 60 s TTL minimum and 512-byte keys match Cloudflare KV.
  - `list` is in byte order (BINARY collation on UTF-8) with an opaque cursor, a limit of 1000 and correct `list_complete`.
  - Metadata round-trips.
- **DO storage:** values are stored with v8 serialize; puts are transactional; 128-key limits; past-due alarms are re-armed at boot; timers longer than 24.8 days are re-armed in steps; the fired alarm is cleared before the handler runs.
- **SQLite schema:** refuses to start on a newer schema version; WAL mode; busy_timeout set.
- **Graceful shutdown:** readiness turns 503, then the listener closes, in-flight requests are waited for, then DO and background work, then the DB closes.
- **Images:** no secrets in the image (runtime env only, a non-root `node` user, `read_only` + `cap_drop: ALL` + `no-new-privileges` in compose); the CI tag regex is validated before use; tags are immutable `<version>` + `sha-<12>` with no `latest`; provenance, SBOM and attestation are produced; the reusable workflow is called with job-scoped permissions only after a release is created.
- **Lockfile:** limited to @types/node, esbuild, undici 6.29.1 (matches the Node 22 runtime's undici major) and zod 4.6.7.

## Recommended actions (priority order)
1. H1: make DO calls and alarms exclusive per instance; add a regression test.
2. M1: rebuild the request URL from path and query only; reject `//` and `/\` targets; add a test.
3. M2/M3: split the publish workflow into verify and publish jobs; make the existing-tag check fail closed.
4. L1, L4 and L5 are quick fixes. L2, L3 and L7 are docs or follow-up issues.

## Unresolved questions
- Does the deployment ingress (TOSE) merge duplicate slashes or cache `/.well-known/*`? This decides whether M1 is exploitable or latent.
- Is the stricter "one call at a time per DO" behavior (H1 fix) acceptable for the EventHub alarm, which does webhook `fetch`es and would block RPCs to the same account's events DO while it delivers?

Status: DONE_WITH_CONCERNS
Summary: No critical auth bypass found, and local sign-in and the Cloudflare behavior check out. Probes confirmed one High issue (the in-process DO host loses concurrent read-modify-write updates) and one Medium issue (a `//host` request target overrides the public origin in OAuth metadata), plus CI permission and tag-immutability hardening.

## Resolution (implementer, after review)

| Finding | Outcome |
|---|---|
| H1 lost Durable Object updates | Fixed. Each call and alarm runs as a turn that holds the instance lock; `blockConcurrencyWhile` inside a turn runs directly. Outgoing `fetch` (the guarded global) gives the lock up while the request is out, like an input gate, so slow webhooks do not stall other calls. Regression tests: 10 concurrent `incr()` give 1..10; another call proceeds while a turn awaits a request; parallel requests in one turn re-take the lock without deadlock. |
| M1 `//host` request target moves the origin | Fixed: the path is appended to the configured origin, and a changed origin throws. Raw-target regression test (`//evil.example/…`, `/\evil.example/…`); it fails on the previous code. Also checked against the container. |
| M2 publish job runs install/test with write + OIDC | Fixed: a read-only `verify` job tests the tag; the `image` job (packages/id-token/attestations) only builds, and checks the tag still points at the verified commit. Top-level permissions are `contents: read`; `persist-credentials: false`. |
| M3 registry error treated as "absent" | Fixed: only an explicit "not found"/"manifest unknown" from `docker buildx imagetools inspect` counts as absent; any other error fails the run. |
| L1 generated token valid after setting MULTIX_BOOTSTRAP_TOKEN | Fixed (`clearStoredBootstrapToken` at start); test added; guides updated. |
| L2 token printed each start | Kept by design (it is replaced each start and documented); operators who collect logs set `MULTIX_BOOTSTRAP_TOKEN`. |
| L3 PBKDF2 100k | Kept: the shared code must also run on Workers, which caps PBKDF2 at 100 000 iterations. |
| L4 `.dev.vars` not ignored | Fixed in `Dockerfile.dockerignore`. |
| L5 docker stop grace | Documented `--stop-timeout 30`; compose sets `stop_grace_period: 30s`. |
| L6 double publish on PAT-pushed tag | Kept: the second run fails at the immutability check and publishes nothing. |
| L7 proxy hops misconfiguration | Documented in the guide's configuration table. |

Docker was verified separately: image built, first boot smoke (admin created, OAuth, `multix_catalog`), a new container on the same volume signed in again, `//evil.example` target returns no foreign origin, `docker stop` exits 0, bootstrap token absent from logs.
