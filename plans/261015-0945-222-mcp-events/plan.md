# Multix Worker: MCP 2026-07-28 and MCP Events (issue #222)

Status: implemented, in review

## Outcome

- `/mcp` serves protocol 2026-07-28 (`server/discover`, per-request `_meta`
  envelope) through `@modelcontextprotocol/server` 2.x, next to the unchanged
  2025 `initialize` path.
- Modern clients see the `events` capability and can call `events/list`,
  `events/subscribe`, `events/unsubscribe`, backed by a per-account
  `EventSubscriptions` Durable Object (sqlite), secrets encrypted with
  `SECRETS_ENCRYPTION_KEY`.
- Publishing job lifecycle events stays in #223.

## Constraints and non-goals

- Existing tools, OAuth and REST API unchanged; legacy responses stay JSON.
- No Node built-ins in the Worker bundle (`check:bundle`).
- No replay (`cursor` answers `truncated: true`), no `subscriptions/listen`.
- No delivery worker in this change.

## Design

| Concern | Choice |
|---|---|
| Era routing | `isLegacyRequest` → existing `WebStandardStreamableHTTPServerTransport` (JSON); else `createMcpHandler(..., { legacy: "reject", responseMode: "json" })` |
| Media type | 415 on the modern leg (SDK leaves it to hand-wired compositions) |
| Identity | `sub_` + 24 hex of SHA-256 over canonical `[account, url, name, arguments]` |
| SSRF | `assertPublicHttpsUrl` + DoH A/AAAA public-address check + `redirect: "manual"`; delivery (#223) must re-check addresses per request (DNS rebinding) |
| Verification | Standard Webhooks signed challenge, 10 s, 4 KiB answer cap, cached 24 h per (url, secret) |
| Lifetime | default 24 h, clamp 5 min–7 d, `null` → 7 d; secret rotation window 1 h; 20 per account |

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

Revert the merge commit. The `EventSubscriptions` class stays declared in
`exports`; removing it later needs a delete-class step for the Durable Object.
