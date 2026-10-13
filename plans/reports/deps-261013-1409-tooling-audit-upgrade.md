# Dev tooling audit upgrade (issue #128)

Date: 2026-10-13. Branch: `chore/deps-tooling-audit`.

The 14-day release-age rule was dropped by user decision on 2026-10-13, so the
releases the issue was waiting on (source-map-js 1.2.2, wrangler 4.149.0) are
adopted now. AGENTS.md keeps the "lockfile diffs stay confined" requirement.

## Versions changed

| Package | Scope | Before | After | Note |
|---|---|---|---|---|
| source-map-js | root (transitive via postcss) | 1.2.1 | 1.2.2 | Lockfile-only; one entry changed |
| source-map-js | worker (transitive via postcss) | 1.2.1 | 1.2.2 | Lockfile-only; one entry changed |
| wrangler | worker | 4.141.0 | 4.149.0 | Exact pin kept |
| @cloudflare/workers-types | worker | 5.20260926.1 | 5.20261013.1 | Required: wrangler 4.149.0 has peerOptional `^5.20261006.1` (ERESOLVE otherwise) |
| wrangler | docs-site | ^4.115.0 (4.115.0) | ^4.149.0 | |
| astro | docs-site | ^7.1.5 (7.1.5) | ^7.3.8 | |
| @astrojs/starlight | docs-site | ^0.41.5 | ^0.42.6 | 0.42 breaking items checked; none apply (no config `tagline`, no mobile-menu overrides; hero `tagline` frontmatter is unaffected) |
| fast-uri, http-cache-semantics, js-yaml | docs-site (transitive) | 3.1.4, 4.2.0, 4.3.0 | 3.1.8, 4.3.0, 4.3.2 | `npm update <pkg>` lockfile refresh |

The worker and docs-site lockfile churn is limited to the dependency trees of
wrangler (miniflare, workerd, sharp, undici, esbuild and platform binaries) and
astro/starlight (astro 7.3 dropped its remark/mdx stack for satteri).

## npm audit

Before:

| Scope | low | moderate | high | critical | total |
|---|---|---|---|---|---|
| root | 1 | 0 | 1 | 0 | 2 |
| worker | 0 | 0 | 5 | 0 | 5 |
| docs-site | 0 | 11 | 11 | 1 | 23 |

After:

| Scope | low | moderate | high | critical | total |
|---|---|---|---|---|---|
| root | 1 | 0 | 0 | 0 | 1 |
| worker | 0 | 0 | 0 | 0 | 0 |
| docs-site | 0 | 10 | 0 | 0 | 10 |

## Remaining advisories

- root, `esbuild` low (GHSA-g7r4-m6w7-qqqr, range `>=0.27.3 <0.28.1`, dev
  server on Windows only): tsup 8.5.1 is still the latest release (2025-11-12)
  and requires `esbuild ^0.27.0`. Needs an upstream tsup release; left as is.
- docs-site, 10 moderate, one root cause: `postcss-selector-parser` <7.1.6
  (GHSA-rj75-hqrm-r3gf) via `postcss-nested` 6.2.0, which
  `@expressive-code/core` (latest 0.44.2) still pins at `^6.0.1`. The fix needs
  postcss-nested 8 (selector-parser ^7), a major bump inside expressive-code.
  npm's suggested "fix" is a downgrade to starlight 0.21.5. Build-time only
  (docs CSS from our own sources); left for an upstream expressive-code release
  rather than a cross-major override.

## Verification

- Root: `npm run lint`, `npm run typecheck`, `npm run build` pass.
- Root `npm test`: the machine was heavily loaded (load average 150-225 on 8
  cores) and the default run hit timeouts in process-spawning smoke tests and
  the 256 MB streaming upload test. `tests/smoke` passes in full (96/96) with
  `--testTimeout=120000 --no-file-parallelism`; the full suite with
  `--testTimeout=120000` passes 1159/1160, the remaining failure being the
  upload test's own 30 s timeout. The root change is a lockfile bump of
  source-map-js (postcss/vite only), which neither code path loads.
- `npm run check:mcp`: pass (worker typecheck, 153 tests, bundle check clean).
- `npm run verify:docs`: pass (astro check 0 errors/warnings, build, 5/5
  tests). The build logs a benign `collection "i18n" does not exist` warning;
  the site defines no custom UI-string collection.

## Unresolved questions

- Should the CI run (unloaded machine) be treated as the authority for the
  timeout-sensitive tests before review?
