# Review: PR #130 remove unused `undici` dependency (closes #127)

Head `11d08a55ab00164a96053a0f6d2524f4fb3bee9b`. The local checkout `agent-abebc59a5162abc73` has its branch ref at this SHA.
The Bash tool returned no output in this session, so local npm commands could not be run. The checks below come from reading files, the GitHub API, and CI.

## Scope
- `package.json`: -1 line (`"undici": "^7.2.0"` removed from `dependencies`)
- `package-lock.json`: -10 lines (root `packages[""].dependencies.undici` removed, plus the `node_modules/undici` 7.25.0 entry)

## Verification
- **No code uses undici.** I searched `src/`, `tests/`, `worker/src`, `docs-site/src`, `skill/`, configs and `dist/cli.js` for `undici`, `Dispatcher`, `setGlobalDispatcher` and `ProxyAgent`. The only hits are comments: `src/core/fetch-error.ts:7` and the comments and test names in `tests/unit/commands/doc-convert.test.ts:13`, `tests/unit/providers/replicate/client.test.ts:15` and `tests/unit/core/worker-safe-http.test.ts:345`. These describe the built-in fetch error shape (Node's fetch runs on undici internally), so they are correct with or without the package. There are no imports, `require` calls, dynamic imports or type imports.
- **Build config does not refer to undici.** `tsup.config.ts` has no `external` or `noExternal` entry for it, and `tsconfig`, `biome` and `vitest` configs don't mention it. Because nothing imports undici, tsup will not suddenly bundle it now that it is no longer a dependency.
- **Lockfile is consistent.**
  - Root `packages[""].dependencies` (lines 11-16) has `commander`, `dotenv`, `execa` and `zod`, which matches `package.json` exactly.
  - No other package in the lock depends on `undici`, so removing it leaves nothing orphaned.
  - `undici-types` 6.21.0 (line 2270, `dev: true`) stays correctly as a dependency of `@types/node` (line 1059).
  - The `"peer": true` flags are kept, as the PR intends.
  - The `docs-site/` and `worker/` lockfiles keep their own transitive `undici`. They are separate packages, and keeping it there is correct.
- **`npm ci` accepts the lockfile.** `ci.yml:78` runs `npm ci`, which fails when the lockfile and `package.json` disagree. That job passed on Node 20.x/ubuntu and Node 22.x/ubuntu.
- **Docs.** `README`, `docs-site` content and `skill/SKILL.md` don't mention undici. The only mentions are in old plan and report files under `plans/260502-1544-*` and `plans/reports/`. Those are historical records, and `cook-260502-1544-implementation.md:21-23` already records the switch to `globalThis.fetch`. No update is needed.
- **CI** (check-runs API):
  - Passed: Node 20.x/ubuntu, Node 22.x/ubuntu, MCP Worker, Documentation site.
  - Still running when checked: both Windows jobs.

## Findings
- Critical: 0
- High: 0
- Medium: 0
- Low: 0 in this diff.

Pre-existing, not caused by this PR, and should get its own issue rather than widening this one: `package.json` declares `main: ./dist/index.js`, `types: ./dist/index.d.ts` and an `exports["."]` entry. But `tsup.config.ts` only builds `src/cli.ts` with `dts: false`, so the published package exports files that are never built.

## Verdict
**APPROVE**, as long as the two Windows CI jobs finish green. The change is minimal, matches its stated scope, and leaves the lockfile in sync.

## Unresolved questions
- Did the Windows CI jobs (Node 20.x and 22.x) pass? They were still running when this review was written.
- I could not run `npm ci --dry-run` or `npm ls` locally because the shell was unavailable. Passing `npm ci` on ubuntu CI is the stand-in evidence.
