# Code review: PR #203, copy buttons on MCP Worker HTML pages

Branch `feat/mcp-dashboard-copy-buttons` (f5447f1), isolated review, 2026-10-14.

## Scope
- Files: worker/src/http-responses.ts, worker/src/pages/{copy-script,copy-button,page-layout,dashboard-page,api-keys-card,api-docs-page}.ts, worker/test/{copy-buttons.test,copy-script-helpers,dashboard-storage-and-keys.test,oauth-flow.test}.ts
- LOC: +144 / -16 (against merge-base 3a446fc)
- Checks: `npm run lint` clean (401 files). `npm run check:mcp`: worker typecheck OK, 15 files / 179 tests pass, bundle check clean.

## Verdict
Mergeable. No Critical or High findings. The CSP is correct and fails safe. Two Medium accessibility/UX items and a few Low ones are worth fixing, but none of them blocks.

## Verified (evidence)
- **Hash matches what is served.** I recomputed SHA-256 over the `COPY_SCRIPT` literal pulled from the built `worker/dist/index.js` (not only the TS source): `sha256-rYBys3NS7eSR2TIVxiHPfsDLmeLEeTOwbWdGKiQ6Tck=`. It equals `COPY_SCRIPT_HASH`, and it is the only `sha256-` in the bundle. The script is pure ASCII, has no `</script`, no `${` and no backslashes, so the template literal value is the source text byte for byte.
- **No other script is allowed.** `script-src` holds only the hash. There is no `'unsafe-inline'`, `'unsafe-hashes'` or `'strict-dynamic'`, so inline `on*=` handlers and `javascript:` URLs stay blocked. `default-src 'none'`, `frame-ancestors 'none'` and `base-uri 'none'` are unchanged. The test at copy-buttons.test.ts:9-17 pins the exact `script-src` directive.
- **One CSP for all pages.** It is set in one place (http-responses.ts:20, applied at :46). `page()` adds the script once (page-layout.ts:76). Existing "no other script" tests now strip only the exact hashed block (copy-script-helpers.ts) before asserting `<script`/`on*=` absence, so an injected second script would still fail them.
- **Consent page.** It now runs the script, but the script only adds the `js` class and listens for clicks on `[data-copy]`. The page has no copy buttons, so nothing changes there. Framing is still denied.
- **XSS.** `copyField`/`copyBlock` escape the value, label and id (copy-button.ts:14,20,25). All callers pass server-side values: the generated key, `view.mcpUrl`, static OpenAPI paths, and the curl text built from the origin. Copied text is `input.value`/`pre.textContent`, which is the decoded, visible text, so there is no hidden-text paste-jacking.
- **API key page.** The script makes no network calls, does no logging and uses no storage. The clipboard is written only inside the click handler. `id="new-api-key-value" readonly value=` keeps its attribute order, so the regex in rest-api.test.ts:35 still matches. The page is still `no-store`.
- **JS off or CSP mismatch.** `.copy-btn{display:none}` stays hidden unless the script sets `.js` (page-layout.ts:51-52). If the hash ever drifts, the buttons disappear instead of breaking.
- **Layout.** The wrap uses `min-width:0`. The `pre` keeps `overflow-x:auto` and the button is positioned on the wrap, so it stays put while long curl lines scroll. Input height is about 40px with a 30px button centred, and the 44/48px right padding keeps text from going under the button. I found no mobile-width regression from reading the CSS. Not checked in a browser.

## Critical
None.

## High
None.

## Medium
1. **The "Copied" / "Copy failed" result is not reliably announced.** copy-script.ts:30-31 only rewrites the focused button's `aria-label`. NVDA and JAWS usually do not announce a label change on an element that already has focus, and VoiceOver does so inconsistently. Screen-reader users get no confirmation, and on failure they never hear the "select it by hand" instruction.
   - Fix: add one visually hidden `<span role="status" aria-live="polite" class="sr-only"></span>` in `page()` and set its `textContent` from the script. This changes the script text, so the hash must be updated too.
2. **The failure path removes the selection it tells the user to make by hand.** copy-script.ts:28 calls `selection.removeAllRanges()` even when `execCommand("copy")` returned false. The user is then told "select the text and copy it by hand", but the selection has just been cleared.
   - Fix: clear the selection only when `copied` is true.

## Low
3. **The export example copies a placeholder** (api-docs-page.ts:75). Pasting `export MULTIX_API_KEY=mxk_…   # …` sets the variable to the literal `mxk_…` (with a non-ASCII ellipsis), which then fails with a 401 that is hard to diagnose. Consider `export MULTIX_API_KEY=<paste key>` or dropping the button on this block.
4. **Curl examples copy `<id>` path placeholders** (api-docs-page.ts:23). In a shell these become input redirects (`< id`), producing "no such file" or a wrong request. This text existed before, but a copy button makes pasting it more likely. Consider `$KEY_ID` or `{id}`.
5. **The script runs on pages with no copy buttons** (consent and message pages). It is harmless, but those pages lose their previous no-JS guarantee. Optional: add a `page(title, body, { copy: true })` flag. The CSP can stay shared.
6. **Execution order on Safari.** `execCommand("copy")` runs after an awaited rejection (copy-script.ts:20-27). Safari may treat the user gesture as used up by then, so the fallback can fail where a synchronous fallback would work. It is only reached when `writeText` rejects, which should be rare on HTTPS.
7. **Tests.** Nothing asserts that the dashboard, API key notice or `/api/docs` actually render `copy-wrap` with `data-copy`, so a refactor could silently drop the buttons. The script's behaviour has no DOM test. That is acceptable for 30 lines, but item 2 would have been caught by one.
8. **Stale branch base.** `git diff origin/main..HEAD` also shows `tests/unit/providers/atlascloud/prediction-runner.test.ts` losing its 30 s timeout. That comes from main moving ahead (2a0605f, #193), not from this PR, and the three-dot diff is clean. Rebase onto main before merge so CI runs against current main.

## Edge cases checked
- Clicking the SVG or path inside the button: `closest("[data-copy]")` handles SVG targets.
- `navigator.clipboard` undefined (non-secure context): the TypeError is caught and the fallback runs.
- Double clicks: the timer is reset through `clearTimeout(button._copyTimer)`, and the original label is restored. A second click made while the label reads "Copied" captures "Copied" as `label`. Because `clearTimeout` cancels the first timer's restore, the button stays "Copied" for good. This is a minor bug and could be fixed by storing the original label in a `data-label` attribute at render time.
- Rendering of HTML entities: `textContent` decodes `&#60;` back to `<`, so the copied text is correct.
- Docs: I found no "pages run no JavaScript" claim in README, docs-site, worker/README or skill, so there is no docs drift.

## Recommended actions
1. Fix the double-click label bug (Edge cases above) together with Medium 2. Both are in copy-script.ts, then update the hash.
2. Add an `aria-live` status region (Medium 1).
3. Rework or remove the placeholder copy on the export and `<id>` examples (Low 3-4).
4. Add one render test per page that asserts `data-copy` is present (Low 7).
5. Rebase onto main.

## Metrics
- Type check: pass. Lint: 0 issues. Worker tests: 179/179. Bundle check: clean. Coverage: not measured.

Status: DONE_WITH_CONCERNS
Summary: The CSP hash is correct, matches the bundled script and allows nothing else. XSS escaping and API key handling are sound, and lint and check:mcp are green.
Concerns: Copy results are not announced to screen readers, the failure path clears the selection it asks the user to make, double clicks permanently leave the label as "Copied", and the placeholder examples copy text that does not work.

## Unresolved questions
- Should the consent page keep a strict no-JS guarantee (opt-in script per page), or is one shared script acceptable?
- Was the layout checked in a real browser at about 360px width and in dark mode? This review only read the CSS.
