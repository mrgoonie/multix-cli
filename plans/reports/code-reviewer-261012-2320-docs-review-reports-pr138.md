# Code review: PR #138 (docs/review-reports, closes #137)

Head: `e4de41c627fab1fbbac958cc3f10cc92b31cd96a`. The local worktree `analyze-prioritize-issues-bd4592` is on this commit. I verified files on the branch directly. Bash was unavailable, so I used the GitHub API for the file list and checks.

## Scope
- `AGENTS.md` (+15/-2) and 31 new `plans/reports/code-reviewer-*.md` files. Docs only.
- CI on the head commit: 6/6 green (CI on Node 20/22 for ubuntu and windows, MCP Worker, Documentation site).

## 1. AGENTS.md claims vs repo

| Claim | Evidence | Verdict |
|---|---|---|
| `release-please.yml` merges its own release PR | `.github/workflows/release-please.yml:77-81` runs `gh pr merge … --squash`, then the second release-please run and the publish at `:88-120` | Accurate |
| `!` or `BREAKING CHANGE:` publishes a major version | `release-please-config.json:10` `bump-minor-pre-major: false` with version 1.0.9. 1.0.0 was cut this way (CHANGELOG:71-76) | Accurate |
| "every merge into `main` with a `feat` or `fix` commit publishes" | `changelog-sections` makes `docs`, `perf` and `refactor` visible (`release-please-config.json:24-29`). The CHANGELOG shows releases cut from those types alone: 0.7.2 is Documentation only (the AGENTS.md commit #57), 0.5.1 and 0.5.2 are Documentation only, 1.0.1 is Changed only (refactor), and 0.15.1 is Performance only | **Inaccurate (incomplete). See H1** |
| Node 20.19+ / 22.12+ for tests (vite) | `package-lock.json:2864-2882` vite 8.3.1 has `engines.node: "^20.19.0 \|\| >=22.12.0"`. vitest 4.1.11 is `^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0` | Accurate |
| CLI still supports Node ≥ 20 | `package.json:25-27` `"node": ">=20"` | Accurate |
| `check:mcp` script and its description | `package.json:43` runs worker typecheck, then test, then `check:bundle`. `worker/scripts/check-bundle.mjs:13-24` forbids `node:*`, bare built-ins, `commander`, `execa` and the `src/cli.ts` marker | Accurate |
| `npm ci --prefix worker` / `--prefix docs-site` | `worker/package-lock.json` and `docs-site/package-lock.json` exist | Accurate |
| `redact()` in `src/core/redact.ts` | `src/core/redact.ts:10` `export function redact` (the old text pointed at `env-loader.ts`) | Accurate (fix) |
| `worker/` is not published | `package.json:18-24` `files` excludes `worker`, and `worker/package.json` is `private: true` | Accurate |
| 14-day dependency age rule, report naming pattern | Policy statements. All 31 files match `code-reviewer-<yymmdd>-<hhmm>-<slug>.md` | OK |

## 2. Secret and PII sweep over the 31 reports

I ran regexes for `sk-`, `AIza`, `r8_`, `eyJ`, `Bearer <token>`, `-----BEGIN`, standalone 32-hex strings, `ghp_`/`github_pat_`/`xox*`/`AKIA`, `Signature=`/`sig=`/`token=`/`key=<value>`, email addresses, `*_API_KEY=`/`*_TOKEN=`/`*_SECRET=` with a value, `Authorization:`, `workers.dev`, URLs with query strings, long base64/hex runs, and `C:\Users` / `AppData`.

- **No secrets, signed URLs, tokens, real account or gateway IDs, or email addresses.** Every hit is benign: placeholder env names (`REPLICATE_API_TOKEN="  "`, `CLOUDFLARE_ACCOUNT_ID=attacker`), userinfo test vectors (`http://user:pass@evil.com`, `queue.fal.run@evil.example`), URLs already redacted (`https://cdn/x.mp4?[redacted]`), git commit SHAs, and agent worktree IDs.
- Local paths: 18 reports name `D:\www\oss\multix-cli\.claude\worktrees\agent-*` in their header. These are harmless repo paths. See L1 for the one username.

## 3. Markdown
- All 31 files start with a `#` heading.
- Code fences are balanced in every file (counts are 2 or 4).
- `AGENTS.md` renders correctly. Line 70 is a blank line that splits the bullets into two lists (L2).

## Findings

### High
- **H1. The publish trigger is understated, and merging this PR will itself publish an npm release.** `AGENTS.md:47-50` says only `feat` and `fix` commits publish. With `docs`, `perf` and `refactor` visible in `changelog-sections`, those types also cut releases: 0.7.2 came from a `docs:` AGENTS.md commit. PR #138 is a `docs:` commit, so merging it should produce 1.0.10 and publish it to npm under `latest`. The tarball content does not change, because `plans/` and `AGENTS.md` are not in `files`. Contributors following the rule as written will be surprised.
  - Fix the text: "every merge into `main` with a `feat`, `fix`, `perf`, `refactor` or `docs` commit (any type with a visible changelog section in `release-please-config.json`) publishes a new npm version. `chore`, `ci`, `build`, `test` and `style` do not."
  - For this PR, decide whether a docs-only release is acceptable. If it is not, retitle the commit as `chore:` before squash-merging.

### Medium
- None.

### Low
- **L1.** `code-reviewer-261011-1830-legacy-env-pr70.md:45` quotes `C:/Users/<user>` as the example home directory. It is a generic account name, but it is a real local username. Replace it with `C:/Users/<user>` if you want zero host details.
- **L2.** `AGENTS.md:67-75`: the stray blank line at 70 splits one bullet group into two lists. Line 69 ("install `worker/` dependencies before `check:mcp`") repeats the inline comment on line 64. This is cosmetic.

## Unresolved questions
- Is an automatic 1.0.10 npm publish from this docs-only merge intended? (H1)

Status: DONE_WITH_CONCERNS
Summary: Approve after fixing the docs. The reports contain no secrets or PII, the Markdown is sane, and every AGENTS.md claim checks out except the publish-trigger statement. Findings: Critical 0, High 1 (docs, feat and other visible types also publish, so this PR triggers a release), Medium 0, Low 2.
