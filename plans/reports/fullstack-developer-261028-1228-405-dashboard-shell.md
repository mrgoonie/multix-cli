# Dashboard shell redesign (#405)

Commit `3fe7c9b` on `claude/dashboard-shell-027184` (not pushed, no PR).

## What changed
- App shell (`worker/src/pages/page-layout.ts`): sidebar with anchors (overview, provider keys, R2 storage, API keys, clients, API docs), CSS-only top bar ≤900px, skip link, landmarks, `noindex` kept. `focusPage` for sign-in/consent/message pages.
- Styles only from `DESIGN_TOKENS` / `var(--mx-*)` (`page-styles.ts`); old literals gone (test scans `src/pages` source).
- Overview (`dashboard-overview.ts`): 3 setup steps (sign in ✓, provider key when ≥1 saved, paste MCP URL + copy; done when a client is connected), stats, provider status grid.
- i18n: typed dictionary `i18n-en.ts` / `i18n-vi.ts`, `negotiateLanguage` (Accept-Language q-values). Notice strings moved from routes to `notice-codes.ts` + dictionary.
- Preferences (`preferences.ts`): query > cookie > header; `?lang=` / `?theme=` set `multix-lang` / `multix-theme` (`Path=/; Max-Age=31536000; SameSite=Lax; Secure`); theme rendered as `html[data-theme]`, auto = no attribute. Zero new scripts.
- Copy script reads localized messages from `#copy-status` data attributes → new hash (constant used by CSP; CSP otherwise unchanged).
- Routes: dashboard, r2-settings, oauth-authorize, github-sign-in pass prefs + cookies. `src/index.ts` touched minimally for `/api/docs` prefs.

## Verification
- `npm run lint`: pass (595 files).
- `npm run build` + `npm run check:mcp`: 24 files / 417 tests pass, wrangler dry-run ok, bundle check clean.
- New `worker/test/dashboard-shell.test.ts` (23 tests): language negotiation, cookie/query priority, theme → `data-theme`, switch markers, VI consent page, translated notices, sidebar/ids, no old tokens, onboarding states, escaping.
- axe-core 4.10.2 on 24 variants (6 pages × en/vi × light/dark): 0 serious/critical. 360px width: scrollWidth 356, no horizontal scroll.
- Screenshots: `/private/tmp/claude-502/-Volumes-GOON-claude-multix-cli-dashboard-shell-027184/a0b57e4d-e4f3-47f5-b5a7-457270923d2d/scratchpad/shots/` (desktop `desk-*.png`; mobile `m-*.png` are cropped by headless Chrome min width; overflow verified in browser pane instead).

## Open concerns
- Message pages (errors, signed-out) have no language/theme switch; they follow cookie/header.
- "Key saved" onboarding step counts any saved name, incl. a lone `CLOUDFLARE_ACCOUNT_ID`.
- Switching language on the one-time new API key page navigates away from the shown key (GET reload); key text warns already.
- No sync with docs-site `starlight-theme` localStorage (would need a script).
- Copy script hash changed — deploy updates CSP and script together, no action needed.
- Stray `npx biome` fetched unrelated npm package `biome@0.3.3` into the npx cache (not executed against repo, not in lockfile).

## Unresolved questions
- Should message pages get the preference switches too?
