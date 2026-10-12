# Code review: PR #129, fix(core) blank env fallback (closes #123)

Head 4afa69d, worktree `agent-a8af054f5ff273a53` (HEAD ref = fix/core-blank-env-fallback). The Bash tool returned no output for every command, so I ran nothing locally. Evidence comes from the source files, the GitHub diff, and the CI check-runs. All 6 checks pass, including Node 20/22 on both Linux and Windows.

## Verdict: MERGE

No critical, high or medium findings. 4 low, 3 info.

## Trust-boundary analysis (the focus)

`fileMaySet` (src/core/env-loader.ts:127-132) lets a file set a name only in two cases:
- the name is unset;
- the current value is blank and was recorded by an earlier file. The check is `fileOrigins.value === current`, so a blank shell value is never replaced.

Each fill updates `fileOrigins` with the new source, file and value (lines 152-153). So `envFileOrigin` and `foreignCredential` (lines 300-313) see the file the value really came from.

Scenarios traced:

| Project .env | ~/.multix/.env | Result | Safe? |
|---|---|---|---|
| `X_BASE_URL=evil`, `X_KEY=` | `X_KEY=k` | The key is filled from the user file, so its origin is user. foreignCredential gives a reason, and the setting falls back to the user's base URL or is refused (test at env-loader.test.ts:347). | Yes. Previously the blank key just meant "missing key". |
| `X_BASE_URL=`, `X_KEY=p` | `X_BASE_URL=u` | The base URL origin is user, so it is used. The project key goes to the user's own proxy. | Yes (the user chose it). |
| keyEnvs `[A,B]`: `A=` blank, `B=p`, `BASE_URL=evil` | `A=h` | `A` is filled from home. foreignCredential and resolveRoutedKey both read `process.env` and pick `A`, so they agree: refused or fallback. | Yes. This is stricter than before, when the project's `B` made the URL count as same-file. Not tested. |
| `CLOUDFLARE_ACCOUNT_ID=attacker`, token blank | token set | The token origin is user, so the account ID is refused or falls back. | Yes |
| Legacy cwd `.claude/.env` (opt-in, project source) | `CLOUDFLARE_ACCOUNT_ID=` blank, token set | The legacy project file now fills the account ID. The token is foreign, and the user value is blank, so the result is **refused**. | Yes (it fails closed) |
| Shell `X=` | anything | Unchanged. Origin is undefined and the setting is unset (test at :367). | Yes |

The allowlist from #116 runs before `fileMaySet` (`accept` at line 147). A blank project `MULTIX_ALLOW_PROJECT_BASE_URL=` or `MULTIX_LEGACY_CLAUDE_ENV=` is still dropped, so the fill cannot let these names in.

**The removed fallback is truly unreachable.** The old branch at inspectTrustedSetting returned `{fallback, reason: "it is empty"}` when the project value was blank and the user value was not. Now, whenever the user file has a non-blank value for that key, `loadEnv` already replaced the project blank and the origin is `user`. That includes Windows, where case is folded: `byNameKey` and `envNameKey` agree, and process.env lookups ignore case. A project-origin blank therefore exists only when the user value is absent or blank, and that was "unset" before too. The remaining `if (value === undefined) return unset` (line 341) is correct.

**Windows CRLF, quoting and whitespace.** dotenv normalises `\r\n`. Quoted `"  "` keeps its spaces, and `String.prototype.trim` strips spaces, `\t`, `\r`, NBSP and BOM, so all of these count as blank. `KEY= # comment` parses to `""`. No gap found.

## Findings

### Low

1. **Gemini rotation now mixes the home key into a project pool.** Example: project `GEMINI_API_KEY=` blank plus `GEMINI_API_KEY_2=p`, and home `GEMINI_API_KEY=h`. Before, the pool was `[p]`. Now it is `[h, p]`, and the home key is tried first. (Code: src/providers/gemini/key-pool.ts:30-45.) Gemini has no base URL override, so no key leaks. This is the behaviour #123 intends, but no docs mention its effect on the pool. Optionally add one sentence to the Gemini rotation section.
2. **Behaviour change for project-routed setups that use alternative key names.** A repo that ships `X_BASE_URL` plus a secondary key name, with the primary key blank, was trusted as "same-file" before. Now it is refused or falls back whenever the user's home file has the primary key. This fails safe, but it can surprise users. It is not covered by a test. Suggest a test with a two-name `keyEnvs` that asserts refusal (env-loader.test.ts near :347).
3. **One test does not prove the key was sent.** env-file-model-defaults.test.ts:407-418 asserts `process.env.FAL_KEY` and its origin, not the key on the outgoing request. Asserting `call.headers.Authorization` contains `home-fal-key` would prove the key is actually sent.
4. **`multix check` wording changed.** The `set empty in project .env` line (src/commands/check.ts:116-119) is removed. It is unreachable now, so this only affects anyone grepping `check` output for that string. I found no in-repo consumer. Not a breaking change for documented output.

### Info

- **Legacy layers now fill blanks.** With opt-in, legacy `.claude` layers can fill blanks left by `~/.multix/.env`. Docs line 114 ("never override earlier non-blank values") states this correctly. All trust outcomes fail closed (see table).
- **Duplicated comment.** The doc comment at env-loader.ts:326 repeats the inline comment at :340. Harmless.
- **Model overrides through `envDefault`.** Before, `resolveKey` (`||`) already treated `""` as unset. The new behaviour adds whitespace-only values counting as unset, plus trimming. Cloudflare `getCloudflareModel` no longer throws for a whitespace override (test added). Correct per #123.

## Docs

- EN (environment.md:11-16, 114, 200) and VI (environment.md:10-14, 111, 198) say the same thing.
- README:118 and skill/SKILL.md:57 match the code.
- One overstatement: "An empty project value never hides the `~/.multix/.env` value" is not true when `MULTIX_DISABLE_HOME_ENV=1` is set. That variable is test-only, so this is acceptable.

## Issue #123 scope check

- Blank project value plus a home value now gives the home value, for both a model default and an API key. Done (tests :347 and env-file-model-defaults :407).
- Source tracking reports the home file. Done.
- A non-empty shell value wins, and a blank shell value keeps the old behaviour. Done (:367 and :430).
- `envDefault` is now used for OPENAI_IMAGE_MODEL, OPENROUTER_IMAGE/VIDEO_MODEL and CLOUDFLARE_AI_*_MODEL. Done.

## Unresolved questions

- Should the Gemini docs mention that a blank project `GEMINI_API_KEY` now pulls the home key into that project's rotation? (Low 1)
- I could not run lint, typecheck or tests locally, so I relied on green CI for 4afa69d.
