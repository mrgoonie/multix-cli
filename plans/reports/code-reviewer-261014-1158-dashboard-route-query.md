# Code review: PR #210 — route query-string URLs to the MCP Worker

Branch `fix/mcp-dashboard-route-query` (445682e), worktree `/Volumes/GOON/www/oss/multix-fix-208`.
Diff: `worker/wrangler.jsonc` only, +5/-6.

## Verdict

Correct and minimal. No blocking issues. Approve.

## Route semantics (verified)

Cloudflare routes docs (developers.cloudflare.com/workers/configuration/routing/routes/):
- "Route pattern matching considers the entire request URL, including the query parameter string."
- Patterns cannot contain query params; "the only way ... to match URLs with query parameters is to terminate it with a wildcard".
- Trailing `*` on path matches all suffixes; infix wildcards forbidden. `/mcp*` etc. are valid.
- Overlaps: most specific pattern wins.

So the old `multix.zuey.me/dashboard` missed `/dashboard?notice=saved` (emitted by `worker/src/routes/dashboard-routes.ts:122-142`) and fell through to the docs Custom Domain. `/dashboard*` fixes it and also covers `/dashboard/...`, so dropping `/dashboard/*` and `/mcp/*` is safe.

## Other routes in the file

| Pattern | Query-safe? | Note |
|---|---|---|
| `/mcp*` | yes (fixed) | `/mcp?…` previously missed |
| `/dashboard*` | yes (fixed) | |
| `/health*` | yes (fixed) | |
| `/oauth/*` | yes | ends in `*`; covers `/oauth/authorize?…`, `/oauth/github/callback?code=…` |
| `/.well-known/oauth-*` | yes | covers both metadata docs incl. `?resource=` |
| `/api/*` | yes | covers `/api/v1/...`, `/api/docs?…`. Bare `/api` not routed; Worker doesn't serve it anyway (`API_PREFIX = "/api/v1"`) |

No remaining instance of the bug.

## Docs-site collision check

Docs site (`docs-site/`, Astro Starlight, static, no `base`): root paths are `/`, `/getting-started/`, `/commands[/…]`, `/guides/{mcp-server,rest-api}/`, `/reference/…`, `/vi/…`, `/images/…`, `/_astro/…`, `/pagefind/…`, `/404`, `/llms.txt`, `/llms-full.txt`, `/robots.txt`, `/sitemap-*.xml`, plus `/<slug>.md` per page (`src/pages/[...slug].md.ts`).
None begins with `/mcp`, `/dashboard`, or `/health` at root (`/guides/mcp-server/` does not match; patterns anchor at path start). No collision today.

## Unexpected paths now captured by the Worker

`/mcpfoo`, `/mcp-x`, `/dashboardx`, `/healthz`, `/health.json`:
- OAuth provider apiRoute matching is exact-or-`/`-descendant (`workers-oauth-provider` dist ~line 2907: `pathname === normalized || startsWith(normalized + "/")`), so `/mcpfoo` is NOT treated as the protected resource; it goes to `handleDefault`.
- `handleDefault` (`worker/src/index.ts`): `/health` exact match; `isDashboard` = `=== "/dashboard" || startsWith("/dashboard/")`; anything else not authorize/callback/api returns `text(404)` before `resolveAppContext`. No KV/D1 access, no info leak. Safe.
- Only effect: these paths get the Worker's plain-text 404 instead of the docs-site styled 404. Cosmetic.

## Stale routes on deploy

`deploy-mcp.yml` runs `wrangler deploy` on push to main (`worker/**` path filter matches). Wrangler `publishRoutes` (cli.js ~158864) does `PUT /workers/scripts/<name>/routes` ("PUT will delete previous routes on this script"), so old `/mcp`, `/mcp/*`, `/dashboard`, `/dashboard/*`, `/health` are removed. Only if the token lacks All-Zones permission does it fall back to per-zone POST, which leaves old routes and logs a "Previously deployed routes" warning.
Even if stale routes remain, they point at the same script and are subsumed by the new patterns. Harmless; only matters if someone later wants to un-route one of those paths.

## Findings by severity

- Critical: none.
- High: none.
- Medium: none.
- Low 1: No regression guard. Nothing in `worker/` tests asserts route patterns; the same bug returns with any new exact-path route. Optional: small test parsing `wrangler.jsonc` asserting every path pattern ends in `*` (the new comment documents the rule, which is the minimum).
- Low 2: Prefix capture broader than needed. `/mcp*`, `/health*`, `/dashboard*` would swallow any future root-level docs page starting with those words (e.g. `/mcp-setup/` would 404 in the Worker). Not an issue today; keep docs slugs out of those prefixes.
- Info: after merge, check deploy log for the "Previously deployed routes" warning; if present, delete stale routes in the dashboard for hygiene.
- Info: `fix(mcp)` triggers a release-please npm bump for a worker-only change; consistent with prior worker commits (546d6f9), acceptable.

## Verification done

- Read diff, `worker/src/index.ts` handleDefault, oauth-provider apiRoute matcher, wrangler publishRoutes source, docs-site config/pages/content tree, deploy workflow, Cloudflare routes docs.
- Did not run lint/tests (config-only change). No live curl against production.

## Unresolved questions

- Does CI `CLOUDFLARE_API_TOKEN` have All-Zones permission (PUT path) or hit the fallback that leaves stale routes? Harmless either way.

Status: DONE
Summary: Fix is correct per Cloudflare route semantics (query strings need trailing `*`); no docs-site path collides; Worker 404s unknown prefixed paths safely; stale routes replaced by PUT, or harmless if left.
