---
phase: 1
title: "Content and static generator"
status: complete
priority: P1
dependencies: []
---

# Phase 1: Content and static generator

## Requirements

- Set up an isolated Astro Starlight app with concise, accurate Markdown pages
  for install/setup, command overview,
  each top-level command/provider, output, troubleshooting, and agent guide.
- Keep English as the root route and provide equivalent Vietnamese pages under
  `/vi/`; preserve code commands verbatim.
- Generate static route HTML and `<route>.md` endpoint assets, plus `llms.txt`,
  `llms-full.txt`, sitemap, robots and language alternates from the same
  manifest.

## Files

- Create: `docs-site/**`, `tests/docs-site/**`.
- Modify: root `package.json`, `.gitignore` and CI only as needed for nested
  docs commands.
- Generated, untracked: `docs-site/dist/**`.

## Validation

- Start with a one-route proof: English and `/vi/` peer pages plus matching
  `.md` assets, then inspect the static output and a Wrangler preview before
  authoring the complete reference.
- Unit-test route/Markdown parity, generated metadata, and command-page links.
- Build must fail when locale route sets differ or a referenced page is
  missing. Test `text/markdown` for English and Vietnamese endpoint assets.

## Risks

- README drift. Reuse its command facts and include a testable content manifest
  rather than duplicating ad-hoc strings throughout templates.
