# Code review: documentation impact rule in AGENTS.md (#485)

- Commit: 309927c `docs(agents): require a documentation impact check for every change`
- Scope: AGENTS.md only (+40/-1). No other files touched.
- Issue: mrgoonie/multix-cli#485 (fetched via `gh api`; GraphQL `gh issue view` is blocked here)

## Verdict

DONE_WITH_CONCERNS. Acceptance criteria are met in structure and the
existing rules are intact, but two factual claims in the new text are wrong
or incomplete when checked against the repo. The rule tells agents to put
accuracy first, so these should be fixed before merge.

## Acceptance criteria

| Criterion | Result |
|---|---|
| General mandatory rule covering internal, public and agent-facing docs | Met (heading "required for every change", three surface groups) |
| Concrete locations: README, docs-site EN/VI, skill/SKILL.md, plans/, CLI help | Met, but the CLI help path and the skill path are incomplete (H2, M1) |
| PR `Documentation impact` section, justified N/A, follow-up issue for deferred work | Met (rules bullet 4, plus cross-reference in the PR bullet on line 68) |
| Prioritize correctness, language parity, existing verification over noise | Met ("Accuracy over volume", "No noise", EN/VI together, `npm run verify:docs`) |
| Existing workflow, tests, release rules intact; no unrelated changes | Met. The only edit to existing text is the line-68 bullet, which keeps `Closes #<n>` |

## Findings

### H1 (High): llms.txt is not derived from the content sources

New text: "The build derives each page's agent-readable `.md` route and
`llms.txt` from these sources, so edit the source, not the output."

- `.md` routes: true. `docs-site/src/pages/[...slug].md.ts` and `index.md.ts`
  serve the raw `src/content/docs/**/*.md` files. `llms-full.txt.ts` also
  derives from them.
- `llms.txt`: false. `docs-site/src/pages/llms.txt.ts` returns one
  hand-written string with a title and a one-line summary for each English
  page. Adding, renaming or removing a page, or changing what a page covers,
  means editing that file by hand. `docs-site/tests/site-output.test.mjs`
  ("llms.txt links every English page") catches missing or extra links but
  not outdated summaries.
- Impact: an agent who trusts the text will skip `llms.txt.ts`. A new page
  then fails `verify:docs`, and a changed scope leaves a wrong summary that
  nothing catches. This is the agent-facing index of the public site.
- Fix: for example, "The build serves each page's raw `.md` route and
  `llms-full.txt` from these sources; `llms.txt` is a hand-maintained index in
  `docs-site/src/pages/llms.txt.ts`, so update its entry when you add, rename,
  remove or re-scope a page."

### H2 (High/Medium): most `--help` strings are not in `src/commands/**`

New text: "command `--help`/usage strings in `src/commands/**`".

- Help text is defined with commander `.description()`/`.option()`. Grep finds
  these calls in 11 files under `src/commands/` and 138 files under
  `src/providers/*/commands/` (all 16 providers have a `commands/` directory).
  Most provider command help, which is what most changes touch, is outside the
  path the rule names.
- Fix: "in `src/commands/**` and `src/providers/<name>/commands/**`".

### M1 (Medium): only the entry skill is named; nested task skills are not

The new text names only `skill/SKILL.md`. The repo also ships task skills in
`skill/<name>/SKILL.md` (image-generation, video-production,
speech-production, media-qa, document-conversion, 3d-generation). AGENTS.md
line 126 already describes them, and the Worker bundles them as MCP skills.
A change to a task workflow should update the matching task skill.
- Fix: "`skill/SKILL.md` and the task skills in `skill/<name>/SKILL.md`".

### L1 (Low): screenshots from the issue's accuracy list are missing

The issue lists "snippets and screenshots". The accuracy bullet says
"snippets" only. `docs-site/public/images/` exists and the overview banner is
tested. Optional.

### L2 (Low): "Docs are part of done" overlaps with the `done` status label

"done" is also the status label that means "PR opened" (line 24). The
sentence still reads correctly, but "Docs are part of finishing a change"
avoids the overlap. Optional.

### Info: this `docs` commit will publish an npm release

The existing rule (lines 72-75) says a `docs` commit on `main` publishes a new
npm version. This change affects contributors only. `chore(agents)` would not
cut a release. Earlier AGENTS.md changes all landed inside feat/fix commits,
so the repo sets no precedent. The issue title suggests `docs(agents)`, so
this is the maintainer's choice. Raise it before merge, but do not block on it.

## Verified claims (no action)

- Heading anchors resolve under GitHub's slug rules (lowercase, punctuation
  stripped, spaces become hyphens): `#documentation-impact-required-for-every-change`
  matches `### Documentation impact (required for every change)`, and
  `#verification-before-review` matches the existing `## Verification before review`.
  No duplicate headings.
- `https://multix.zuey.me` matches `site` in `docs-site/astro.config.mjs`. The `vi`
  locale is at `src/content/docs/vi/`.
- `npm run verify:docs` maps to `npm run verify --prefix docs-site`
  (astro check, build, node tests). The test "every published English page has
  Vietnamese and Markdown counterparts" backs the claim that a missing VI or
  `.md` counterpart fails. The prerequisite `npm ci --prefix docs-site` is in the
  linked section.
- No `.github` PR template exists, so the PR-body rule needs no template change.
- No repo-level `docs/` directory exists. Calling `plans/`, AGENTS.md and
  `.env.example` the internal surfaces is accurate. Separating finished plans
  and reports as historical records matches the existing plans convention.
- Wording and format: imperative bullets, lines within 80 columns, H3 placed
  under `## Documentation`, consistent with the file. No duplicated
  provider-specific instructions.

## Recommended actions

1. Correct the llms.txt claim and point to `docs-site/src/pages/llms.txt.ts` (H1).
2. Add `src/providers/<name>/commands/**` to the help-string location (H2).
3. Name the nested `skill/<name>/SKILL.md` task skills (M1).
4. Optional: add screenshots, reword "part of done", consider `chore` vs `docs` commit type.

## Unresolved questions

- Should a contributor-only AGENTS.md change cut an npm release (`docs`), or
  use `chore`? This is the maintainer's call.
