# Code review: PR #116, project `.env` allowlist (issue #99)

- Branch `fix/core-project-env-allowlist`, head `31e354a`, one commit: `fix(core): only load variables multix reads from a project .env` (no BREAKING CHANGE footer)
- Reviewed in an isolated context, read-only. Bash was unavailable, so the worktree `D:\www\oss\multix-cli\.claude\worktrees\agent-a04233e00429e1e94` was inspected with Read and Grep. The diff and CI results came from the GitHub API.
- CI at the head commit: all 6 check runs passed (Node 20/22 on ubuntu and windows, docs site, MCP Worker).

## Verdict

**Fix first.** One High finding: an exported library API now breaks for existing callers. Everything else is Medium or Low. The core design is sound: the filter runs before anything is copied into `process.env`, there is no dotenv expansion, the #97 trust rules are preserved, and no values are printed.

Counts: Critical 0 · High 1 · Medium 3 · Low 4 · Pre-existing / out of scope 2

## Scope

Files: `src/project-env-names.ts` (new), `src/core/env-loader.ts`, `src/core/index.ts`, `src/cli.ts`, `src/providers/atlascloud/commands/env.ts`, `tests/unit/project-env-names.test.ts` (new), `tests/unit/core/env-loader.test.ts`, `.env.example`, `README.md`, `skill/SKILL.md`, EN and VI `reference/environment.md`. Total +456 / −60.

## Verified (no defect found)

- **Completeness.** I grepped every `process.env.X`, `process.env["X"]`, `resolveKey("X")`, `*_ENV = "X"` constant, routing `name`/`keyEnvs`, Cloudflare constants, `resolveFirstKey(...)`, and `env.X` read through a parameter in `src/`. Every name multix reads is in the allowlist:
  - all routing base URLs and key aliases (`ARK_API_KEY`, `REPLICATE_API_KEY`/`_TOKEN`);
  - `CLOUDFLARE_API_TOKEN` and `REPLICATE_API_TOKEN` (through `CLOUDFLARE_VIDEO_CREDENTIALS`);
  - the Atlas model and upload names;
  - `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME`, `OPENROUTER_FALLBACK_MODELS`;
  - all seven `MULTIX_*` names;
  - `NO_COLOR`.

  The only name that is read but refused is `npm_config_user_agent` (`src/core/package-manager.ts:39`). Refusing it is correct: allowing it would let a repo choose which package manager `multix update` runs.
- **Ordering.** `loadFile` checks `accept(name)` before the "already set" check and before writing to `process.env` (`env-loader.ts:129-136`). `dotenv.parse` does no expansion, and `dotenv-expand` is not a dependency. So a refused name never reaches `process.env`, `fileOrigins`, or spawned children.
- **#97 interaction.**
  - `MULTIX_ALLOW_PROJECT_BASE_URL` set in a project file still passes the wildcard into `process.env`, but `projectBaseUrlAllowed()` (`env-loader.ts:226-229`) rejects a value whose origin is `project`.
  - On Windows a lower-case spelling is caught too, because `fileOrigins` is keyed by `envNameKey`.
  - Accepted names still get a `project` origin, so the same-file rule and `foreignCredential` work as before. Project legacy files are now filtered by the legacy credential regex AND the allowlist (`:196`), and they still count as `project` source with their own file path, so a key from them does not satisfy the same-file trust check for a base URL set in `cwd/.env`.
- **`MULTIX_DISABLE_HOME_ENV`.** Setting it in a project file has no effect on loading, because it is read at `:176` before the project file loads.
- **Windows case.** `isProjectEnvName` upper-cases on win32 only, matching how the OS resolves names. Lower-case `path` or `node_options` are refused on win32 (tested).
- **No values in output.** The warning lists names and the file path only. The test asserts that values are absent (`project-env-names.test.ts:162`).
- **Call sites.** `src/cli.ts:8` is the only production caller. All test calls were updated.
- **Docs.** EN and VI are in parity: new section, legacy-file note, and the #99 caveat removed. The example warning text matches the code string at `env-loader.ts:185`. The issue's requirement that child processes do not get refused variables is met by filtering at load time.

## High

### H1. `loadEnv()` signature change breaks the published library API under a `fix:` commit

- `src/core/env-loader.ts:168`: `export function loadEnv({ isProjectEnvName }: LoadEnvOptions)`, where the options argument is now **required**.
- It is re-exported through `src/core/index.ts:8` → `src/index.ts:5` → package `exports["."]` (`dist/index.js`). That makes it public API of `@mrgoonie/multix`.
- A JS consumer calling `loadEnv()` now throws `TypeError: Cannot destructure property 'isProjectEnvName' of 'undefined'`. TS consumers get a compile error.
- The commit type is `fix(core)` with no `BREAKING CHANGE` footer, so release-please will publish this as a patch.
- Library consumers also cannot get the real allowlist: `isProjectEnvName` lives in `src/project-env-names.ts` and is not exported from `src/index.ts`. Their only option is to write their own predicate, or pass allow-all, which defeats #99.

Fix options (pick one):
1. Make the options optional: `loadEnv(options: Partial<LoadEnvOptions> = {})`. Default `isProjectEnvName` to the strict allowlist, and export `isProjectEnvName` and `PROJECT_ENV_NAMES` from `src/index.ts`. Watch the import cycle: `project-env-names` imports `env-loader` and `commands/check`. Injecting the default from `src/index.ts`, rather than from inside core, avoids it.
2. Keep the required parameter, but export `isProjectEnvName` from `src/index.ts` and mark the commit `fix(core)!:` with a `BREAKING CHANGE:` footer, so the version bump is honest.

Option 1 is the smallest change that keeps the API compatible.

## Medium

### M1. `MULTIX_*` wildcard auto-trusts every future `MULTIX_` setting, while the issue scoped it to documented ones

- `src/project-env-names.ts:89`: `/^(MULTIX_[A-Z0-9_]+|GEMINI_API_KEY_\d+)$/`.
- Issue #99 says "documented `MULTIX_*` / provider settings". Today there are exactly 7 `MULTIX_*` names in `src/`.
- Today only one is security-relevant: `MULTIX_ALLOW_PROJECT_BASE_URL`, which defends itself through the origin check. A project `.env` must **not** be able to set it, and it cannot, so #87 stays closed.
- `MULTIX_LEGACY_CLAUDE_ENV` from a project file can switch on loading of `~/.claude/**/.env` credentials. That behaviour existed before this PR and is documented. Those keys get the `legacy` origin, so a project base URL is still refused with them.
- The risk is in the future. The next opt-in (for example a hypothetical `MULTIX_ALLOW_HTTP`, `MULTIX_TRUST_*`, or `MULTIX_ALLOW_*`) is silently accepted from a project `.env` unless its author remembers to add an origin check. The completeness test cannot catch this, because the wildcard makes it pass.
- Fix: replace the wildcard with the explicit list of the 7 names (`MULTIX_OUTPUT_DIR`, `MULTIX_IMAGE_FORMAT`, `MULTIX_MAX_DOWNLOAD_MB`, `MULTIX_UPLOAD_MIN_KBPS`, `MULTIX_LEGACY_CLAUDE_ENV`, `MULTIX_DISABLE_HOME_ENV`, `MULTIX_ALLOW_PROJECT_BASE_URL`). The existing source-scan test will then force each new name to be added on purpose. At minimum, exclude `MULTIX_ALLOW_*` from the pattern and add a test that asserts it. Update the "any `MULTIX_*` setting" wording in the EN and VI docs and in `.env.example` to match.

### M2. The legacy `.claude`-under-cwd filter is not tested with the real allowlist

- `env-loader.ts:195-199` adds `isLegacyAllowedName(name) && isProjectEnvName(name)` for project legacy files.
- Every legacy test in `tests/unit/core/env-loader.test.ts` uses `ALLOW_ALL` (`:41`), and `project-env-names.test.ts` never sets `MULTIX_LEGACY_CLAUDE_ENV`. So nothing proves that, for example, `ANTHROPIC_API_KEY` in `<cwd>/.claude/.env` is now dropped silently while the same name in `~/.claude/.env` still loads.
- Add one test with the real `isProjectEnvName`: a project legacy file containing `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`, and a home legacy file containing `ANTHROPIC_API_KEY`. Assert that the project value is dropped with no warning and the home value is loaded.
- Also add one `loadEnv` test on the win32 path (lower-case `multix_output_dir` accepted, `node_options` refused), or note that it is covered only at the predicate level.

### M3. Warning noise in ordinary app repositories

- `env-loader.ts:182-187`: every `multix` run inside a typical web-app repo (with `DATABASE_URL`, `NEXTAUTH_SECRET`, `STRIPE_*`, …) prints one stderr line that lists **every** foreign name. That is often 20–50 names on every invocation, and agents call multix repeatedly.
- It is once per process, which meets the issue's wording, but there is no way to silence it, and it names the project's other secrets on stderr (names only, but they end up in agent transcripts and CI logs).
- Suggestion:
  - Cap the list, for example the first 5 names plus "and N more".
  - Name `multix check -v` as the place to see the full list.
  - Or print the full list only with `-v`.

  Not a blocker. Decide on the UX before release, because users will see this immediately.

## Low

- **L1.** `CLOUDFLARE_AI_GATEWAY_COLLECT_LOG_PAYLOAD` (`project-env-names.ts:61`) is not read anywhere in `src/` (grep finds it only in the allowlist). It is allowed only because `.env.example` lists it and the docs describe it (`environment.md:208`). Harmless, but the docs promise behaviour that does not exist. That doc drift predates this PR and should be tracked as its own issue.
- **L2.** The source-scan test (`project-env-names.test.ts:44-58`) misses reads written as `resolveFirstKey("A","B")`, `inspectTrustedSetting("X", …)`, `resolveKey(someVar)`, routing `name:` literals, and constants not named `*_ENV` (for example `overrideName` in `cloudflare/models.ts:45`). Today those are covered structurally (routing objects, explicit constants). But the module comment "so a newly read variable cannot be left out" (`project-env-names.ts:8-9`) overstates the guarantee. Soften the comment, or add a `resolveFirstKey\(` pattern and a `"[A-Z][A-Z0-9_]+_(MODEL|BASE_URL|API_KEY|API_TOKEN)"` literal sweep.
- **L3.** `tests/unit/core/env-loader.test.ts:40`: the comment says "the project allowlist has its own tests below", but those tests are in another file (`tests/unit/project-env-names.test.ts`).
- **L4.** `src/project-env-names.ts:12` imports `commands/check.js` (a commander command module) just to get the provider key list. There is no runtime cost, because `cli.ts` already imports all commands, but a security allowlist now depends on a UI module. If `PROVIDERS` ever moves or gains entries that are not env names, the allowlist changes silently. Consider moving the provider key table into a small core or provider registry module that both import.

## Pre-existing (not caused by this PR, open separate issues)

- **P1.** Model defaults are frozen at import time, before `loadEnv` runs. `LEONARDO_DEFAULTS` (`providers/leonardo/models.ts:23-25`), `TASK_DEFAULTS` (`providers/minimax/models.ts:34-38`), `FAL_DEFAULTS` (`providers/fal/models.ts:21-28`) and `BYTEPLUS_DEFAULTS` (`providers/byteplus/models.ts:43-46`) are module-level objects that read `process.env`. ESM evaluates `cli.ts`'s imports (`commands/index.js` → providers) before `loadEnv(...)` on `cli.ts:8`. So `LEONARDO_DEFAULT_MODEL`, `MINIMAX_*_MODEL`, `FAL_*_MODEL` and `BYTEPLUS_*_MODEL` set in any `.env` file (project or `~/.multix/.env`) are ignored; only the shell works. The allowlist entries are correct, but these settings do nothing from a file.
- **P2.** `MULTIX_OUTPUT_DIR` from a project `.env` can point generated files anywhere the user can write (for example outside the repo). File names are generated (`<provider>-<ts>.<ext>`), so no specific file is overwritten. Arguably a legitimate project setting. Listed so the M1 decision is made deliberately.

## Edge cases checked

| Case | Result |
|---|---|
| Name refused in the project file but also set in the shell | Shell value kept; the name still appears in the warning (accurate: it is not loaded from the file) |
| Commented `# NODE_OPTIONS=` | Not parsed, no warning (tested) |
| `GEMINI_API_KEY_X`, bare `MULTIX` | Refused (tested) |
| Lower-case `gemini_api_key_2` on Windows | Allowed by the allowlist, but `listGeminiKeys` (`key-pool.ts:32`) matches case-sensitively on `Object.keys`, so it is silently unused. Same as before; not a regression |
| `MULTIX_ALLOW_PROJECT_BASE_URL=1` / `multix_allow_project_base_url=1` in the project file | Loaded, but the origin check ignores it (both spellings on win32) |
| `MULTIX_DISABLE_HOME_ENV=1` in the project file | No effect on loading; only affects the hint in `multix check` (`check.ts:279`) |
| `loadEnv` called twice | No-op, single warning (tested) |

## Recommended actions

1. **H1**: make `loadEnv` options optional with a strict default and export `isProjectEnvName`, or mark the change as breaking.
2. **M1**: replace the `MULTIX_*` wildcard with the explicit list, or at least exclude `MULTIX_ALLOW_*`, and add a test.
3. **M2**: add a legacy-under-cwd test with the real allowlist.
4. **M3**: cap or summarise the ignored-names warning.
5. L1–L4 are optional. Open issues for P1 and L1 rather than widening this PR.

## Metrics

- CI: 6/6 green at `31e354a`. I did not re-run locally (Bash unavailable).
- Lint/type: not re-run locally; CI typecheck and lint passed.
- New tests: 8 cases in `project-env-names.test.ts`; existing `env-loader` tests switched to `ALLOW_ALL`.

## Unresolved questions

- Is `@mrgoonie/multix` actually used as a library by anyone (the `exports` entry suggests so)? This decides between options 1 and 2 for H1.
- Should a project `.env` be able to enable `MULTIX_LEGACY_CLAUDE_ENV` at all? Today it can, as documented. That pulls home `.claude` credentials into a run that the repo controls; the trust rules still stop them being sent to the repo's base URL.

Status: DONE_WITH_CONCERNS
Summary: Fix first. 0 Critical, 1 High (the exported `loadEnv()` now requires an argument, which breaks library callers under a `fix:` commit), 3 Medium (`MULTIX_*` wildcard, legacy filter untested with the real allowlist, warning noise), 4 Low, 2 pre-existing.
