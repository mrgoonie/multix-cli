# Code review: llms.txt command pages (#230)

Scope: `docs-site/src/pages/llms.txt.ts`, `docs-site/tests/site-output.test.mjs` (uncommitted diff, +15/-2).

## Verified
- URLs: `commands/{fal,atlascloud,replicate,runway}.md` match source files in
  `docs-site/src/content/docs/commands/` and the built `dist/commands/*.md` routes.
- Ordering: ElevenLabs -> fal.ai -> Atlas Cloud -> Replicate -> Runway -> HeyGen matches
  `astro.config.mjs` sidebar lines 89-94.
- Titles match front matter (`fal.ai commands`, `Atlas Cloud commands`, `Replicate commands`,
  `Runway commands`).
- Descriptions match the page bodies and front matter:
  - fal: `run` any queue model + `image`/`video` with defaults (page also has `status`/`result`, not mentioned; acceptable).
  - atlascloud: image, video, audio, 3D, `run`, `status --wait` resume. "resumable predictions" is correct (the page says there is no cancel endpoint, and the entry does not claim cancel).
  - replicate: `run`, `image`, `video`, `status`, `cancel`. Correct.
  - runway: Gen-4.5 / Gen-4 Turbo video, Gen-4 image (incl. Turbo), `status`, `cancel`. Correct.
- Test: reads the source dir with the same `new URL(..., import.meta.url)` pattern the file already uses
  (README/banner reads), asserts non-empty, checks the exact `(https://multix.zuey.me/commands/<slug>.md)`
  link form, gives a per-slug failure message. Ran it against the current dist: passes. The non-recursive
  readdir is correct because `commands/` has no subdirectories. Including `.mdx` is harmless, since there are no .mdx pages and `[...slug].md.ts` only globs .md.
- Style: the same string-literal format, entry shape, and terminology as the existing entries. Biome is clean according to the caller.

## Blocking
None.

## Optional / follow-ups (out of scope for #230; open separate issues)
1. `documentationRoutes` in `site-output.test.mjs` (lines 7-28) still omits `commands/fal` and
   `commands/atlascloud`, so their EN/VI .md/.html emission and CSP inline-script hashes are not tested.
2. `llms.txt` also omits `guides/mcp-server` and `reference/output-and-troubleshooting` (both are in
   `documentationRoutes`). The new test only covers `commands/`, so other doc sections can drift the same way.
3. The test does not check ordering against the sidebar. That is acceptable, because ordering is cosmetic.

Status: DONE
