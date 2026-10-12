# Code review: PR #112, fix(fal): only send the key to trusted status/response URLs

- PR: https://github.com/mrgoonie/multix-cli/pull/112 (head `fd226b0`, closes #106)
- Reviewed: 2026-10-11 23:25 (Asia/Saigon), isolated reviewer (did not write the code)
- Worktree at PR head: `D:\www\oss\multix-cli\.claude\worktrees\agent-aa2a7ea46cf30db60`
- Bash was unavailable in this session, so tests, lint and typecheck were not run locally. CI results were not visible on the PR page.

## Scope

| File | +/- |
|---|---|
| src/providers/fal/client.ts | +54 / -3 |
| src/providers/fal/run-helpers.ts | +4 / -0 |
| tests/unit/providers/fal/client.test.ts | +71 / -1 |
| tests/unit/providers/fal/run-helpers.test.ts | +94 / -1 |
| docs-site/src/content/docs/commands/fal.md | +4 / -0 |
| docs-site/src/content/docs/vi/commands/fal.md | +4 / -0 |

## Verdict

**Mergeable. One Medium follow-up is recommended.** No Critical or High findings. Counts: 0 Critical, 0 High, 1 Medium, 3 Low.

## Coverage of keyed requests (verified with grep)

- Absolute URLs: `getAbsolute` and `requestAbsolute` are only called from `submitAndWait`, at run-helpers.ts:86 and run-helpers.ts:104. Both calls pass through `assertTrustedFalUrl` (client.ts:100). Both URLs are also checked up front, at run-helpers.ts:66-67, before the first poll.
- `cancel_url` is defined in types.ts:10 but nothing uses it. There is no code path that cancels a request.
- The `status` and `result` commands (status.ts:18, result.ts:26) use `client.get` with a relative path built from the base URL. The host is fixed by `FAL_BASE_URL`, so the check is not needed there. `submitPath` and `statusPath` always start with `/`, so a model ID or request ID cannot change the authority.
- Media downloads call `downloadFile(url, filepath)` with no headers (run-helpers.ts:211). Result files on `*.fal.media`, `v3.fal.media` or GCS stay unkeyed and are not affected by the new check.
- Redirects: `httpJson` goes through `fetchWithValidatedRedirects`, which drops headers once a redirect changes origin (http-client.ts:81). A 3xx from `queue.fal.run` to another host therefore does not forward the key.
- Hosts fal uses today: the fal queue docs show `status_url`, `response_url` and `cancel_url` all under `https://queue.fal.run/{app}/requests/{id}...`. Nothing found shows `fal.run` or `rest.alpha.fal.ai` being returned as a queue follow-up URL. `rest.alpha.fal.ai` is used for storage and upload tokens, which this CLI does not call. Allowing only the exact host matches today's API.

## Host comparison edge cases (traced through `checkUrlSafety`, url-safety.ts:150-175)

| Input | Result | OK? |
|---|---|---|
| `https://QUEUE.FAL.RUN/...` | lowercased, accepted | yes |
| `https://queue.fal.run./...` | trailing dot removed, accepted (same host) | yes |
| `https://queue.fal.run@evil.example/` | hostname is `evil.example`, refused | yes |
| `https://evil@queue.fal.run/` | accepted by the check; Node fetch then rejects URLs that contain credentials | yes |
| `https://queue.fal.run.evil.example`, `https://evil.queue.fal.run` | refused (tested) | yes |
| IDN or full-width lookalike | the WHATWG parser converts to punycode or NFKC first, so only the real host matches | yes |
| IPv4 or IPv6 literal | must equal the base host. A private literal is refused unless it is loopback and the base is loopback | see M1 |
| `https://queue.fal.run:8443/...` | accepted, because the port is ignored | see L1 |

Error messages contain only `host` (client.ts:56 and url-safety.ts:156/163/169). They never include the path, query or key, and the tests assert this.

## Critical

None.

## High

None.

## Medium

### M1. A private-address or non-loopback http `FAL_BASE_URL` now breaks `fal run`, `fal image` and `fal video`, with no security benefit

client.ts:49-54, using url-safety.ts:160-172.

`assertTrustedFalUrl` runs the download policy from `checkUrlSafety` on the follow-up URL even when that URL is on the configured base host:

- `FAL_BASE_URL=https://10.0.0.5` (an internal gateway on a private IP): the submit succeeds and sends the key to 10.0.0.5. The proxy then returns `status_url=https://10.0.0.5/...`, which is refused with "points to a local or private address". `isNonPublicHost` runs before the base-host comparison.
- `FAL_BASE_URL=http://fal-proxy.internal:8080`: the submit sends the key over plain http to that host. The `status_url` on the same origin is then refused with "only https".

In both cases the key has already gone to that exact origin through `request()` (client.ts:88-92), which has no check. Refusing the follow-up request protects nothing and breaks the flow. Before this PR, these setups worked. The standalone `status` and `result` commands still work because they use relative paths, so behaviour across commands is now inconsistent. The docs (EN and VI, line 63-64) cover the http rule, but not the refusal of private-IP https proxies.

This follows the stated design ("http only for loopback when FAL_BASE_URL is loopback"), so it is a design gap, not an implementation slip. The fix is still small:

```ts
// Same origin as FAL_BASE_URL: the key already goes there on submit.
if (base && new URL(url).origin === base.origin) return;   // after a malformed-URL guard
// Otherwise: https on exactly queue.fal.run, default port
```

Comparing `origin` (scheme + host + port) also fixes L1. If the maintainers want to keep refusing these proxies, the docs should say that an https base on a private IP is not supported for `run`, `image` and `video`.

## Low

### L1. The host-only comparison ignores port and scheme mismatches with the base

client.ts:54 compares `hostname` only. `https://queue.fal.run:8443/...` passes, and so does `https://<base-host>:<other-port>/...` when the base uses a different port. The impact is small: TLS still requires a valid certificate for that host, and the base host is chosen by the operator. Comparing origins (M1) closes this.

### L2. A missing `status_url` or `response_url` produces a misleading "malformed URL" error

run-helpers.ts:66-67. If a proxy or a changed fal response leaves out either field, `new URL(undefined)` throws. The user sees "Refusing to send the fal key to a malformed URL" (url-safety.ts:156) instead of "submit response is missing status_url". The key is not exposed. Options are a clear validation error, or falling back to `statusPath` and `resultPath` built from the base.

### L3. Edge-case tests are missing

The tests cover the main cases: a foreign host, lookalike subdomains, public http, loopback against a public base, no request sent before refusal, and the host-only message. These cases are not tested:

- the userinfo trick `https://queue.fal.run@evil.example`
- uppercase and trailing-dot hosts
- a non-default port
- an IPv6 loopback base (`http://[::1]:8787`)
- a private-IP https base (M1)

Adding the userinfo case is worth doing, because it is the classic way to bypass a host check.

## Informational

- `FAL_QUEUE_HOST` is exported (client.ts:32), and the instance helper `assertTrustedUrl` (client.ts:105) is a thin wrapper around it. This is acceptable, not scope creep.
- The client file still has no `node:*` imports, so the AGENTS.md rule that clients must also run on other runtimes is kept. `url-safety.ts` is also runtime-neutral.
- The "Polling for completion..." log line now comes after the checks, which is correct ordering.
- The PR body contains `Closes #106`.

## Recommended actions

1. (Medium, can be a follow-up issue if http or private proxies are out of scope) Trust a follow-up URL that has the same origin as `FAL_BASE_URL`. Otherwise require https on exactly `queue.fal.run` with the default port. Update the EN and VI docs to match.
2. (Low) Give a clear error for a missing `status_url` or `response_url`.
3. (Low) Add tests for the userinfo trick, a non-default port, and an IPv6 loopback base.
4. Before merging, confirm CI is green. It could not be checked in this session.

## Unresolved questions

- Is an http or private-IP `FAL_BASE_URL` proxy a supported setup? This decides whether M1 must be fixed before merging or can be a follow-up.

Sources: [fal queue docs](https://fal.ai/docs/model-apis/model-endpoints/queue), [docs.fal.ai queue](https://docs.fal.ai/model-endpoints/queue/)
