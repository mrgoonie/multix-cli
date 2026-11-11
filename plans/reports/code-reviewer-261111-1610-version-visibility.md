# Code review: PR #587 feat: show the multix version in the dashboard and multix check

Closes #586. Reviewer: isolated code-reviewer. Date 2026-11-11.

## Scope
- Files (7, +16/-3): `src/commands/check.ts`, `worker/src/pages/page-layout.ts`, `worker/src/pages/page-styles.ts`, `worker/test/dashboard-shell.test.ts`, `worker/test/mcp-tools.test.ts`, `docs-site/src/content/docs/commands.md`, `docs-site/src/content/docs/vi/commands.md`
- Note: local `main` is stale; `git diff main` shows 1.26.1 release files. PR base (origin/main 11c5c52) diff is exactly the 7 files above.

## Verification run
- `npm run check:mcp`: worker typecheck ok, 32 files / 613 tests pass, `check-bundle: 1 file(s) clean`.
- Bundle inspection (`worker/dist/index.js`): JSON import tree-shaken to `var version2 = "1.26.1";`, one var shared by `mcp-api-handler.ts` and `page-layout.ts`. No `devDependencies`, scripts, `tsup`, `dist/cli.js` strings from package.json in bundle (the "AI multimodal CLI" hit comes from bundled SKILL.md, pre-existing). No harm.
- `mcp-api-handler.ts:21` already does `import { version } from "../../package.json"` on main; new import is the same pattern (path `../../../package.json` correct for `src/pages/`).
- `node dist/cli.js check`: first non-empty line `  multix 1.26.1`. `check --json`: envelope still valid, version line lands in `text`, no stdout pollution outside the envelope.
- Biome on touched files: clean. CI on PR: all 6 checks pass.
- Root `vitest run tests`: 4 failures under full parallel load (model-job-identity, scene, fal run-helpers); same 3 files pass 100/100 in isolation. Timing flakes, unrelated to this diff.

## Overall assessment
Small, correct, low-risk. No blocking defects. A few non-blocking polish items.

## Critical
None.

## High
None.

## Medium
1. `src/commands/check.ts:178` - no test covers the new first line of `multix check`. The worker side got tests, the CLI side (an explicit goal of #586) did not. Add a smoke assertion, e.g. in `tests/smoke/cli.test.ts`: run `check --json` with `MULTIX_DISABLE_HOME_ENV=1` and assert `text` starts with `multix ${pkg.version}`. (Live Gemini call must not run; with no key it is skipped, as the manual run showed.)

## Low
1. `worker/src/pages/page-styles.ts:36` - `.brand` already has `gap:var(--mx-space-2)`; adding `margin-left:6px` doubles spacing (~14px) between pill and version, inconsistent with the mark/text/pill spacing. Drop `margin-left` or use a smaller explicit gap.
2. `worker/src/pages/page-layout.ts:69` - no whitespace between `</span>` of `.brand-tag` and `<span class="brand-version">`. Flex items get blockified so most AT read "multix MCP v1.26.1", but accname whitespace for inline-flex children is not guaranteed; a literal space (`</span> <span ...>`) costs nothing. The `title` on a non-focusable span inside the link is redundant (screen readers read the text, keyboard users never see the tooltip); harmless, could be removed.
3. Sidebar fit: desktop sidebar content width is 264px - 2*space-4. Stable versions (`v1.26.1`) fit. A prerelease string (`v1.27.0-beta.3`, a beta release-please config exists) would make the non-wrapping inline-flex brand wider; deploy only runs from `main`, so stable-only in practice. Optional: `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0` on `.brand-version`. Mobile (<900px) top bar: `.sidebar .brand{margin-right:auto}` with `flex-wrap:wrap` absorbs the extra ~60px fine. Focus header (`.focus-top`, flex-wrap, space-between) fine.
4. `worker/test/mcp-tools.test.ts:12` - `toMatch(/^\d+\.\d+\.\d+/)` would pass with a hard-coded wrong version. Prefer `toBe(version)` imported from `../../package.json`, as the dashboard test does.
5. `worker/test/dashboard-shell.test.ts:236` - asserts against the same imported value the code uses, so it proves wiring and rendering, not value correctness; acceptable for this purpose.

## Trust boundaries / escaping
- `version` is a build-time constant from the repo's package.json, not user input; still passed through `escapeHtml()` in both text and `title` attribute (escapeHtml handles quotes per existing usage). Follows the file's "every interpolated value must go through escapeHtml()" rule.
- Exposing the deployed version on the unauthenticated sign-in page and MCP `initialize` is a minor fingerprinting surface; MCP `serverInfo.version` already exposed it before this PR, and the repo is public OSS. Acceptable.

## Docs / AGENTS.md conventions
- en and vi `commands.md` updated together; vi wording accurate. Claims verified: `multix --version` exists (`src/cli.ts:21`), dashboard sidebar and sign-in header render it, MCP serverInfo carries it. Text says "dashboard sidebar"; it is also on the sign-in header (minor omission, fine).
- No i18n strings added (version is not translatable; "multix" literal unchanged). OK.
- `llms.txt` unaffected (no page added/renamed). README/skill: `multix check` description in `skill/SKILL.md` needs no change.
- Commit `feat:` publishes a minor release on merge; appropriate for a visible feature.
- Issue #586: assigned, claimed with branch, label `in review`. PR body has `Closes #586` and Documentation impact section.
- PR body's OpenRouter note (#583 follow-up) is descriptive only; fallback behavior is already documented in `docs-site/src/content/docs/commands/openrouter.md:25-30` from #584. No code in this PR; fine, slight scope noise in the body.

## Recommended actions (non-blocking)
1. Add CLI smoke test for the version line (Medium 1).
2. Remove `margin-left:6px` and add a space before `.brand-version` (Low 1, 2).
3. Tighten MCP version assertion to `toBe(version)` (Low 4).

## Unresolved questions
- Should the version line in `multix check` stay at `info` (blue, indented) or be a plain header line? Cosmetic, author's call.

## Blocking findings
None.

Status: DONE
Summary: PR #587 is correct; worker bundle passes and tree-shakes package.json to the version string only, escaping and docs (en/vi) are accurate. Only non-blocking polish: missing CLI test for the check version line, double spacing in CSS, weak MCP version assertion.
