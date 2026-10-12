# Code Review: PR #70, feat(core): opt-in loading of legacy .claude env files (closes #22)

## Scope
- PR head: `feat/legacy-claude-env` @ `3e5724c` (OPEN, +195/-17). The local worktree is at the same commit.
- Files: `src/core/env-loader.ts`, `src/commands/check.ts`, `tests/unit/core/env-loader.test.ts`, `README.md`, `.env.example`, `docs-site/src/content/docs/{,vi/}reference/environment.md`
- Focus: precedence, trust boundary, Windows paths, home==cwd dedup, `check` flag test, test isolation, docs accuracy
- Gates run locally (Node 22.23.2): `tsc --noEmit` clean, `biome check .` clean (206 files), `npm run build` OK, full vitest suite 41 files, 381 passed, 4 skipped. No paid API calls.
- Empirical probes ran against `dist/cli.js check -v` in throwaway temp dirs, with a scrubbed env and `MULTIX_DISABLE_HOME_ENV=1`. No secret values were printed.

## Overall Assessment
The core loader is correct and small. Precedence works as documented: process.env > cwd/.env > ~/.multix/.env > legacy project layers > legacy home layers, all with `override:false`. The flag is read after the first two files load, so it can live in either of them. Docs anchors resolve. No blocking defects. The weak spots are: (1) `check` uses a different flag test than the loader, (2) the dedup compares paths case-sensitively on Windows, (3) the project-level legacy files widen how much of the repo controls the env, which the docs do not mention, and (4) the agent-facing `skill/SKILL.md` was not updated, although AGENTS.md requires it.

## Critical Issues
None.

## High Priority
None.

## Medium Priority

### M1. `check` hint uses a presence test, while the loader uses `isTruthy`
- `src/commands/check.ts:150` uses `if (!process.env.MULTIX_LEGACY_CLAUDE_ENV)`. `src/core/env-loader.ts:47-49,74` uses `isTruthy` (`1/true/yes/on`).
- Verified failure: with `MULTIX_LEGACY_CLAUDE_ENV=0` or `=false` and a `.claude/.env` present, the loader skips the file and `check` stays silent. The user explicitly set the flag to "off", so the docs line "mentions legacy files it finds while the flag is off" (EN `environment.md:45`, VI `:44`) is false for those values. The same mismatch applies to typos like `=ture`: nothing is loaded and no hint is shown. Empty `=` (the `.env.example` default) works because `""` is falsy.
  - Probe output: `flag=undefined` -> hint shown. `"0"` -> no hint. `"false"` -> no hint. `""` -> hint shown. `"1"` -> file loaded.
- Fix: export one predicate from env-loader and use it in both places, e.g. `export function legacyClaudeEnvEnabled(): boolean { return isTruthy(process.env.MULTIX_LEGACY_CLAUDE_ENV); }`. Then `check.ts:150` becomes `if (!legacyClaudeEnvEnabled())`. While there, export the home-dir resolution (`MULTIX_DISABLE_HOME_ENV ? undefined : os.homedir()`), which is duplicated at `check.ts:151` and `env-loader.ts:64`. Add a unit test for `"0"`, `"false"` and `" TRUE "`.

### M2. Project legacy files widen the cwd trust boundary, and a global flag turns this on for every directory
- `src/core/env-loader.ts:41-44,74-76`, with docs at EN `environment.md:34-37`.
- Threat model: cwd/.env is already fully controlled by whatever repo you run in, so this PR adds no new class of attack. It does add four more cwd-controlled files under `.claude/`, a directory that repos routinely commit (Claude Code settings, skills). Users rarely audit it the way they look at a root `.env`. And `.env` gitignore rules do not protect a repo whose author wants to ship the file.
- Concrete scenario: a user keeps `FAL_KEY` only in `~/.claude/.env` (the exact migration case from #22) and sets `MULTIX_LEGACY_CLAUDE_ENV=1` once in `~/.multix/.env`. They clone an untrusted repo containing `.claude/skills/ai-multimodal/.env` with `FAL_BASE_URL=https://attacker.example`. Project legacy layers load before home legacy layers, so `FAL_BASE_URL` is filled from the repo and `FAL_KEY` from home. The next `multix fal ...` sends the user's key to the attacker. `LEONARDO_BASE_URL` and `BYTEPLUS_BASE_URL` work the same way (`src/providers/*/client.ts`). Proxy and TLS vars (`HTTPS_PROXY`, `NODE_TLS_REJECT_UNAUTHORIZED`) can also be injected. The Codex child process is safe because `sanitizeCodexEnv()` is used (`codex-image-driver.ts:115`). ffmpeg, magick and cwebp inherit the full env.
- These files also load whole generic `.claude/.env` files. Those are shared with other tools, so unrelated secrets (e.g. `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`) end up in `process.env` and in non-Codex child processes.
- Fix (pick one, the first is preferred):
  1. Allowlist what legacy layers may set: parse with `dotenv.parse` and copy only known multix keys (provider keys, model overrides). Exclude `*_BASE_URL`, `NODE_*` and proxy vars from legacy files.
  2. At minimum, add a sentence to both docs pages: legacy project files are trusted like `cwd/.env`, so enable the flag only in trusted projects or set it per project rather than in `~/.multix/.env`.
- Keeping project layers is consistent with the #22 compatibility request, so this does not block the PR. The trade-off belongs to the maintainer.

### M3. `skill/SKILL.md` not updated (AGENTS.md requirement; this is the AgentKit-facing surface #22 came from)
- `skill/SKILL.md:51` still says `Priority: process.env > cwd/.env > ~/.multix/.env` and does not mention the flag.
- `skill/SKILL.md:326` describes `MULTIX_DISABLE_HOME_ENV` as "skip `~/.multix/.env`". After this PR it skips every home-directory file, including `~/.claude/**` (`env-loader.ts:12-13,64`). The doc is now stale.
- Fix: add a `MULTIX_LEGACY_CLAUDE_ENV` row and the legacy sentence to SKILL.md, and update the `MULTIX_DISABLE_HOME_ENV` description.

## Low Priority

### L1. home==cwd dedup is case-sensitive on Windows
- `src/core/env-loader.ts:43` uses `path.resolve(home) !== path.resolve(cwd)`. Verified: `path.resolve('c:/Users/admin') === path.resolve('C:/Users/admin')` is `false`. `process.cwd()` often has a lowercase drive letter (VS Code terminals, some shells), while `os.homedir()` comes from `USERPROFILE` with an uppercase one. Folder-name case can differ too.
- Effect: running from home on such a shell loads home legacy files twice. Values are unaffected (`override:false`), but `check -v` lists duplicates and the `check` hint count doubles. Symlinks and junctions (OneDrive-redirected profiles) also slip through.
- Fix: normalize before comparing, e.g. `const norm = (p) => { const r = path.resolve(p); return process.platform === "win32" ? r.toLowerCase() : r; }`. Or use `fs.realpathSync.native` inside a try/catch. Alternatively, dedup the final file list with a `Set` of normalized paths. That also covers a cwd nested so that `cwd/.claude` and `home/.claude` coincide.

### L2. `loadFile` reports files as loaded even when dotenv failed to read them
- `src/core/env-loader.ts:51-55`: `existsSync` is true for a directory or an unreadable file. dotenv 16.6.1 catches the read error and returns `{ error }`. Verified: a directory at `.claude/skills/.env` shows up under "Env files loaded" in `check -v`.
- Fix: `const r = dotenvConfig(...); if (!r.error) loadedFiles.push(file);`. Optionally log `r.error.code` at debug level, without values.

### L3. Test gaps
- `tests/unit/core/env-loader.test.ts:72-115`: `MULTIX_DISABLE_HOME_ENV=1` is global (`vitest.config.ts`), so `loadEnv` never reaches the home branches. Untested paths:
  - home legacy layers through `loadEnv`
  - the flag being honored from `~/.multix/.env`
  - home==cwd dedup through `legacyClaudeEnvFiles(x, x)`, a pure call that is easy to add
  - `ai-multimodal` beating `ak-ai-multimodal`
  - `isTruthy` variants
  - the `check` hint
- Suggested fix: the pure function test should include the `legacyClaudeEnvFiles(p, p)` and case-variant cases. For the home branch, inject `home` into `loadEnv` via an internal parameter or spy on `os.homedir`, then temporarily delete `MULTIX_DISABLE_HOME_ENV` inside the test and restore it afterwards.
- Isolation is otherwise sound. The `process.cwd` spy is restored by `vi.restoreAllMocks()`, `VARS` are deleted both before and after each test, and the temp dir is removed. One residual issue predates this PR but is now amplified: the top-level `loadEnv is idempotent` test (`:35`) runs with the real repo cwd. If a developer exports `MULTIX_LEGACY_CLAUDE_ENV=1` in their shell, the repo's own `.claude/**/.env` (if any) is loaded into the test process. Deleting the flag in the outer `beforeEach` would close this.

### L4. Docs nits
- The EN `:40` and VI `:39` lists put both skill dirs in item 1 joined by "and", but the code gives `ai-multimodal` priority over `ak-ai-multimodal`. Say so explicitly or split them into separate items.
- The docs do not say that the flag is ignored when set inside a legacy file itself. A migrating user may put it in `~/.claude/.env` and see nothing happen. One clause would fix it.
- The README (`:98`) is accurate.
- Anchors verified with the docs-site's own `github-slugger`: `Legacy \`.claude\` env files` -> `legacy-claude-env-files` and `File env \`.claude\` cũ` -> `file-env-claude-cũ`. Both the heading and the link use precomposed U+0169 (bytes `c5 a9`), so the VI link `#file-env-claude-cũ` resolves in Starlight. Note: docs-site has no link validator (`astro check` / build / node tests only), so this was checked by hand.

## Edge Cases Found by Scout
- The flag can come from process.env, cwd/.env or ~/.multix/.env. Precedence works as intended: a cwd `=0` overrides a home `=1`.
- `MULTIX_DISABLE_HOME_ENV` uses a truthiness check (`"0"` still disables). This predates the PR but is now copied into `check.ts`.
- dotenv 16.6.1 defaults `quiet: true`, so the extra files do not add `[dotenv] injecting env` lines to stdout. Bumping to dotenv 17 would make it log by default and break piped or JSON output. Consider passing `quiet: true` explicitly in `loadFile`.
- `-v` prints absolute paths, which include the OS username. They are paths only, no values. Acceptable.

## Positive Observations (risk calibration)
- `override:false` holds for every layer, and a test proves process.env wins.
- Values are never logged. `getLoadedEnvFiles` returns a copy.
- The legacy feature is off by default, which matches the #22 requirement.

## Recommended Actions
1. M1: share one `legacyClaudeEnvEnabled()` predicate between `check.ts` and the loader, and add tests.
2. M3: update `skill/SKILL.md` lines 51 and 326 and add the flag row.
3. M2: allowlist legacy-file keys, or at least add a trust warning to both docs pages. This is the maintainer's call.
4. L1/L2: normalize paths for dedup and only record files that dotenv actually read.
5. L3/L4: fill the test gaps and clarify the docs.

## Metrics
- Type errors: 0. Lint issues: 0. Tests: 381 passed / 4 skipped. Coverage not measured in this run.

## Unresolved Questions
- Did the legacy AgentKit Python backend rank project files above home files, and `ai-multimodal` above `ak-ai-multimodal`? #22 does not specify an order, so the PR's order could not be checked against the original.
- Does the maintainer want legacy layers restricted to multix keys (M2), or full-file compatibility?

Status: DONE_WITH_CONCERNS
Summary: The loader's precedence and opt-in gating are correct and all gates pass. Before merge, fix the `check` hint's flag test so it matches the loader, update `skill/SKILL.md`, and decide whether to restrict or document the wider cwd trust that project-level `.claude` env files bring.
