# Code review: S3-compatible output storage (commit 750a203, issue #556)

Branch `claude/relaxed-clarke-goseuo`, base `origin/dev`. 29 files, +1499/-242.

## Scope and verification

- Read: `worker/container/{job-network,r2-upload,job-outputs,job-runner,job-server}.mjs`,
  `worker/src/storage/{r2-client,r2-access-check}.ts`, `worker/src/accounts/r2-settings.ts`,
  `worker/src/jobs/job-context.ts`, `worker/src/config.ts`, `worker/src/api/*`,
  `worker/src/routes/{dashboard,r2-settings}-routes.ts`, `worker/src/pages/r2-settings-card.ts`,
  `worker/src/url-guard.ts`, `worker/src/events/callback-guard.ts`,
  `worker/server/public-fetch-guard.ts`, docs (EN `mcp-server.md`), README, `skill/SKILL.md`.
- `npx vitest run test/s3-storage.test.ts test/container-job-runner.test.ts test/rest-api.test.ts test/dashboard-storage-and-keys.test.ts`: 4 files, 115 tests pass.
- `npm run typecheck` (worker, test, server configs): clean. `biome check worker/src worker/container worker/test`: clean.
- Empirical checks of `publicHttpsFetch` against a local TLS server with an injected lookup
  (scratch scripts, nothing in the repo changed): streaming with `content-length`, abort and timeout,
  early server response, unbounded error body. Container `isPublicAddress` probed directly with node.

## Overall assessment

No Critical or High defects found. The R2 path keeps its record shape (`r2:<user>`, only the old
fields written for R2), its request URLs and region `auto`. The container stays compatible with the old
Worker spec (no `endpoint` means R2, no `linkExpirySeconds` means 7 days). Errors use fixed codes, so
user values are not echoed. The dashboard escapes the endpoint host. Nothing logs keys or signed URLs.
`src/` provider clients gain no `node:*` imports.

The weak points are defence-in-depth gaps around the new attacker-chosen endpoint: the Worker's
probe requests follow redirects; the connect-time guard in the container accepts addresses the
save-time guard rejects; and the container reads an error body of any size. There is also a
dashboard/docs mismatch on dotted bucket names, and `publicHttpsFetch` has no success-path tests.

## Critical

None.

## High

None.

## Medium

### M1. Worker probe requests to a custom endpoint follow redirects
`worker/src/storage/r2-client.ts:235` builds `{ method, headers: signed.headers, body }` without
`redirect: "manual"`. Only `r2-access-check.ts:61` checks the endpoint host against public addresses,
over DoH. The signed `list`/`put`/`delete` probes then follow any 3xx the endpoint returns.

Failure scenario: an account saves `https://evil.example` (public A record). The endpoint answers the
list with `307 Location: http://some-other-host/…` (http, or a host that was never DoH-checked), and the
Worker sends the signed request there. The public-address check claimed in the docs ("checks that the
host the server will call resolves only to public addresses") no longer holds for the host actually
called. On Cloudflare the network limits the impact. On the self-hosted server, the undici public-only
connector (`worker/server/public-fetch-guard.ts`) still filters by address. The check can also report
`ok` for a bucket that the container (which does not follow redirects) cannot use. Event callbacks
already use `redirect: "manual"` (`events/event-hub.ts:709`, `callback-verification.ts:84`) for this reason.

Fix: set `init.redirect = "manual"` in `R2Client.send` (S3 APIs never need a followed redirect; a
301 `PermanentRedirect` means the wrong region and should map to `error`). Add a test with a mocked
307.

### M2. The connect-time guard in the container accepts addresses the save-time guard rejects
`worker/container/job-network.mjs:75-91` (`isPublicV6`) and `:32-47` (`isPublicV4`). The Worker's
`isNonPublicIpv6` (`worker/src/events/callback-guard.ts`) allows only 2000::/3 and refuses all of
64:ff9b::/96, Teredo, ORCHID, 3fff::/20 and so on. The container classifies these as public
(verified with node):

- `::ffff:0:a00:1` (SIIT IPv4-translated, i.e. 10.0.0.1): **public** in the container
- `64:ff9b:1:a00:1:0:808:808` (local-use NAT64 64:ff9b:1::/48, RFC 8215): **public**, because the IPv4 address is read from the last 32 bits, which is the /96 layout and not the /48 one
- `64:ff9b::808:808`, `4000::1`, `3fff::1`, `2001:20::1`, `2001::a00:1`: **public**

Failure scenario: DNS rebinding after the save-time DoH check. The commit relies on the container
lookup ("a name re-pointed at a private address after the dashboard checked it is refused here"). On
any container network with a NAT64/SIIT translator, an AAAA record in these ranges reaches internal
IPv4 with the account's signed PUT. This classifier predates the commit, but the commit makes it the
only connect-time guard for a persistent, user-chosen upload host.

Fix: give the container the Worker's classification, or at least deny everything outside 2000::/3,
all of 64:ff9b::/96 and 64:ff9b:1::/48, and 2001::/32. Add parity tests that run the same address
table through both `isPublicAddress` (container) and `isNonPublicIpv6/4` (Worker).

### M3. The container reads an error response body of any size from an attacker-controlled endpoint
`worker/container/r2-upload.mjs:219`: `await response.text()`. With `publicHttpsFetch`, a custom
endpoint can stream a body of any size until the 300 s timeout. Measured: a 200 MB error body raised
RSS by about 673 MB. Today the impact is the account's own one-job container, which gets OOM-killed
and turns the result into a generic failure instead of `R2UploadError`. `container/local-executor.mjs`,
built for self-hosted deployments, runs jobs in the server process, so the same endpoint could take
down a shared server.

Fix: read at most about 64 KiB of the body (enough for `<Code>`) and then cancel the stream. For example,
read with `response.body.getReader()` until the cap is reached, then `reader.cancel()`.

### M4. The dashboard cannot save dotted bucket names, though the docs and server accept them
`worker/src/pages/r2-settings-card.ts:70`: `pattern="[a-z0-9][a-z0-9\\-]{1,61}[a-z0-9]"` blocks dots
in the browser. `validBucket` (`r2-client.ts`) and the docs (`docs-site/.../guides/mcp-server.md` lines
around 350: "bucket names with dots need path-style"), plus the new `r2-invalid-bucket` text, say
dotted names work with path-style on an endpoint. A user with a bucket such as `media.example.com`
gets a browser validation error and cannot save it from the dashboard. Only REST works.

Fix: change the pattern to `[a-z0-9][a-z0-9.\-]{1,61}[a-z0-9]` and leave the R2/virtual-hosted
restriction to the server. Add a dashboard test that posts a dotted bucket with an endpoint.

### M5. `publicHttpsFetch` has no success-path test
`worker/test/container-job-runner.test.ts:412-426` covers only a blocked address and a refused
`http:`. Nothing tests that a streamed body arrives whole with `content-length` and no chunked
encoding, that the status, headers and body map back, that abort or timeout rejects, or that
`createR2Uploader` sends custom endpoints through `publicHttpsFetch` with the right Host and path.
These all worked in a manual check here (stream + content-length gives no `transfer-encoding` and 5/5 bytes; a timeout
gives `AbortError`), but no test pins the behaviour. Add a local `https.createServer` test that injects a
`lookup` returning 127.0.0.1 and sets `rejectUnauthorized` by injection, or run against a plain `http`
server through a test-only seam.

## Low

### L1. `publicHttpsFetch` does not destroy the request body on error or early response
`worker/container/job-network.mjs:187-188` uses `body.pipe(req)` plus `body.on("error")`. When the
request fails (abort, ECONNRESET, or the server answering 403 and closing mid-upload), the source
stream is not cancelled. Measured: after an early 403, the source `ReadableStream` had `cancel`
never called, which leaves the output file's read stream open until GC. In the same test the client
got `ECONNRESET` rather than the 403, so the uploader reports "could not be reached" (status 0) and
loses the S3 error code. Fix: `stream.pipeline(body, req, (err) => { if (err) req.destroy(err); })`,
which destroys both sides. Consider resolving with the response if it already arrived before the
reset.

### L2. String and byte bodies go out chunked
`toNodeBody` (`job-network.mjs:138-143`) never sets `content-length`, so a body without an explicit
length goes out with `Transfer-Encoding: chunked` (verified). AWS S3 rejects a chunked PUT that has no
`content-length` (411/501). Production passes `contentLength` (`job-outputs.mjs:78`), but `put()`'s
contract makes it optional. Fix: set `content-length` for string or `Uint8Array` bodies when the header is
missing, or require `contentLength` for custom endpoints.

### L3. Name-check parity gaps between `r2-upload.mjs` and `r2-client.ts`
- `checkedEndpoint` (`r2-upload.mjs:104-127`) does not strip a trailing dot before the blocklist, so
  `localhost.` or `x.internal.` pass there while `url-guard.ts` refuses them. They cannot come from the
  Worker today, and the lookup guard still applies, but the comment says "Same name rules".
- R2 region: `resolveTarget` uses `target.region ?? "auto"` for R2, while the container hard-codes `auto`.
  `parseR2Settings` never stores a region for R2, so this cannot trigger now. Hard-code `auto` in both.
- `MAX_URL_CHARS` is not checked in the container (no impact).

### L4. Version-skew windows
- Worker rollback after S3 records exist: the old `isR2Settings` requires `accountId`, so
  `readR2Settings` logs `r2_settings_unreadable` and treats the account as having no storage. Jobs run
  without uploads and the dashboard shows nothing configured. The failure is safe, but consider noting
  it in the PR's rollback notes.
- Old container with a new Worker (container rollback or failed rollout): S3 specs fail closed
  ("Invalid R2 account id"). This is correct. `linkExpirySeconds` is ignored, so links last 7 days and
  exceed `MULTIX_OUTPUT_LINK_MAX_SECONDS` during that window.

### L5. The dashboard pre-fills the capped lifetime, so re-saving can lower the account's own setting
`dashboard-routes.ts:119` passes the effective (operator-capped) lifetime, and
`r2-settings-card.ts:72` uses it as the field `value`. Re-saving stores the capped value, so if the
operator later raises `MULTIX_OUTPUT_LINK_MAX_SECONDS`, the account stays at the old lower value. Pre-fill
the stored `settings.linkExpirySeconds` and show the effective value only in the status line.

### L6. Leftover R2-only wording
- `worker/container/r2-upload.mjs:61-62`: `R2UploadError` says "R2 upload failed: R2 could not be
  reached" for S3 endpoints too, and this text reaches job results.
- `worker/src/skills/workflow-manifest.ts:414`: "configure R2 storage in /dashboard".
- The `NO_STORAGE_NOTE` text changed (`job-runner.ts`/`.mjs`). The skill was updated, but any external
  agent that matches on "R2 storage is not configured" will stop matching. Mention this in the PR.

### L7. DoH check versus Worker fetch (accepted risk, document only)
On Cloudflare Workers the save-time probe is not tied to the address that DoH checked (as
`callback-guard.ts` already notes). This is acceptable because the Workers network cannot reach
private ranges and the self-hosted server filters at connect time. No change needed beyond M1.

## Items checked and found correct

- SigV4: region is passed explicitly; path-style URL `https://host/bucket/key`, virtual-hosted
  `https://bucket.host/key`, list on virtual uses `/` as the canonical URI; `encodeKey` is RFC 3986 in both
  copies. Node `https.request` sends `Host: bucket.host`, which matches what aws4fetch signs (verified header).
- Virtual-host safety: in virtual mode, buckets cannot contain dots, so `bucket.host` cannot become an IP
  literal. A host ending in a numeric label is parsed as IPv4 by WHATWG and rejected. The DoH check
  targets the bucket host in virtual mode.
- Endpoint normalisation: origin only; userinfo, port, path, query and fragment are refused (including
  a bare `?`/`#`); `:443` is normalised away; a backslash trick lands in the path and is refused. The
  container also requires `url.origin === raw`.
- `linkExpirySeconds`: parse limits it to 60..604800 and it is stored only when below the maximum; the
  operator cap has a floor of 60 (`boundedInt` rejects values below 1 and non-integers); `job-context.ts`
  sends the effective value; the container clamps it again.
- Production does not pass `options.fetch`, so custom endpoints always use `publicHttpsFetch`
  (`job-server.mjs:67`).
- REST `link_expiry_seconds` accepts number or string; fractions, exponents and other types are
  rejected with a fixed message.
- Docs (EN and VI mcp-server, rest-api), README, OpenAPI and `skill/SKILL.md` match the code, except
  for M4 (dotted buckets in the dashboard) and the redirect caveat in M1.

## Recommended actions (priority order)

1. M1: `redirect: "manual"` in `R2Client.send`, plus a test.
2. M2: align the container IP classification with `callback-guard.ts`, plus parity tests.
3. M3: cap the error body read in `r2-upload.mjs`.
4. M4: allow dots in the dashboard bucket pattern.
5. M5, L1, L2: use `pipeline` in `publicHttpsFetch`, set content-length for fixed bodies, and add success-path tests.
6. Low items as follow-ups (wording, pre-fill, rollback note).

## Metrics

- Type coverage: typecheck clean (3 tsconfigs).
- Tests: 115/115 in the 4 touched suites; full worker suite not run.
- Lint: 0 issues (biome, 155 files).

## Unresolved questions

- Does the Cloudflare Containers network have IPv6 egress or NAT64? This decides whether M2 can be
  exploited today or is defence in depth only.
- Is `local-executor.mjs` planned to be wired into `multix-server`? If so, M3 becomes a shared-process
  issue.

## Resolution (follow-up commit)

- M1 fixed: `R2Client.send` uses `redirect: "manual"`; test "never follows a redirect from the endpoint".
- M2 fixed: the container IPv6 check now uses the same rules as `isNonPublicIpv6` (only 2000::/3, no NAT64, 6to4, Teredo, ORCHID, documentation ranges); a parity test runs both checks on the same addresses.
- M3 fixed: error bodies are read up to 64 KiB in the container uploader and the Worker client; test with a 4 MiB error stream.
- M4 fixed: the dashboard bucket pattern accepts dots; the server keeps the addressing rule.
- M5 fixed: success-path test for `publicHttpsFetch` against a local TLS server (3 MiB streamed PUT with length, Host header, 403 body, abort).
- L1 fixed: request bodies go through `stream.pipeline`.
- L5 fixed: the dashboard pre-fills the account's saved lifetime, not the capped one.
- L6 fixed: upload and probe errors and the workflow "no URL" message no longer say R2.
- L2, L3, L4, L7: accepted. Production always sends a length (L2); neither L3 path can trigger; L4 is the normal one-release compatibility window and the container accepts both spec shapes; L7 is covered by the Workers network and the self-hosted connect-time guard.
