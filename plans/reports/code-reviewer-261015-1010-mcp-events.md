# Code review: MCP 2026-07-28 and MCP Events (issue #222)

Reviewed: commit d34a0e7 on `claude/gracious-heisenberg-ppahvw`. The author committed the working tree during the review; the file set matches the uncommitted diff the review started from. 26 files, +2123/-1291, most of the deletions in `worker/package-lock.json`.

## Verification run

- `npx tsc --noEmit` and `tsc -p tsconfig.test.json`: clean
- `npx vitest run` (worker): 18 files, 285 tests pass
- `npm run check:bundle`: clean (no `node:*`, commander, execa)
- `biome check worker/src worker/test`: clean
- Lockfile: the removed packages are exactly the old `@modelcontextprotocol/sdk` tree (express, hono, ajv, ...). Added: `@modelcontextprotocol/core` and `server`.
- Scratch probes, run from the scratchpad, no repo files changed:
  1. Error-path probe against the new code.
  2. Legacy `initialize` + `tools/list` dump at HEAD~1 and at HEAD, run in a temporary worktree and then diffed. The worktree has been removed.

## High

### H1. 2025 (legacy) clients get a different tools contract, while the docs say "exactly as before"
- Where: `worker/src/jobs/job-tools.ts` (raw-shape `inputSchema`), `worker/src/mcp-server.ts:80-96`, and the docs: `docs-site/.../guides/mcp-server.md` ("get the tools exactly as before. Nothing changes for them"), the vi version, and the plan's constraint ("legacy responses stay JSON").
- Evidence: legacy `tools/list` diffed between HEAD~1 and HEAD. Every tool changed in these ways:
  - `inputSchema.$schema`: `http://json-schema.org/draft-07/schema#` became `https://json-schema.org/draft/2020-12/schema`.
  - `inputSchema.additionalProperties: false` is **gone**. Zod 4 no longer emits it for a plain `z.object`.
  - `execution: { taskSupport: "forbidden" }` is removed.
  - `z.record` fields now emit `propertyNames`.
  - Validation error text changed: `MCP error -32602: Input validation error: ... Expected string, received number at command` became `Input validation error: ... command: Invalid input: expected string, received number`.
- What breaks: these are the 2025 clients (Claude Desktop, Cursor, older connectors) the issue says must be unaffected:
  - Clients with draft-07-only validators, or that reject the 2020-12 meta-schema, can fail to load the tools.
  - Strict function-calling modes that need `additionalProperties: false` (OpenAI strict schemas) lose closed objects.
  - Models now see open input objects and may invent extra fields. Zod strips them silently.
  - None of this is mentioned in the commit, docs or plan, and the `feat` commit publishes a release.
- Fix:
  - Use closed objects so the schema emits `additionalProperties: false` again: `z.strictObject({...})`, or a schema object if `registerTool` accepts one.
  - Add a snapshot or regression test of legacy `tools/list` (including `$schema` and `additionalProperties`).
  - Either restore draft-07 output (if the SDK allows it) or state the change in the docs and PR as a deliberate contract change.
  - Drop the "exactly as before" wording unless it is true.

## Medium

### M1. Internal error messages from events handlers are sent to the client unredacted
- Where: `worker/src/events/events-methods.ts:131-236`. Nothing catches non-`ProtocolError` throws, and SDK `src-Cqbh3MYc.mjs:6552-6560` copies `error.message` into the JSON-RPC error.
- Evidence (probe): when `subscriptions.get` throws `new Error("Durable Object storage at /internal/path exploded: key sub:abc")`, the client receives `{"code":-32603,"message":"Durable Object storage at /internal/path exploded: key sub:abc"}`.
- Real-world triggers:
  - Durable Object RPC errors ("Durable Object reset because its code was updated", storage/network faults).
  - KV errors from `jobs.ownedBy`.
  - WebCrypto errors from `encryptSecret`.
  - `signWebhook`'s "Malformed webhook secret".

  The tools path sanitizes through `runTool` and `sanitizeText`; the events path does not, which breaks the docs claim that "only the failure category ... is returned".
- Fix: wrap each handler. Re-throw `ProtocolError`, otherwise `logEvent("error", "event_<method>", { error: sanitizeText(...) })` and throw `new ProtocolError(InternalError, "Internal error")`. Add a test that injects a throwing stub.

### M2. The "connection-time" SSRF boundary rests on a misreading of `global_fetch_strictly_public`
- Where:
  - `worker/src/events/callback-guard.ts:10-14` (comment)
  - docs `guides/mcp-server.md`, Security bullet "Event callbacks" ("`global_fetch_strictly_public` flag refuses private addresses again at connection time (DNS rebinding)"), and the vi equivalent
  - plan Design table, SSRF row
- Fact: Cloudflare's compatibility-flags page describes this flag only as routing same-zone subrequests through the public front door instead of straight to the zone origin. It says nothing about refusing private or reserved IPs. (Its stated purpose in `wrangler.jsonc:15` is the Client ID Metadata Document fetch.)
- Failure scenario:
  1. An attacker controls the DNS for `cb.attacker.tld` with TTL 0.
  2. DoH (`cloudflare-dns.com`) returns a public A record and the check passes.
  3. The verification POST resolves seconds later through the edge's own resolver.
  4. Later deliveries (#223) resolve days later with no check at all.

  The OpenAI guide requires private-address blocking "checked at connection time" for both verification and delivery. Today the only thing enforcing that is Cloudflare's general refusal to route subrequests to RFC 1918 / loopback space. That is real in practice, but it is not what the code, docs and plan cite, and they present it as a guaranteed control.
- Fix:
  - Correct the comment, both docs and the plan: name the actual residual risk, and name the platform behavior relied on (with a link) or drop the claim.
  - In #223, re-run `assertPublicCallbackUrl` before each delivery batch. It is cheap with a short in-isolate cache.
  - Treat a hostname with any AAAA/A outside public space at delivery time as a hard drop.

### M3. Subscriptions outlive OAuth grant revocation, and `clientId` is stored but never used
- Where: `worker/src/events/event-subscriptions.ts:28-29` (`clientId` "for audit"), `worker/src/routes/dashboard-routes.ts:9` (`/dashboard/connections/revoke` does not touch subscriptions).
- Failure scenario:
  1. A user connects client X, which subscribes with a 7-day TTL.
  2. The user then disconnects X in the dashboard because it is compromised or no longer trusted.
  3. Once #223 delivers, job ids, commands and R2 asset keys keep going to X's webhook until expiry.
- The test "requires a token for events and refuses a revoked one" (`worker/test/mcp-events-oauth.test.ts:71-87`) asserts every account's list is empty after revocation. That is vacuous, because nothing was ever subscribed in that test.
- Fix:
  - Add `removeByClient(clientId)` to the DO and call it from the grant-revoke route. Alternatively, have delivery check that the grant still exists.
  - Rewrite the test: subscribe, revoke, then assert the subscription is gone (or is not delivered to).
  - At minimum, record this as an explicit #223 requirement.

## Low

### L1. Gaps in the reserved-range lists
- Where: `worker/src/events/callback-guard.ts:49-67`, `:92-115`.
- Not blocked:
  - IPv4: 192.31.196.0/24, 192.52.193.0/24 (AMT), 192.175.48.0/24 (AS112).
  - IPv6 inside 2000::/3: 2001:2::/48 (benchmarking), 2001:10::/28 and 2001:20::/28 (ORCHID), 3fff::/20 (documentation, RFC 9637).
- Little practical reach from the Cloudflare edge, but the docs promise "every address ... must be public". Add these ranges, or use the IANA special-purpose registry as the source.

### L2. `events/unsubscribe` is not fully idempotent
- Where: `worker/src/events/events-methods.ts:217-218`.
- An invalid URL returns `{}`, but an unknown event name, an unsupported mode or arguments outside the schema throw -32602. If an event is later dropped or renamed in the catalog, clients cannot unsubscribe (they get an error) and must wait for expiry.
- Fix: in unsubscribe, return `{}` for any input subscribe would have refused.

### L3. Outbound POST reflector without a per-account budget
- Where: `worker/src/events/events-methods.ts:164-172`.
- Every subscribe with a fresh URL+secret sends 2 DoH queries and a signed POST to a caller-chosen public URL. Failed verifications count against nothing except the shared `MCP_RATE_LIMITER` (60/min/account).
- Invite-only accounts keep the risk low. Consider a small per-account verification budget in the DO, or count failures.

### L4. Expired data is never collected for idle accounts
- Where: `worker/src/events/event-subscriptions.ts:66-74`, `:96-99`.
- Expired `sub:` and `verified:` entries are only pruned on that account's next write or list. There is no alarm.
- #223 delivery must filter on `expiresAt` itself, never on mere presence. Consider a DO alarm at the earliest `expiresAt`.

### L5. Test gaps on the concurrency and rotation claims
- Where: `worker/test/mcp-events.test.ts:228-242`, `:334-356`.
- The limit test only reaches the non-atomic pre-check (`events-methods.ts:157-162`). The atomic `upsert` → `"limit"` path, the one that matters under concurrent subscribes, is never exercised.
- The rotation test only checks `previousSecret.until`. It does not check that `previousSecret` decrypts to the old secret under the subscription's AAD.
- The fake DO does not model input gates, so there is no concurrency evidence beyond reasoning. The reasoning holds: upsert only awaits storage, so input gates serialize it.
- Add:
  - a direct test: pre-check passes, then `upsert` returns `limit`
  - a decrypt assertion for `previousSecret`

### L6. Concurrent refreshes with different secrets can drop the rotation window
- Where: `worker/src/events/events-methods.ts:176-199`.
- `previousSecret` is computed in the Worker from a stale read, so the last writer wins. Moving the rotation computation into `upsert` (inside the DO) makes it atomic.
- Rare in practice: only a client racing itself.

## Nit

- Docs (en and vi): "protocol `2025-06-18` and earlier" also covers `2025-11-25`. The SDK's legacy `LATEST_PROTOCOL_VERSION` is `2025-11-25`, which is still served on the initialize path.
- `events-methods.ts:145`: a DoH failure is reported as `connection_refused`. That is acceptable, but the docs list of reasons does not explain it.
- The AAD for subscription secrets reuses the `multix-provider-secret:v1:` domain label, with `event-subscription:<id>` as the name. There is no collision with provider key names, so this is harmless; a separate label would be cleaner.

## Checked and found sound

- **Cross-account isolation:** the DO is named by account id and the subscription id hashes the principal, so one account cannot list or remove another's subscriptions (tested).
- **Body size and batches:** limit and batch rejection run before era routing. The modern leg rejects with 415 when the media type is not JSON. `subscriptions/listen` gets a 404 / -32601.
- **Invalid-params messages:** zod messages do not echo the secret value (probe).
- **Legacy `initialize`:** the result is byte-identical apart from the tools differences in H1. `events` is not advertised to 2025 clients, and `events/*` answers -32601 for them.
- **Verification:**
  - `redirect: "manual"`, and 3xx maps to `challenge_failed`
  - 4 KiB answer cap
  - 10 s timeout
  - constant-time comparison through `tokensMatch`
  - Standard Webhooks signature with the correct reference vector
  - `X-MCP-Subscription-Id` header
- **TTL rules** match the guide: default, clamping, and `null` gets a finite grant.
- **CNAME answers:** CNAME records with a private A target are refused (probe).
- **Worker runtime:** DO RPC returns plain structured-cloneable objects (`EncryptedValue` is strings only). No `node:*` imports in `src/events` (bundle check).
- **Docs:** en and vi are consistent with each other, and the anchors resolve.

## Plan follow-ups

The plan's Outcome items are implemented. Its Validation list is met by the mocked tests, apart from the gaps in L5 and the vacuous revoke assertion in M3. The live ChatGPT handshake is still pending, as the plan states. Before merge, resolve H1 (or record it as an accepted contract change) and M1. The M2 docs need correcting either way. M3 and L4 should become explicit requirements on #223.

## Unresolved questions

1. Was the legacy tools schema change (H1) intended and accepted? Release-please will publish it as a `feat`.
2. Should revoking a client grant delete that client's event subscriptions (M3), or should subscriptions be account-scoped by design?

## Resolution

- H1: tool input schemas keep their draft-07 closed-object form (`tool-input-schema.ts`); a fixture test pins the schemas 2025 clients see.
- M1: events handlers answer unexpected failures with `-32603 Internal error` and log the detail server side.
- M2: the DNS-rebinding claim is corrected in code and docs; delivery (#223) must re-check the address before every request.
- M3: revoking a dashboard connection removes the subscriptions that client created.
- L1, L2, L5: extra reserved ranges, idempotent unsubscribe for impossible targets, tests for the limit race and the rotated secret.
- Also fixed: event log lines no longer overwrite the log event name with the subscribed event name.
- Left for #223: L3 (verification budget is bounded by the 60/min rate limit), L4 (expired rows are dropped on writes; delivery must filter on `expiresAt`), L6 (concurrent rotation keeps one of the two previous secrets).
