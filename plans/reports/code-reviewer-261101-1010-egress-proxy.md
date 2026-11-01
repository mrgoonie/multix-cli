# Code review: job CLI egress proxy (issue #555)

Branch `claude/relaxed-clarke-pw1fvh`, `origin/dev...HEAD` (ed211db, 9c14cc0). Read-only review.

## Scope
- Files: worker/container/egress-proxy.mjs (new, 267 LOC), job-runner.mjs, local-executor.mjs, worker/test/egress-proxy.test.ts (new), local-executor.test.ts, fixtures/fake-multix.mjs, docs-site self-hosted-server.md (EN+VI), AGENTS.md. About 820 added lines.
- Checks run: `npx vitest run test/egress-proxy.test.ts test/local-executor.test.ts` gave 32/32 passed (Node 22.23.4). I also ran scratch experiments (exp1.mjs and exp2.mjs in the session scratchpad) against the real proxy and stopped them afterwards.
- Context: `createLocalExecutor` has no caller in `worker/server` yet (issue #550), so this is not live in production today. Severities assume it gets wired in.

## Verified to hold (bypass attempts that failed)
- Through a real child process with `proxy.env`: `fetch` and `http.get` to `127.0.0.1`, `localhost`, `2130706433` (decimal), `0x7f.1` and `[::ffff:7f00:1]` were all refused. Every `http.get` got a 403 from the proxy, and the internal service received no request. Node 22.23's `http` module also follows `NODE_USE_ENV_PROXY`.
- A CONNECT to a decimal, octal or short-form host goes through `lookup`, because `isIP` is false for those strings. getaddrinfo then returns 127.0.0.1, which is refused. A bracketed authority must pass `isIP == 6`. Zone ids (`%`) are rejected by the authority regex and by the WHATWG URL parser.
- With `autoSelectFamily`, `net.connect` calls `lookup` with `all: true`, and `createPublicLookup` returns only the addresses it checked. NAT64, including 64:ff9b:1::/48, 6to4 and mapped addresses all have their embedded IPv4 checked.
- A failed CONNECT before the tunnel exists returns a complete 502 or 403 response (5 out of 5 runs). The `destroy` call on `close` does not cut the response short.
- No regression from `NODE_OPTIONS`: `runJob` builds the child env from scratch, so the server's `NODE_OPTIONS` was never inherited.
- Executor lifecycle: if the proxy fails to start, the lock is released (a test covers this). `egress.close()` runs after the grace period and before the lock is released. When jobs outlive `closeTimeoutMs`, their tunnels are cut, which is acceptable.
- In this sandbox, an undici fetch error from a refused request does not contain the proxy URL or the token.

## Findings (ranked)

### H1. The check is skipped silently when the CLI's Node does not support `NODE_USE_ENV_PROXY` (verified from the Node docs; latent)
- Where: egress-proxy.mjs:75-89 (`proxyEnvFor`), job-runner.mjs:142-153.
- `NODE_USE_ENV_PROXY` exists only in Node 24.0.0+ and 22.21.0+ (nodejs.org/api/cli.html). On any older Node, `fetch` ignores `HTTP(S)_PROXY` and connects directly, so the address check never runs and SSRF to 169.254.169.254 is back. Affected runtimes: Node 20.x, which the CLI's `engines` still allows, and Node 22.13-22.20, which `worker/server/Dockerfile` itself calls valid (node:sqlite needs ">= 22.13").
- The CLI runs as `multix` found on `PATH` (`options.basePath ?? process.env.PATH`), so it can use a different Node from the server. Nothing checks this. The tests only pass because CI uses the latest 22.x.
- Fix:
  1. At executor start, check that the CLI's runtime really uses the proxy. For example, the proxy counts requests to a sentinel host, and a startup probe runs `node -e "fetch('http://egress-selftest.invalid/')"` with the same `PATH` and `egressEnv`. If the proxy never sees the request, refuse to start.
  2. Alternatively, run `node -p process.versions.node` from that `PATH` and enforce `>=22.21 <23 || >=24`.
  3. State the minimum Node version in the docs.

### M1. Absolute-form forwarding hangs when the upstream response is cut short (verified, exp2.mjs)
- Where: egress-proxy.mjs:220-236.
- `upRes.pipe(res)` does not pass on an upstream abort. An upstream that sends `Content-Length: 100`, then 7 bytes, then resets leaves the client connection open indefinitely: it was still open after 3 s. `upstream.on("error")` does not fire after the response has started, and Node's server timeouts do not apply to a response that is still being written.
- Impact: plain-http downloads (curl, ffmpeg, Node `http`) hang until the job deadline (up to 30 min) and hold the job slot.
- Fix: `pipeline(upRes, res, (err) => { if (err) res.destroy(err); })`. Alternatively, `upRes.once("aborted", () => res.destroy())` plus an `error` handler.

### M2. Tests that run the code but would pass without the proxy (verified)
- local-executor.test.ts:438-448:
  - The fake CLI fetches `http://127.0.0.1:9/`. Port 9 is closed, so the fetch fails with or without the proxy. The comment "Loopback is refused by the proxy (403), not reached directly" is never asserted.
  - `expect(JSON.stringify(view)).not.toContain(proxyUrl.password)` cannot fail, because fake-multix prints env names only.
- egress-proxy.test.ts:318-347: `metadata.attacker.test` gets ENOTFOUND without the proxy (checked), and `internal.hits` stays empty either way.
- The real end-to-end proof is egress-proxy.test.ts:286-316 (`http://127.0.0.1:<live port>` with `hits == []`). The other two tests add coverage numbers without proving anything.
- Fix:
  - Point `--fetch` at a live loopback service and assert that it got no request.
  - Assert that the outcome came from the proxy, either through a proxy-side counter or by checking that a live non-proxied control request succeeds.
  - For the leak assertion, make fake-multix echo `HTTPS_PROXY` and assert that the value is redacted (see L1).

### L1. The proxy credential is not redacted from job output (verified)
- Where: job-runner.mjs:87-93 and 161-162.
- `secretsOf(spec)` covers only spec keys. Anything the CLI or a subprocess prints from its env, such as a debug dump or a tool that echoes `http_proxy` on failure, goes back to the job owner in `stdout`/`stderrTail`.
- Impact is limited: the token only lets a process on the host's loopback use the proxy as a public-only relay. Still, the commit claims the credential stops other processes from using it, and output is handed to callers.
- Fix: add the proxy password (or the whole `egressEnv.HTTPS_PROXY` value) to the redaction list in `runJob` when `egressEnv` is set.

### L2. No `error` listener on the proxy server after `listen` (suspected)
- Where: egress-proxy.mjs:244-250.
- `server.off("error", reject)` removes the only listener. `net.Server` emits `error` for accept failures such as EMFILE under fd pressure. With no listener, that event takes down the whole multix-server process, not just job egress.
- Fix: `server.on("error", () => {})`, or log the error after listen.

### L3. The rebinding test makes a real outbound connection (verified by reading; not flaky)
- Where: egress-proxy.test.ts:177-185.
- The first answer is `8.8.8.8`, so the proxy sends a real SYN to 8.8.8.8:<random port> and waits up to 300 ms. Accepting either 200 or 502 keeps the test stable in a sandbox or behind a transparent proxy. However, it contradicts the file header ("the only real sockets are on loopback") and depends on how the network is set up.
- Fix: compose the lookups. Wrap `createPublicLookup(fake)` so addresses it accepted are remapped to a closed loopback sink port. This tests the check-then-dial path with no external traffic.

### L4. Connection cap is shared by all jobs (suspected, low under the argv-only threat model)
- Where: egress-proxy.mjs:45 and 240.
- One proxy serves every concurrent job, with `maxConnections = 256`. Established tunnels have no idle timeout (`setTimeout(0)`). One job whose CLI opens many long-lived connections can starve the other jobs' egress. Attackers control URLs, not code, so this is unlikely in practice.
- Fix: accept and document it, or add an idle timeout on tunnels.

### L5. Docs accuracy (verified against code and iptables semantics)
- The EN and VI pages say Node's `fetch` "all go through it" without the Node >= 22.21/24 requirement (see H1).
- The Docker example `iptables -I DOCKER-USER -i <bridge> -d ... -j DROP` filters only forwarded traffic. Connections from the container to the Docker host itself (the bridge gateway IP, or host services bound to 0.0.0.0) go through INPUT and are not blocked. Suggest adding an INPUT rule or using an `--internal` network with an egress gateway.
- The proxy blocks pod and service CIDRs only when they fall in RFC 1918 or CGNAT space. Clusters that use non-private ranges are not covered. The NetworkPolicy text ("Check your cluster's pod and service ranges") hints at this, but the proxy bullet could say so explicitly.
- The ffmpeg claim (the 407 challenge flow) was not verified here. ffmpeg inputs in the CLI are restricted to `file:` anyway (media-source.ts `assertLocalPath`), so this is low risk.

### Info
- `::ffff:0:0/96` (IPv4-translated) and `192.88.99.0/24` count as public. Linux does not route the former to IPv4, so the impact is negligible.
- CONNECT is allowed to any port on public addresses, for example 25/SMTP. This is consistent with the issue scope.
- The proxy cannot cover non-HTTP clients or protocols that ignore proxy env (raw TCP, UDP, DNS exfiltration). The docs correctly recommend network-layer controls. Given H1, they should be required rather than optional.

## Recommended actions
1. H1: fail closed at executor start unless the CLI's runtime is shown to use the proxy, and document the Node minimum.
2. M1: use `pipeline` for the upstream response.
3. M2: rewrite the two weak tests so they would fail without the proxy.
4. L1 and L2: redact the token and add a server error listener.
5. L3 and L5: test hygiene and docs clarifications.

## Unresolved questions
- Will multix-server ship the `multix` CLI and Node in the same image (and same Node) once #550 lands? If so, H1 drops to a guarded config check. If not, it is a must-fix.
- Was ffmpeg's proxy-auth behaviour tested anywhere, given the code comment about 407?

Status: DONE_WITH_CONCERNS
Summary: The address check and the proxy's CONNECT path held against every bypass form I tried, but the design fails open on Node runtimes without NODE_USE_ENV_PROXY (Node 20 and 22.13-22.20), and absolute-form forwarding hangs when an upstream response is cut short. Two of the new tests would pass without the proxy.
