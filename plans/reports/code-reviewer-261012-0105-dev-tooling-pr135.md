# Code review: PR #135, vitest 2 to 4.1.11 (Refs #128)

- Branch: `chore/dev-tooling-advisories`, head `5a7cbad`
- Read-only checkout: `.claude/worktrees/agent-a6514841ae3b1c762` (HEAD is `refs/heads/chore/dev-tooling-advisories`)
- Reviewer: isolated; I did not write this change.
- Tooling limits: Bash returned nothing for every command, including `echo`, so I could not run `npm ls`, `npm ci`, the tests, or `npm view`. I also hit the WebFetch session limit partway through. The evidence below comes from reading the lockfiles directly, the GitHub API (fetched before the limit), and the registry `time` document for vitest.

## Scope

4 files: `package.json` (+1/-1), `worker/package.json` (+1/-1), `package-lock.json` (+822/-662), `worker/package-lock.json` (+753/-1006). The source code, the two vitest configs, and CI are unchanged.

## Verdict

**APPROVE, conditional on the two Windows CI jobs going green.** I found no blocking defects. The lockfile changes stay within the vitest/vite chain, and every resolved URL and integrity hash is well formed. The config keys still mean the same thing under vitest 4, and the CI test step still applies `MULTIX_DISABLE_HOME_ENV`.

## Critical

None.

## High

None.

## Medium

1. **AGENTS.md still says the contributor baseline is "Node ≥ 20", but running the tests now needs a newer Node.** The lock pins `vite@8.3.1` with `engines: ^20.19.0 || >=22.12.0` and `vitest@4.1.11` with `engines: ^20.0.0 || ^22.0.0 || >=24.0.0`. A contributor on Node 20.0–20.18, 21, or 23 gets an `EBADENGINE` warning, and vite/rolldown may fail at runtime. There is no `.npmrc` with `engine-strict`, so the install still succeeds.
   - The published CLI is not affected: `engines.node >=20` is unchanged, and vite is dev-only.
   - CI is not affected: `20.x` and `22.x` resolve to the latest patch releases, and the release and publish workflows use Node 24.
   - Fix: add one line to AGENTS.md under "Verification before review", or open a follow-up issue: "running the tests needs Node ^20.19 or >=22.12".

## Low

2. **I could only confirm one publish date directly.** `vitest@4.1.11` was published on 2026-08-18T14:27Z, 55 days before review. The date for `vite@8.3.1` could not be fetched (the registry document is over 10 MB). Rolldown, postcss, lightningcss and the rest were not checked because of the fetch limit. The `--before=2026-09-28T16:59:59Z` cutoff is exactly 14 days before 2026-10-12, and npm applies it to every package it resolves, including transitive ones, so the policy should hold. Still, I have not verified it independently beyond vitest.
3. **vitest 5 was skipped without a stated reason.** The 5.x line already has releases older than 14 days: 5.0.0 (2026-09-03), 5.0.1 (2026-09-15) and 5.0.2 (2026-09-25). Choosing 4.1.11 (the `V4` dist-tag) is defensible as the smaller jump, but the PR should say so. Otherwise the next upgrade comes sooner than readers expect.
4. **The hand-restored `"peer": true` flags match the baseline by name, but I could not check them with npm.** The root lock flags exactly the same 6 entries as the vitest-2 baseline lock: `@types/node`, `esbuild`, `picomatch`, `postcss`, `typescript`, `vite`. The worker lock has no peer flags. `npm ci` ignores these flags, and the CI `npm ci` steps passed on ubuntu for root and worker. Whether npm 10 would compute the same set for the new tree (for example, whether `rolldown` or `lightningcss` should also be flagged) was not checked. Worst case, a contributor's next `npm install` rewrites some lock lines. There is no install or runtime impact.
5. **Pre-existing, made more visible: coverage is configured but cannot run.** `vitest.config.ts` sets `coverage.provider: "v8"` with a 70% lines threshold, but `@vitest/coverage-v8` is not in the lock. vitest 4 also changed v8 coverage to AST-based remapping, so the numbers will change once it is installed. CI does not run coverage. Not caused by this PR, so no action needed here.
6. **Pre-existing: root tests are not type-checked.** The root `tsconfig.json` includes only `src/**`, so typing changes in vitest 4 (for example, the `Mock<Fn>` generics) are not caught in `tests/`. The worker type-checks its tests through `tsconfig.test.json`, and that CI job passed.

## Lockfile checks

- **Ranges and root entries.** The ranges are `^4.1.11` in the root and the exact pin `4.1.11` in the worker, matching the worker's existing exact-pin style. Both lock root entries agree with their `package.json`.
- **Registry and integrity.** Root: 195 `resolved`, all on `https://registry.npmjs.org/`, and 195 `sha512` integrity hashes. Worker: 254 of each.
- **What changed.**
  - Root bumps are all in the vitest/vite chain: `@vitest/*` 4.1.11, vite 8.3.1, rolldown 1.2.11 (with `@rolldown/binding-*` and `@oxc-project/types` 0.151.0), lightningcss 1.33.0, postcss 8.5.13→8.5.28, nanoid 3.3.12→3.3.19, picomatch 4.0.4→4.0.7, tinyglobby 0.2.16→0.2.17, chai 6.2.2, std-env 4.2.0, es-module-lexer 2.3.2, obug, tinyrainbow 3.1.1, and a nested `vitest/node_modules/tinyexec@1.3.1`.
  - The tsup and build chain is unchanged: tsup 8.5.1, esbuild 0.27.7, rollup 4.60.2, top-level tinyexec 0.3.2.
  - `vite-node` and `tinypool` are gone.
  - Worker: vite 5's esbuild 0.21.5 and rollup 4.64.5 are gone. The only esbuild left is `wrangler/node_modules/esbuild@0.28.1`.
- **Advisory list.** `source-map-js@1.2.1` is still in both locks, as the PR says. Root esbuild stays at 0.27.7 because tsup declares `esbuild: ^0.27.0`, which confirms the PR's explanation. The wrangler, miniflare and docs-site advisories are left out of scope, as stated. I could not verify the publish date of source-map-js 1.2.2 or the wrangler 4.149.0 claim.

## vitest 4 behaviour checks (could tests pass or skip silently?)

- **Root config.** `globals`, `environment`, `include: ["tests/**/*.test.ts"]` and `test.env.MULTIX_DISABLE_HOME_ENV` are all still valid keys in v4. The CI step also sets the variable. `poolOptions`, `workspace` and `environmentMatchGlobs` are not used, so the removed keys are not a problem. The default pool is still forks with isolation.
- **Worker config.** Only `environment` and `include` are set. Both are unaffected.
- **Mock semantics (v3/v4).** `restoreAllMocks` now only restores `spyOn` targets.
  - `complete-jobs-stagger.test.ts` calls `waitForJob.mockClear()` explicitly, so it does not depend on the old behaviour.
  - `speech-interactions.test.ts` uses `mockReset()` on a bare `vi.fn()`. The new mockReset behaviour (falling back to the original implementation) has nothing to change there.
  - I found no test that uses the removed third-argument options object (`it(name, fn, {…})`).
- **Test counts.** The PR reports 1134 passed / 8 skipped (67 files / 3 skipped) for the root and 52 / 3 for the worker, the same as the baseline. That rules out silently dropped files. I could not re-run the suites locally.

## CI (as of the last fetch)

| Check | Result |
|---|---|
| Node 20.x / ubuntu | success |
| Node 22.x / ubuntu | success |
| MCP Worker | success |
| Documentation site | success |
| Node 20.x / windows | in progress |
| Node 22.x / windows | in progress |

## Unresolved questions

1. Did the two Windows jobs pass? Confirm before merging.
2. Why vitest 4.1.11 rather than 5.0.2, which is also older than 14 days? Note the reason in the PR.
3. Should the contributor Node floor (^20.19 / >=22.12) go into AGENTS.md now, or into a follow-up issue?
