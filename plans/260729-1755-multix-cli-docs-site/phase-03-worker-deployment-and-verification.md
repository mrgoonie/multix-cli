---
phase: 3
title: "Worker deployment and verification"
status: in-progress
priority: P1
dependencies: [1, 2]
---

# Phase 3: Worker deployment and verification

## Requirements

- Add a Wrangler v4 configuration for `docs-site/dist` as Workers Static Assets and
  `multix.zuey.me` custom domain.
- Add package scripts for docs build/preview/deploy and CI coverage for the
  generated site.
- Verify both HTML and `.md` endpoints, SEO files, responsive UI, and custom
  domain after deployment.

## Files

- Create: `docs-site/wrangler.jsonc`; add a Worker script only if Static Assets
  cannot fulfil canonical routing.
- Modify: `docs-site/package.json`, `.github/workflows/ci.yml`, README only if
  its docs link becomes user-facing.

## Validation

- `npm --prefix docs-site run build`, lint, typecheck, build, and test all pass.
- `wrangler deploy --dry-run` validates the configuration before deployment.
- After deploy, probe `/`, representative command route, `/llms.txt`, and their
  `.md` forms with headers and canonical metadata checks.

## Risks and rollback

- Current Wrangler auth is invalid and `multix.zuey.me` has no DNS. This is an
  external blocker to deployment. Roll back a bad live release with Wrangler's
  prior deployment/version controls after auth is restored.
