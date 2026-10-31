# Site & dashboard redesign: Cinematic Obsidian

Issue: #405 · Branch: `feat/site-obsidian-redesign` · Status: in progress
Brief (contract): `plans/reports/advise-261028-1146-website-dashboard-redesign-brief.md`
Approved look: `plans/reports/advise-261028-1128-hero-obsidian-palette-demo.html` (palette Mono)

## Decisions

- One token source: `docs-site/src/styles/tokens.css` (`--mx-*`). Worker embeds a generated copy
  (`npm run tokens --prefix worker`, sync test `worker/test/design-tokens.test.ts`).
- Serif italic is Newsreader (Instrument Serif has no Vietnamese glyphs). Fonts self-hosted via
  `@fontsource-variable/*`, imported by `docs-site/src/styles/fonts.css`.
- Dashboard uses a system font stack: its CSP has no `font-src` and may only widen by script hashes.
- Theme preference key is Starlight's `starlight-theme` (`auto` | `light` | `dark`, absent = auto) on
  every surface of the docs origin; `html[data-theme]` holds the resolved value.
- Language redirect runs on the landing root only: first visit with a `vi*` browser language and no
  stored choice goes to `/vi/`; any manual switch stores `multix-lang`. Bots get EN + hreflang.
- Docs CSP collects inline-script hashes from the build automatically; only case-study video hosts
  need a narrow addition (orchestrator, phase 5).

## Phases and file ownership

| # | Phase | Owner | Files |
|---|---|---|---|
| 0 | Tokens + fonts | orchestrator | done (`6b2172e`) |
| 1 | Head mesh via multix (Atlas, ≤3 img + ≤3 3D, dry-run first) | orchestrator | `docs-site/scripts/hero/**`, `docs-site/public/hero/**` |
| 2 | Landing EN/VI + WebGL hero | sub-session | `docs-site/src/pages/index.astro`, `src/pages/vi/index.astro`, `src/components/landing/**`, `src/scripts/landing/**`, `tests/landing-output.test.mjs`, banner assertion in `tests/site-output.test.mjs` |
| 3 | Starlight docs theme | sub-session | `astro.config.mjs`, `src/styles/custom.css`, `src/components/starlight/**`, `DocsFooter.astro`, `src/pages/404.astro`, `tests/docs-theme-output.test.mjs` |
| 4 | Dashboard app shell + EN/VI | sub-session | `worker/src/pages/**` (not `design-tokens.ts`), `worker/src/http-responses.ts`, dashboard route files, `worker/test/**` for pages |
| 5 | Case studies | orchestrator | `src/components/landing/case-studies*` after phase 2 merges, `scripts/write-security-headers.mjs` |
| 6 | ak-enhance-ux-ax, Lighthouse, axe, screenshots | orchestrator | fixes anywhere, after merges |
| 7 | Isolated review, PR `Closes #405` | review sub-session + orchestrator | — |

Phases 2–4 run in parallel in their own worktrees, branched from this branch; merged here one at a time.

## Acceptance

See "Done means" in the brief. Each phase also leaves `npm run lint`, its package's typecheck/build/test green.
