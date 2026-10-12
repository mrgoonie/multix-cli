# Re-review: PR #97 fix(core): project .env must not repoint provider routing to receive the user's key

- PR: https://github.com/mrgoonie/multix-cli/pull/97, branch `fix/core-base-url-trust`, head `fcb2e64`, closes #87
- Worktree read: `D:\www\oss\multix-cli\.claude\worktrees\agent-a6ee71ba31cb5dcc8`. I confirmed HEAD is `fcb2e643996c34c93fe4804dc7c0dbb3fb59e647` from the last line of `.git/worktrees/agent-a6ee71ba31cb5dcc8/logs/HEAD`.
- Diff: 15 files, +599/-48. The core change is `src/core/env-loader.ts` (+194/-21). Also changed: 6 provider call sites, `src/commands/check.ts`, `tests/unit/core/env-loader.test.ts` (+293), and the docs (EN and VI environment pages, README, SKILL, `.env.example`).
- CI on `fcb2e64`: all 6 checks pass. They are Node 20 and 22 on ubuntu and windows, the docs site, and the MCP Worker. The win32-only tests ran on the windows runners.
- Bash was dead in this session, so I ran nothing locally. Everything below comes from reading the source and from GitHub.

## Verdict

**Merge-ready. No blocking findings.**

All the blocking and medium findings from the previous review are fixed. I looked for bypasses of the new "same project file" rule in these areas, and none of them opens one:
- source tracking
- Windows case handling
- dual credential names
- Cloudflare video credentials
- coverage of every keyed request path
- MCP Worker isolation

What remains: two Medium items (a docs and design acknowledgement, and a mismatch between `multix check` and what the commands do) and four Low items. These can be fixed after merge.

Counts: Critical 0, High 0, Medium 2, Low 4.

---

## Previous findings: status

| Prev | Finding | Status | Evidence |
|---|---|---|---|
| H1 | Windows case bypass | **Fixed** | `envNameKey` (`env-loader.ts:38-40`) is used to record names (`:128`), to look them up (`:177`), and for `userFileValues` (`:135-142`, `:268`). Tests: `env-loader.test.ts:375-407` (lower-case name, lower-case opt-in, mixed-case user fallback) and `:562-567`. They ran on the windows CI runners. |
| H2 | Project `.env` can inject process and child-process env | **Deferred, tracked** | Moved to #99. The docs now scope the claim: EN `environment.md:156-159`, VI `:154-157`, README `:120`. |
| M1 | Cloudflare account and gateway IDs | **Fixed** | `cloudflare/models.ts:60-81` routes both IDs through `resolveTrustedSetting`. Video also counts `REPLICATE_API_TOKEN` (`:23-26`, `:72`). |
| M2 | Global opt-in recommended | **Fixed** | `OPT_IN_HINT` (`env-loader.ts:198`) and all the docs now recommend the per-command shell form and warn against putting it in `~/.multix/.env`. |
| M3 | Breaking change shipped as a patch | **Partly fixed** | The PR body now has a "Behaviour change (migration note)" section, and the code fails closed (`ConfigError` when there is no fallback, `env-loader.ts:299-303`). There is still no `BREAKING CHANGE` footer; see L3. |
| L1 | An empty project value hides the user value | **Fixed** | `env-loader.ts:268-273`. Tests at `:304-318`. |
| L2 | No scheme check outside HeyGen | **Fixed** | `checkBaseUrlScheme` (`env-loader.ts:333-345`) runs for every non-default base URL (`:379`). The test at `:331-349` covers `http://localhost.evil.test`. |
| L3 | Test gaps | **Fixed** | Tests added for: win32 case handling, empty value, userinfo and port (`:320-329`), opt-in in a legacy project file (`:442-460`), the same-file rule (`:462-532`), and the `check` report (`:534-560`). |
| L4 | Docs wording | **Fixed** | The docs say "one warning per variable" (EN `:152-154`). |

## Bypass hunt for the new rule (all hold)

- **Source tracking.** The shell always wins: `loadFile` skips any name already in `process.env` (`:126`), so no origin is recorded and the value counts as "shell". `cwd/.env` is labelled `project`. `~/.multix/.env` is labelled `user`. Legacy `.claude` files under cwd are labelled `project`, each with its own file path, so a key in `.claude/.env` does not count as "the same file" as `cwd/.env` (test `:481-490`). Legacy files under home are labelled `legacy`, which counts as user-owned. No parent-directory or nested `.env` is read. When cwd is the home directory, the home legacy files are labelled `project`, which is the conservative direction.
- **`HOME` and `MULTIX_DISABLE_HOME_ENV` redirection.** Both are read at `:153`, before the project file loads at `:156`. Not exploitable.
- **Runtime mutation.** The only writer to `process.env` in `src/` is `env-loader.ts:127`. `envFileOrigin` drops the origin when the value has changed since loading (`:178`).
- **Windows.** `process.env[...]` lookups ignore case and the origin keys are upper-cased, so a lower-case name in the project file is still tracked as `project`. Within one file, the first spelling wins both in `loadFile` and in `byNameKey`, so the two stay consistent.
- **Dual names.**
  - BytePlus: the provider sends `resolveKey("BYTEPLUS_API_KEY") ?? resolveKey("ARK_API_KEY")` (`byteplus/client.ts:14`). The trust check uses `[["BYTEPLUS_API_KEY","ARK_API_KEY"]]` in the same order (`:24-26`), with the first non-blank name winning (`env-loader.ts:234`). They differ only when `BYTEPLUS_API_KEY` is whitespace: the provider then sends the whitespace, and the check looks at `ARK_API_KEY` and refuses. That is the safe direction.
  - Replicate: the provider and the check use the same constants and the same trimmed `resolveFirstKey` (`replicate/node-client.ts:20-39`). Test `:492-506` covers this.
- **Cloudflare video.** The gateway request sends both tokens (`video-client.ts:51`). `CLOUDFLARE_VIDEO_CREDENTIALS` includes `REPLICATE_API_TOKEN`, and the video path reads only that name (`models.ts:79`), never `REPLICATE_API_KEY`, so the two match. Test `:527-531`.
- **Native Cloudflare gateway path.** `client.ts:49-60` and `:72-83` send only `CLOUDFLARE_API_TOKEN` to `api.cloudflare.com/.../accounts/{id}` with `cf-aig-gateway-id`. That matches `CLOUDFLARE_NATIVE_CREDENTIALS`.
- **Coverage.** Every `*_BASE_URL` reader in `src/` goes through `resolveBaseUrl`: Atlas `env.ts:44`, BytePlus `client.ts:24`, fal `client.ts:34`, HeyGen `node-helpers.ts:56`, Leonardo `client.ts:24`, Replicate `node-client.ts:36`. Every client constructor I found gets its base URL from those helpers. Its `baseUrl` default only applies when the caller passes none. The hard-coded hosts are OpenAI, ElevenLabs, MiniMax, Gemini and OpenRouter. No command takes an `--api-key` or `--token` flag.
- **Fail closed before any request.** In every path, the base URL or ID is resolved when the client or config is built, before the first `fetch`. That includes Atlas uploads, which happen after `createAtlasClientFromEnv`.
- **Opt-in.** It is refused from the project `.env` and from legacy project files. `LEGACY_ALLOWED_NAME` rejects it from home legacy files. It is accepted from the shell and from `~/.multix/.env`, and the latter is documented as a global switch.
- **MCP Worker.** `worker/src` never imports `env-loader`. It reads `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AI_GATEWAY_ID` from deployment bindings (`worker/src/providers/cloudflare.ts:13-15`). It imports only the pure clients (`replicate/client.ts`, `heygen/client.ts`, `atlascloud/client.ts`, `cloudflare/video-client.ts`), whose `baseUrl` comes from the caller. The MCP Worker CI job passes, so the bundle does not pull in `node:fs`.
- **Secrets in messages.**
  - The `ConfigError` and the "Ignoring" warning name the variable, the local file path and where the key came from, never a value (`:238`, `:301`, `:307`).
  - The custom-host warning shows only the hostname (test `:320-329`).
  - `multix check` lines never show values (test `:554`).

---

## Critical

None.

## High

None.

## Medium

### M1. Same-file trust protects the key but not the user's data, and it silently replaces the user's own key. The docs do not say so.

`env-loader.ts:274-278`; docs EN `environment.md:127-132`, VI `:128-132`, README `:120`, SKILL `:417`

The new rule is: "use the project value when every key sent comes from the same project file". This rule is key-safe; I found no path that sends a key from another source. But think about a cloned repository whose `.env` ships both `FAL_KEY=<repo key>` and `FAL_BASE_URL=https://collector.example`, used by someone who keeps their own `FAL_KEY` in `~/.multix/.env`:
- The project key loads first and shadows the user's key. This load order is pre-existing.
- The base URL is then trusted.
- Every prompt goes to the repository's host, and so does every local file the user passes (Atlas `--ref` and `--audio` uploads in `atlascloud/commands/env.ts:54-92`, HeyGen local uploads). The responses that come back are attacker-controlled.
- The only signal is one stderr line naming the host.

This is the "warn only" posture that #87 considered too weak. It now applies to any repository that also ships a throwaway key. The docs sentence "used only when it cannot send someone else's key" is accurate, but readers will take it as "safe".

Fix (docs only, no code change): add one sentence to EN, VI, README and SKILL. For example: "A repository that ships its own key and base URL still receives your prompts and any files you upload, and its key replaces yours from `~/.multix/.env`; check the host named in the warning." If the product owner prefers, make the same-file case require the opt-in too. That would be stricter, and it is a product decision.

### M2. `multix check` disagrees with the Cloudflare commands

`check.ts:142-155`, `:181-182`, `:302-310`; `cloudflare/models.ts:63-67`

- **(a) Native commands with a refused gateway ID.** `requireCloudflareConfig` always resolves `CLOUDFLARE_AI_GATEWAY_ID` through `resolveTrustedSetting`. A refused gateway ID therefore throws for native image and speech too. But `cloudflareReadiness().native` is `apiToken && native.account` (`:152`) and ignores `native.gateway`. Scenario: a project `.env` has only `CLOUDFLARE_AI_GATEWAY_ID`; the token and account are in the shell. `check` prints "Cloudflare Workers AI credentials configured (image and speech)", and every `multix cloudflare image` then fails with a ConfigError. The "Endpoint Overrides" warn line does say "commands that use it will stop with an error", but the success line contradicts it.
- **(b) Video credentials not counted in the report.** `ROUTING_SETTINGS` checks the Cloudflare IDs against `CLOUDFLARE_NATIVE_CREDENTIALS` only (`:181-182`). Scenario: the project `.env` holds the token and both IDs; `REPLICATE_API_TOKEN` is in the shell. The report says "CLOUDFLARE_AI_GATEWAY_ID in effect (from project .env, with the keys it receives from the same file)". `cloudflareReadiness().video` is correctly false, but the hint printed is "Cloudflare video needs CLOUDFLARE_AI_GATEWAY_ID and REPLICATE_API_TOKEN", and both are set. `multix cloudflare video` then fails with "REPLICATE_API_TOKEN comes from the shell".

Fix:
- (a) `native: Boolean(apiToken) && native.account && native.gateway !== refused`. Expose the state instead of a boolean, or treat `refused` as not ready.
- (b) When `video` is false only because of trust, print the reason from `inspectTrustedSetting(..., CLOUDFLARE_VIDEO_CREDENTIALS)` instead of the generic hint, and/or add a video-credentials row to `ROUTING_SETTINGS`.
- Add a test for each scenario.

## Low

### L1. The `check` "in effect" label overstates what was checked

`check.ts:195-204`
- A project value used because of the opt-in, or because it equals the vendor default, is labelled "from project .env, with the keys it receives from the same file". That is false in both cases. Use a neutral label such as "from project .env", and add "(opt-in)" when the opt-in applies.
- `check` does not run `checkBaseUrlScheme`. A value like `http://proxy.example.org` from the shell, or as a `fallback` from `~/.multix/.env`, is reported as in effect or used, but the command throws.

### L2. Credential lists are duplicated in three places, so they can drift

`byteplus/client.ts:14` and `:24-26`, `check.ts:158-183`
- BytePlus spells out `["BYTEPLUS_API_KEY","ARK_API_KEY"]` twice in the provider and once more in `check.ts`.
- `check.ts` re-lists the credentials for every provider instead of importing them.
- If someone later swaps the provider's lookup order, or adds a fallback name (for example `FAL_API_KEY`) without updating the spec, the trust check looks at the wrong name. That reopens the bypass, and no test would notice.

Fix: export one `*_CREDENTIALS` constant per provider. Use it in the key resolver (for example `resolveFirstKey(...BYTEPLUS_KEYS)`), in `resolveBaseUrl`, and in `ROUTING_SETTINGS`, as Replicate and Cloudflare already do.

### L3. Still no `BREAKING CHANGE` marker

None of the 3 non-merge commits has a footer. The repo squash-merges (`feat(replicate): ... (#67)`), so unless the squash title gets a `!`, or the squash body keeps a `BREAKING CHANGE:` footer, release-please will cut a patch release.
- The behaviour change is real. Project-only base URLs whose key comes from elsewhere now stop the command, and `http://` base URLs are refused for five more providers.
- The migration note in the PR body is good, but it does not reach the changelog.

Fix at merge time: squash title `fix(core)!: ...`, or add a `BREAKING CHANGE:` footer.

### L4. Test gaps (minor)

- The real provider credential specs are tested only through a generic `TESTPROV` name. No test checks that BytePlus's spec order matches `requireBytePlusKey`. This ties to L2.
- No test covers the M2 scenarios.
- The win32 tests are `runIf`. They ran on windows CI, which is fine, but on Linux only `envNameKey` is exercised.

## Positive observations (risk calibration)

- The same pure `inspectTrustedSetting` drives both the commands and `check`. Only the credential lists passed to it differ (M2), so the logic is not duplicated.
- Fail-closed with `ConfigError` replaces the old silent fallback to the vendor default. That removes the "mock URL ignored, request billed" problem from the previous M3.

## Recommended actions

1. Merge after a docs-only M1 sentence (EN, VI, README, SKILL), or merge now and do M1 as a follow-up.
2. M2: fix the Cloudflare readiness and the hint in `check.ts`, with tests. This can be a follow-up issue.
3. L3: use `fix(core)!:` as the squash title, or keep a `BREAKING CHANGE:` footer.
4. L2: single-source the credential constants per provider.
5. L1 and L4 when convenient.

## Plan follow-up

#87's scope is complete: base URLs and Cloudflare routing IDs are covered, the Windows case is closed, it fails closed, there is a per-command opt-in, `check` shows the state, the docs are in EN and VI, and there are tests. #99 tracks the out-of-scope env injection. Move #87 from `in review` to `done` when the PR is approved. If M2 is deferred, open a follow-up issue for it.

## Unresolved questions

- Product: should the same-file rule apply at all? Requiring the opt-in even when the key is in the same file would also protect prompts and uploads (M1).
- Does release-please on this repo bump the minor version for a pre-1.0 breaking change (`bump-minor-pre-major`)? This decides how loud L3 needs to be.

Status: DONE
Summary: Merge (non-blocking follow-ups). Every previous finding is fixed or tracked (H2 in #99), and I found no bypass of the same-file trust rule. Findings: Critical 0, High 0, Medium 2 (docs gap: data, not keys, can still flow to a repository's host; check-vs-command mismatch for Cloudflare), Low 4.
