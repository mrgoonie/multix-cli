# Code review: feat/site-obsidian-redesign vs main (#405)

Reviewer: isolated code-reviewer (did not write the code). Date: 2026-10-28.

## Scope
- `git diff main...HEAD`: 76 files, +6434/-393, 18 commits. Docs site (`docs-site/`), dashboard (`worker/src/pages/*`, `worker/src/routes/*`, `worker/src/index.ts`), tokens generator, tests, plan/report artefacts.
- Out of diff: `src/`, `tests/` (CLI) untouched.

## Verification run
| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | 1 error, only in untracked local `.claude/launch.json` (not in branch; environmental) |
| `npm run check:mcp` (worker typecheck, 418 worker tests, bundle check) | pass; bundle clean of `node:*`/commander/execa |
| `npm run build --prefix docs-site` | pass; 12 inline script hashes written to `_headers`; expected route-collision warnings for `/` and `/vi` (static landing beats Starlight catch-all, by design) |
| `node --test` in docs-site (22 tests) | pass (incl. CSP-covers-every-inline-script test) |
| `astro check` (docs-site) | 0 errors, 0 warnings, 0 hints |
| `npm test` (root) | 13 timeouts in scene/agent-mode/budget-guard/gemini-upload; files not touched by branch; machine load avg ~190; rerun in isolation still flaky on timeouts -> environmental, not a branch regression |
| COPY_SCRIPT_HASH vs sha256(COPY_SCRIPT) | recomputed, matches |
| Old colour literals from main reused | only `#fff` inside the landing favicon data-URI SVG; none in CSS |

## Hard-constraint checklist
- Routes/forms/field names: unchanged (diffed every `<form>`/`<input name>`/`<button name>`; notice codes preserved and now typed via `notice-codes.ts` with compile-time coverage of `R2SettingsProblem`/`R2AccessResult`).
- No JS needed: switches are plain links; theme rendered server-side as `data-theme`; copy buttons hidden without `.js`. OK.
- `escapeHtml`: all interpolations checked. Dictionary functions that return HTML (`welcome`, `stepSignInDone`, `notYou`, `heading`, `newHeading`, `bucketLine`, ...) escape their arguments; plain-text ones (`consent.title`, `notInvitedBody`) are escaped by the caller (`htmlDocument` title, `messagePage`). No double escaping, no raw user value found.
- CSP (`worker/src/http-responses.ts`): unchanged except the recomputed copy-script hash. OK.
- `switchHref`/`selfPath`: output is always `pathname + search` of a URL resolved against a fixed dummy origin, so protocol-relative or absolute `here` values collapse to a path; values are fixed allowlists (`en|vi`, `auto|light|dark`) before being stored. `here` is a constant (`/dashboard`, `/api/docs`) except consent, where it is the request's own `/oauth/authorize?...` (path route is exact-match). No open redirect. Cookie attrs `Path=/; Max-Age=1y; SameSite=Lax; Secure`, value allowlisted -> no header injection. Preference-via-GET is "CSRF-able" only to change cosmetic prefs; acceptable.
- Just-created API key: switches suppressed (`here: undefined`) so a reload cannot lose/re-POST it. OK.
- Site: theme resolved in a blocking inline head script; vi redirect skips bots/webdriver and any stored `multix-lang`; reduced motion and no-WebGL/fetch failure keep the poster; `.md` variants, `llms.txt` (now with H1), sitemap, hreflang, Pagefind for docs pages all present in build.

## Findings

### Medium

**M1. Explicit English choice in the docs is overridden by the vi auto-redirect**
- `docs-site/src/components/landing/landing-head.astro:122-128`, `docs-site/src/components/starlight/SiteTitle.astro:6-11`
- Only the landing page's EN/VI links write `localStorage["multix-lang"]`. Starlight's own language picker does not. Scenario: browser with `navigator.languages[0] = "vi"` opens `/vi/getting-started/`, picks English in Starlight's language select (an explicit choice), lands on `/getting-started/`, then clicks the header brand (now links to `/`) -> the head script finds no stored choice and `location.replace("/vi/")`. Same for every "Back to home" on English docs pages and the 404 "Back to home" link. The user cannot reach the English landing page without first finding the landing nav's EN link.
- Fix: also record the choice from the docs side, e.g. a tiny hashed inline script on Starlight pages that sets `multix-lang` from `document.documentElement.lang` whenever the visitor is on a non-landing page reached via the language picker; simpler: set `multix-lang` on any docs page view (`localStorage.setItem("multix-lang", <page lang>)` if unset), or only redirect when `document.referrer` is not same-origin (true first visit). Add a test case to `landing-output.test.mjs`.

**M2. WebGL context loss leaves an empty hero**
- `docs-site/src/scripts/landing/hero-renderer.ts:186-190, 435`; `docs-site/src/components/landing/landing.css:396-399`
- Once `.is-live` is set the posters go to `opacity:0`. No `webglcontextlost` handler exists. Mobile Safari/Chrome drop contexts on GPU reset, memory pressure or long backgrounding; the canvas then renders nothing and the poster stays invisible -> blank LCP area until reload.
- Fix: `canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); cancelAnimationFrame(raf); stage.classList.remove("is-live"); canvas.remove(); if (button) button.hidden = true; })` (restoring the poster is enough; re-init is optional).

### Low

**L1. Light-theme token values duplicated by hand for the no-JS docs case**
- `docs-site/src/styles/custom.css:52-86` repeats the light values of `tokens.css` (and the `--sl-*` ramp of lines 30-42). No test asserts they stay in sync (`docs-theme-output.test.mjs:30` only checks the media query exists). Next token change silently diverges for no-JS light-preferring visitors. Fix: generate this block from `tokens.css` at build time, or add a test that parses both and compares the `--mx-*` values.

**L2. Latent CSP gap for case-study players**
- `docs-site/scripts/write-security-headers.mjs:44` has no `frame-src`/`media-src`; `default-src 'self'` will block the `youtube-nocookie.com` iframe and off-origin `<video>` that `landing-main.ts:84-108` creates. `caseStudies` is empty today, so no live break; the comment in `case-studies-data.ts:8-9` relies on someone remembering. Fix: add a test that fails when `caseStudies` has a non-self host not present in the CSP, or derive `frame-src`/`media-src` from `caseStudies` in the header script.

**L3. Landing copy-button result not announced to screen readers**
- `docs-site/src/scripts/landing/landing-main.ts:75`: success only swaps the button's text; no live region (the dashboard uses `#copy-status` with `aria-live`). Failure is swallowed with no feedback. Fix: add a visually hidden `role="status"` element and write the copied/failed message to it.

**L4. 404 page hard-codes the Mac shortcut**
- `docs-site/src/pages/404.astro:26` shows `⌘ K` to everyone; Windows/Linux need Ctrl K (Starlight's own button adapts). Fix: say "the search button" or render both.

**L5. Hero point cloud is not reproducible from the repo**
- `docs-site/scripts/hero/sample-head-points.mjs:6` requires a `<head.glb>` that is not committed and whose source/licence is not recorded. Regenerating `public/hero/*` is impossible for other contributors. Fix: record the model source, licence and the exact command in the script header or the plan.

## Positive risk-calibration notes
- Notice texts moved from routes to typed dictionaries with compile-time coverage checks; route behaviour unchanged.
- `withPreferenceCookies` appends rather than sets, so the session-clear and consent cookies are preserved alongside preference cookies (verified in `dashboard-routes.ts` and `oauth-authorize-routes.ts`).
- `design-tokens.ts` generation rejects quotes/backslashes and is guarded by a sync test.

## Plan follow-up
- Acceptance points in scope appear implemented; M1/M2 should be fixed before ship. CLI root-suite timeouts should be re-run on an idle machine for PR evidence.

## Unresolved questions
1. Is bouncing an English-docs reader back to `/vi/` acceptable product behaviour (M1), or should any docs visit count as a language choice?
2. Licence/source of the head model used for the point cloud (L5)?
