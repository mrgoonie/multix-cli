# Code review: 846e19c, hero spin and providers section

Branch `feat/site-obsidian-redesign`. Reviewer did not write the code.

## Scope
- Runtime: `docs-site/src/scripts/landing/head-spin.ts`, `head-cloud.ts`, `landing-main.ts`
- Markup/CSS: `landing-hero.astro`, `landing-page.astro`, `landing.css`, `landing-providers.astro`, `landing-providers.css`
- Data: `landing-providers-data.ts`, `landing-copy.ts`
- Generator: `scripts/hero/draw-head-dots.mjs`, `read-glb.mjs` (skimmed; offline only)
- Tests: `tests/landing-output.test.mjs`
- Skipped: binaries, `head-dots.svg` and `head-cloud.bin` contents, plans/ HTML previews

## Verification run
- `npm run build` (docs-site): pass, `_headers` CSP has 12 inline script hashes
- `npm test` (docs-site): 23/23 pass, including the CSP coverage test
- `npx astro check`: 0 errors / 0 warnings
- `npx biome check` on touched dirs: clean
- Headless Chromium against `dist/` (playwright-core + cached Chrome for Testing): hit testing, overflow, reduced motion, no-JS, theme switch, CPU cost. Results below.

## Findings, ranked

### High

**H1. The canvas overhang covers the hero CTA buttons and takes their clicks (mobile and tablet)**
`landing.css:375-381` (`.mx-head-canvas { inset: -8%; width/height: 116% }`), together with `head-spin.ts:43-47` (canvas appended inside `.mx-head-art`) and `landing-main.ts:169` (a click on `.mx-head-art` toggles unlock).
- In the single-column layout (below 900px) the stage sits right under `.mx-cta`, and the hero gap is only `--mx-space-4` (16px). The canvas reaches 8% of the stage width (up to ~43px) above the stage. It is positioned and comes later in the DOM, so it paints above the non-positioned CTA row.
- Measured with `elementFromPoint`:
  - 800x1000: `.mx-head-canvas` covers the whole "Connect MCP" button and the right part of the install button.
  - 360x740: it covers the bottom ~6px of "Connect MCP".
- Failure scenario, reproduced: at 800px width, clicking the centre of "Connect MCP" does not navigate. `url` stays `/` and the stage gets `is-unlocked`. Users on tablets and narrow desktop windows cannot reach the MCP guide from the hero. Keyboard activation still works, so this is a pointer and touch problem only.
- Fix, either of:
  - (a) `.mx-hero-copy { position: relative; z-index: 1; }` so the copy column paints above the overhang.
  - (b) set `pointer-events: none` on `.mx-head-canvas` and attach the pointer and drag listeners to `.mx-head-art`. `toStage` already measures `art`, so the overhang stops capturing input.
- Add a regression check: in an e2e or headless test, assert that `elementFromPoint` at the centre of each `.mx-cta .mx-btn` returns that button at 800px and 360px widths.

### Medium

**M1. The provider data now comes from root `src/`, but the docs deploy only runs on `docs-site/**` changes**
`landing-providers-data.ts:1-17` (the header says the page "cannot drift from what multix ships") and `.github/workflows/deploy-docs.yml:4-7` (`paths: docs-site/**`).
- Failure scenario: a PR adds a provider or changes a default model (for example `DEFAULT_OPENAI_IMAGE_MODEL`) and touches only `src/`. CI rebuilds the site and passes, but nothing deploys it. The live page keeps showing the old provider count, the old cards and the old "N providers" copy until an unrelated docs-site change is merged.
- Also, if a `src/` change removes a model id that `listed()` names, the landing build throws. CI catches this, because the docs job runs on every PR to main, so it is not silent.
- Fix: add the imported paths to the `deploy-docs.yml` paths filter: `src/capabilities/**`, `src/providers/**/models.ts`, `src/providers/**/model-ids.ts`, `src/providers/**/speech-defaults.ts`, `src/providers/provider-keys.ts`. A broad `src/**` also works. Or drop the "cannot drift" claim.
- Checked: none of the 23 files imported transitively from root `src/` has a bare package import, so `npm ci --prefix docs-site` alone is enough for the build.

**M2. The spin loop costs a steady share of the main thread while the hero is visible**
`head-spin.ts:204-235` (the loop runs forever while it is playing and on screen), `head-spin.ts:91-135` (rebuilds ~10k+ Path2D arcs or rects per frame), `head-cloud.ts:274` (`rotate([...])` allocates two arrays per visible dot per frame).
- Measured in headless Chrome, desktop 1280px, idle and not unlocked:
  - CPU x1 (Apple silicon): ScriptDuration 8.6% and TaskDuration 10.8% of wall time.
  - CPU x4 throttle: 36% script and 46% task.
  - Mobile (30 fps cap): 4.4% at x1, 18% at x4.
- On 120/144 Hz desktops, `draw()` runs every frame because only `coarse` pointers get the 30 fps cap, so the cost roughly doubles. Low-end laptops will drain battery and feel slower to the touch (INP) while someone reads the hero.
- The loop does stop correctly when offscreen, when the tab is hidden, when paused, and under reduced motion (verified).
- Suggestions:
  - Cap `draw()` at 30 fps for every pointer type, since the head turns once in 40 s and 30 fps looks the same.
  - Inline the normal rotation in `project()` instead of calling `rotate()`; the yaw and pitch sines are already computed there.
  - Optionally redraw only when the yaw changes by more than a small step.

### Low

**L1. A user who unlocks before the canvas loads sees the senses switch off and light up again when the canvas swaps in**
`head-spin.ts:301-304`. `stage.classList.add("has-canvas")` (line 328) triggers the MutationObserver. The stage is already `is-unlocked`, so `unlockedAt` resets, while `levels` start at 0. The SVG showed every sense fully lit, and the first canvas frame shows none of them, so the "first frame matches the SVG" promise (line 326) breaks in this case. Any later class change on the stage while it is unlocked would also restart the sequence.
- Fix: before the first `draw()`, set `levels` to 1 when the stage is already unlocked. Update `unlockedAt` only when `is-unlocked` actually flips (track the previous value).

**L2. The hidden SVG keeps running its infinite pulse animations under the canvas**
`landing.css:429-435`. Once `has-canvas` is set, `.mx-head` has `opacity: 0`, but when the stage is unlocked the `.mx-fx-wave` and `.mx-fx-spark` elements still run the `mx-pulse` animation forever. This is small but wasted style and animation work on top of M2.
- Fix: `.mx-stage.has-canvas .mx-head { visibility: hidden }` or `display: none`, or scope the animation to `:not(.has-canvas)`.

**L3. The pause button announces its new state only through a changing `aria-label`**
`head-spin.ts:285-299`. Some screen readers do not re-announce a changed name on a focused button. The usual pattern is a stable label ("Pause rotation") plus `aria-pressed`. Keyboard operation works (verified: Enter changes it to "Resume rotation", state paused). WCAG 2.2.2 is met.

**L4. The overhang is clipped on the right side on desktop**
`landing.css:248` (`.mx-hero { overflow-x: clip }`) at 1280px: the canvas reaches x=1306, so ear arcs or sparks that land in the overhang at the far right are cut off. There is no page overflow (scrollWidth equals clientWidth at 360, 800 and 1280). This is cosmetic only.

**L5. The baked assets cannot be rebuilt from the repo**
`draw-head-dots.mjs:9-10`: the source mesh is "not kept in the repository". `head-cloud.bin`, `head-dots.svg` and `head-anchors.json` can only be regenerated by whoever has the GLB. Record where the mesh comes from and its licence (see Unresolved questions).

**L6. The test re-parses TS source with regexes**
`landing-output.test.mjs:123-135` re-derives command groups and provider names from TS source with regexes. This duplicates the build-time checks and breaks easily on formatting changes (for example a group name with a hyphen, which `[a-z0-9]+` does not match). It is acceptable as a cross-check, but it is the first thing that will break on unrelated refactors.

## Constraint checklist
- CSP: no new inline scripts. `head-spin` is a same-origin dynamic chunk (`script-src 'self'`), and the fetch of `/hero/head-cloud.bin` is covered by `connect-src 'self'`. Inline `style=""` attributes (sense anchors, SVG `--w`) are allowed by `style-src 'self' 'unsafe-inline'`. The CSP hash test passes. OK.
- No JS: the inline SVG renders (opacity 1), and the unlock and spin buttons stay `hidden`. No overflow at 360px. OK.
- Reduced motion: no canvas, no fetch of `head-cloud.bin` or `head-spin`, spin button stays hidden, unlock still works without stagger or pulse. OK.
- Canvas is `aria-hidden` inside the `role="img"` wrapper, whose `aria-label` comes from `headAlt` (en and vi). OK.
- Horizontal overflow: none at 360, 800 or 1280. The providers row on phones scrolls inside its own container, and its negative margin matches the `.mx-wrap` padding (`--mx-space-4`). OK.
- Listener and rAF leaks: the landing is an MPA with no ClientRouter. The observers are never disconnected, but they live as long as the page. The loop stops offscreen, when hidden and when idle. OK.
- Theme: `mx-themechange` fires on manual switch and on a system scheme change, and `readInk` re-reads it (verified: ink is `rgb(10,11,13)` after a dark to light switch). OK.
- Provider data: 14 cards, matching the 14 provider command groups in `COMMAND_CAPABILITIES` (`doc` counted under Gemini, `speech` and `scene` excluded). Models are imported defaults or are checked by `listed()`. The rendered modalities look consistent with the source. The count went from a hard-coded 17 to a derived 14, and no other "17 providers" claim is left in README, skill or docs-site src. OK.
- Secrets: none. Env-backed getters are not called. OK.

## Recommended actions
1. Fix H1 (z-index on `.mx-hero-copy`, or move pointer handling to `.mx-head-art` with `pointer-events:none` on the canvas), and add a hit-test regression check.
2. Widen the `deploy-docs.yml` paths filter to the root `src/` files the landing imports (M1).
3. Cap the draw rate at 30 fps everywhere and drop the per-dot allocations in `project()` (M2).
4. L1 and L2 are cheap follow-ups. L3 to L6 are optional.

## Unresolved questions
- Where does the head GLB come from, and does its licence allow shipping a derived point cloud and SVG? It is not in the repo, and nothing records its provenance.
- Is fal's card showing only TTS models (no image or video pick) intended? The selection comment says "one per model family", but every pick is speech.

Status: DONE_WITH_CONCERNS
Summary: One high finding, confirmed in a browser: below 900px the canvas overhang sits on top of the hero CTA buttons and takes their clicks, so "Connect MCP" toggles the senses instead of navigating. Also medium issues: docs deploy does not run on the root src changes the page now depends on, and the spin loop has a steady CPU cost. CSP, no-JS, reduced motion, overflow and provider data all check out.
