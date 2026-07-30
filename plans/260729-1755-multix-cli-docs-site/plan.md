---
title: "Multix CLI documentation site"
description: "Static multilingual command reference deployed on Cloudflare Workers."
status: in-progress
priority: P1
branch: "feat/multix-cli-docs"
tags: [documentation, cloudflare-workers, seo, i18n]
blockedBy: []
blocks: []
created: "2026-07-29"
---

# Multix CLI documentation site

## Outcome

Ship `https://multix.zuey.me`: an English-first, Vietnamese-localized command
reference for `multix`, built as static assets on one Cloudflare Worker. Every
human-readable page has an equivalent same-path `.md` asset for agents.

## Scope and decisions

- Astro Starlight is the static documentation framework. Source Markdown is
  canonical; its build emits HTML, same-path Markdown endpoints, `llms.txt`,
  sitemap, robots policy, and a search index.
- Use Workers Static Assets and a custom-domain route, not deprecated Workers
  Sites and not a runtime database/API.
- Use Starlight's responsive docs shell, Pagefind search, syntax highlighting,
  and copy affordances; add only small overrides for the system theme mode and
  product footer.
- English lives at `/`; Vietnamese lives at `/vi/`. A user-selected language is
  persisted locally but URLs remain shareable and crawlable.
- Stable command facts come from the existing README/CLI surface. Do not invent
  provider capabilities or publish keys.

## Architecture

```text
docs-site/src/content/docs/{en,vi}/*.md
             | Astro + Starlight build
             v
docs-site/dist/<route>/index.html + docs-site/dist/<route>.md
             + Pagefind index + llms.txt + sitemap.xml + robots.txt
             | Wrangler Static Assets
             v
Cloudflare Worker (custom domain multix.zuey.me)
```

## Phases

| Phase | File | Goal | Status |
|---|---|---|---|
| 1 | [Content and static generator](./phase-01-content-and-static-generator.md) | Astro/Starlight, canonical command content and machine-readable outputs | complete |
| 2 | [Accessible docs experience](./phase-02-accessible-docs-experience.md) | Responsive navigation, i18n, theme, search, copy affordances | complete |
| 3 | [Worker deployment and verification](./phase-03-worker-deployment-and-verification.md) | Wrangler config, domain attachment, tests, live probes | in-progress |

## Acceptance criteria

- English default and Vietnamese routes cover every published documentation page.
- System/light/dark themes work without flash, persist selection, and meet basic
  keyboard/focus/reduced-motion expectations.
- Cmd+K opens a searchable, keyboard-navigable command/page panel.
- Desktop and mobile navigation remain usable; every rendered code block has an
  accessible Copy control.
- Each route has a `.md` representation with stable canonical content.
- SEO includes canonical/hreflang metadata, descriptions, Open Graph, JSON-LD,
  sitemap and robots; `llms.txt` links useful agent-facing Markdown URLs.
- The footer visibly renders `Made with ❤️ by AgentKit.best` linked to
  `https://agentkit.best` and `Author @goon_nguyen (X)` linked to the author's
  X profile.
- `npm run build:docs`, lint/typecheck/test checks, and Worker deploy succeed;
  `multix.zuey.me` serves the expected content and Markdown endpoints.

## Deployment evidence and risk

The public hostname currently does not resolve and local Wrangler authentication
fails with `Not logged in` after a rejected token. Code and PR can proceed, but
the production deploy/domain attachment is externally blocked until the
Cloudflare credential is refreshed. The Worker custom-domain configuration
should create/maintain the proxied DNS and certificate on deploy; do not make
unrelated manual DNS changes.

## Unresolved questions

- None for implementation. Cloudflare authentication is the sole external
  release prerequisite.
