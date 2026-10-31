# Confirmed brief: website & dashboard redesign

Confirmed 2026-10-28. Approved demo: `advise-261028-1128-hero-obsidian-palette-demo.html` (palette Mono).

**Objective:** Redesign multix.zuey.me (new EN/VI landing in the Cinematic Obsidian art direction with the Mono palette: layered deep black, volumetric light, film grain, frosted glass, Geist + Instrument Serif italic; hero with a dot-grid 3D digital head that reacts to hover/click and unlocks four senses `--see` / `--hear` / `--speak` / `--create`; cursor spotlight, light 3D tilt, case-study videos; headline "Give every AI agent eyes, ears, a voice — and imagination." with the subline "Unlock multimodal for every AI agent"; new Starlight docs theme) and the MCP dashboard (new app shell, same behaviour) on one shared token set, with EN/VI auto-detection, an Auto/Light/Dark theme switch, the positioning "the multimodal layer for AI agents", and UX/AX/SEO/GEO optimisation. Then run /ak-enhance-ux-ax and apply its proposals.

**Done means:**
- `npm run lint`, `typecheck`, `build`, `test`, `verify:docs` and `check:mcp` pass, and CI on the PR is green.
- A grep finds none of the old colour tokens.
- The EN and VI landing pages score at least 95 in all four Lighthouse mobile categories.
- axe reports no serious or critical violations, in light and dark, on the landing page, one docs page and the dashboard.
- The digital head is rendered from a mesh made with multix, using plain WebGL. It turns to follow the cursor and ripples on hover. A click or tap runs the eyes → ears → mouth → crown unlock sequence. With reduced motion, without WebGL or without JS, only a poster is shown.
- A browser set to Vietnamese goes to /vi/ on its first visit. A manual language choice is remembered. Bots see the English page, with correct hreflang.
- The dashboard is shown in Vietnamese based on Accept-Language and can be switched between EN and VI.
- A three-state theme switch works on the landing page, the docs and the dashboard, with no colour flash on load.
- The cursor spotlight and 3D tilt run on desktop and turn off under reduced motion.
- The case-studies section shows every video in the user's list, each with a poster, loading only on click, and with VideoObject JSON-LD.
- The PR includes before/after screenshots for desktop and mobile, light and dark, EN and VI.
- The PR targets main and contains `Closes #<issue>`. The isolated review is clean, and the issue carries the `done` label.

**Out of scope:**
- Merging or deploying to production.
- Publishing to npm.
- Changing docs content.
- New routes or backend features.
- Three.js or any other 3D library.
- Producing new case-study videos.

**Constraints:**
- Dashboard routes, forms and field names stay as they are, the dashboard works without JS, and every interpolated value goes through `escapeHtml`. The CSP widens only through script hashes.
- Docs keep their `.md` pages, `llms.txt`, i18n and search.
- No design token from the current version is reused.
- Fonts are self-hosted.
- Motion effects appear on the landing page only.
- API spend: at most 3 images and 3 3D generations on Atlas Cloud, each preceded by a `--dry-run`.
- Follow AGENTS.md.

**Stop and ask only if:**
- An action would be destructive or irreversible.
- A change would alter a Done-means item or leave the repository.
- Spending would go past the limit above.
- A failure stays unexplained after asking the advisor.
- A credential has expired.
