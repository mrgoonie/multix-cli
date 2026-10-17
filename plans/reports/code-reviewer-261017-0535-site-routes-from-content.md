# Code review: 9f9c37a, llms.txt pages and site routes derived from content (#241)

## Scope
- Files: `docs-site/src/pages/llms.txt.ts` (+3 entries), `docs-site/tests/site-output.test.mjs` (hand-written route list replaced by a list read from the content tree; llms.txt test widened from commands/ to all English pages)
- LOC: +14 / -31
- Verified independently: the derived route list has 23 entries and built `dist/llms.txt` has 23 `- [` entries. The derived set is exactly the 20 old routes plus `commands/fal`, `commands/atlascloud` and `guides/rest-api`. The caller's run of `npm run verify` (8/8) was not repeated.

## Overall
Correct and small. The change fixes the issue as described and removes the drift that caused it. Nothing blocking.

## Checks

| Concern | Result |
|---|---|
| index → "index" mapping | `index.md` becomes `"index"`. The counterparts test and the CSP loop already special-case `"index"` to `index.html` / `vi/index.html`. Same behaviour as before. |
| Windows separators | `replaceAll("\\", "/")` runs before the `vi/` filter and the slug use. This is correct. The docs tests only run on ubuntu (CI `docs` job, `deploy-docs.yml`), so it is defensive but harmless. |
| Directory entries | Recursive `readdir` also returns directory names (`commands`, `vi`, ...). The `.md` filter drops them. `!startsWith("vi/")` cannot wrongly drop a name like `video.md`. |
| Sorting | Deterministic. Order does not matter to any test that uses the list. |
| .md only (old llms test used `/\.mdx?$/`) | Acceptable. `src/pages/[...slug].md.ts` and `llms-full.txt.ts` glob only `**/*.md`, so an `.mdx` page would get no `.md` route anyway. The filter matches what the site actually publishes. |
| Non-page .md files | None in `src/content/docs` today. Only `root` and `vi` locales exist (`astro.config.mjs`). |
| Node support for recursive readdir | `fs.promises.readdir({recursive:true})` exists since Node 20.1 / 18.17. The docs tests run only on Node 22.x (`ci.yml` `docs` job, `deploy-docs.yml`); root vitest includes only `tests/**/*.test.ts`. The CI 20.x matrix never runs these tests. Local check: Node 22.22. |
| Top-level await | The test file is ESM. If the read fails, the whole file fails loudly, which is correct. |
| Vietnamese counterparts test | Still makes sense and is now stricter: the vi/ pages for fal, atlascloud and rest-api are now required. All three exist. |
| CSP hash loop | Now covers 23x2 pages + 404 (was 20x2 + 404). The new pages are now checked against the CSP hashes, which is a real coverage gain. |
| llms.txt test strength | `includes("(https://multix.zuey.me/${route}.md)")`. The leading `(` and trailing `)` stop false matches such as `commands.md` inside `commands/...`. The `includes("commands/gemini")` guard catches an empty list. |
| Description accuracy | MCP: "Deploy ... to Cloudflare Workers for remote AI agents, with OAuth and per-account provider keys" matches the page's frontmatter and its sections (Deploy, Accounts and credentials, OAuth/GitHub sign-in). REST API: "Account API keys, provider keys and R2 storage, CLI job runs, and signed job webhooks" matches the H2s (Create an API key, Provider keys, R2 storage, Run a job and poll it, Job event webhooks / Verify signatures). Troubleshooting: "Prerequisite checks, generated file locations, and common CLI failures" matches Verify the local setup / Output files / Common fixes. The page's "Image format" section is not mentioned, which is fine. |
| Ordering vs sidebar | llms.txt follows the sidebar: Start here, Commands (fal, Atlas Cloud placed between ElevenLabs and Replicate as in the sidebar), Guides (MCP, REST API), Reference (Environment, Output and troubleshooting, For AI agents). |
| Commit type | `docs(site)` publishes a patch release under release-please, as the AGENTS.md table says. It is a docs change, so this is acceptable. |

## Critical / High
None.

## Medium
None.

## Low (optional)
1. The check runs in one direction only. Every content page must be in llms.txt, but an llms.txt link to a deleted or renamed page would still pass. If wanted, add a reverse check: parse every `https://multix.zuey.me/(.+)\.md` in llms.txt and assert that it is in `documentationRoutes`.
2. A future nested `commands/index.md` would derive route `commands/index`, while Starlight publishes `commands/`. The tests would then fail loudly, not silently, so this does not need a fix now.
3. Out of scope, not caused by this commit: the hard-coded provider list in "provider pages retain command caveats" omits fal, atlascloud, replicate and runway, although `reference/for-ai-agents.md` links all of them. If wanted, open a separate issue; do not widen this PR.

## Plan / issue follow-up
The acceptance points of #241 are met: llms.txt links the three missing pages, and the route list can no longer drift from the content tree.

## Unresolved questions
None.

Status: DONE
Summary: The commit fixes #241 correctly. The derived routes match the content tree exactly (23 routes, 23 llms.txt entries), are compatible with the index special cases and the Node 22 docs CI, and the three new descriptions and their order match the pages and the sidebar.
Findings: blocking: none. Optional: a reverse llms.txt link check; a nested-index slug edge case (would fail loudly); a separate issue for the stale hard-coded provider list in another test.
