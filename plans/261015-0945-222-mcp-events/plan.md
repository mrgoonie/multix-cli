# Multix Worker: MCP 2026-07-28 and MCP Events (issue #222)

Status: implemented, in review

## Outcome

- `/mcp` serves protocol 2026-07-28 (`server/discover`, per-request `_meta`
  envelope) through `@modelcontextprotocol/server` 2.x, next to the unchanged
  2025 `initialize` path.
- Modern clients see the `events` capability and can call `events/list`,
  `events/subscribe`, `events/unsubscribe`, backed by the per-account
  `AccountEvents` hub from #223/#224, which also delivers the events.
- MCP subscriptions are hub records with an `mcp` part (job filter, rotation
  secret, OAuth client); their deliveries use the MCP Events body
  (`eventId`, `name`, `timestamp`, `data`, `cursor`) and the
  `X-MCP-Subscription-Id` header.

## Constraints and non-goals

- Existing tools, OAuth and REST API unchanged; legacy responses stay JSON.
- No Node built-ins in the Worker bundle (`check:bundle`).
- No replay (`cursor` answers `truncated: true`), no `subscriptions/listen`.
- Delivery, retries and dead letters are the hub's (#224).

## Design

| Concern | Choice |
|---|---|
| Era routing | `isLegacyRequest` → existing `WebStandardStreamableHTTPServerTransport` (JSON); else `createMcpHandler(..., { legacy: "reject", responseMode: "json" })` |
| Media type | 415 on the modern leg (SDK leaves it to hand-wired compositions) |
| Identity | `sub_` + 24 hex of SHA-256 over canonical `[account, url, name, arguments]` |
| SSRF | `assertPublicHttpsUrl` + DoH A/AAAA public-address check + not this server + `redirect: "manual"`; per-delivery re-check is #226 |
| Verification | Standard Webhooks signed challenge, 10 s, 4 KiB answer cap; skipped when refreshing a live subscription with the same callback and secret |
| Lifetime | default 24 h, clamp 5 min–7 d, `null` → 7 d; secret rotation window 1 h; 10 active per account, shared with REST |

## Files

- `worker/src/events/*` (new): catalog, identity, signing, callback guard and
  verification, subscription store, methods, request context.
- `worker/src/mcp-api-handler.ts`, `mcp-server.ts`, `index.ts`, `config.ts`,
  `jobs/job-tools.ts` (zod 4 `z.record` arity), `wrangler.jsonc`.
- Tests: `worker/test/events-security.test.ts`, `mcp-events.test.ts`,
  `mcp-events-oauth.test.ts`, helpers.
- Docs: `docs-site` MCP guide (en, vi), `README.md`.

## Validation

- Mocked (CI): signing reference vector, address guard, verification failure
  mapping, discover/events/tools on the modern leg, legacy unchanged,
  subscribe/refresh/rotation/limit/unsubscribe, cross-account isolation,
  `job_id` ownership, revoked token → 401, bundle check.
- Live (not run from CI): ChatGPT handshake against the deployed Worker after
  merge; run `server/discover` and `events/list` with a real connector.

## Rollback

Revert the merge commit. No Durable Object class is added (the hub's
`AccountEvents` already exists); MCP subscription records left in the hub
keep being delivered until they expire (at most 7 days) or are revoked over
REST.
