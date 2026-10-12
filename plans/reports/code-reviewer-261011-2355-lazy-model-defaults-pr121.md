# Code review: PR #121, lazy provider model defaults (issue #118)

- Branch `fix/providers-lazy-model-defaults`, head `75494f1a81e3d698f93143fcee820dbd87c75ef0`
- Reviewed in worktree `D:\www\oss\multix-cli\.claude\worktrees\agent-a678b2c1e80faa013` (Read/Grep only; Bash unavailable)
- CI at head: all 6 check runs passed (Node 20/22 on ubuntu and windows, MCP Worker, Documentation site)

## Verdict

**Ready to merge.** Findings: 0 critical, 0 high, 1 medium (a loader-level gap that predates this PR; open a follow-up issue), 4 low.

## Scope

10 files: `src/core/env-default.ts` (new), the `models.ts` files for byteplus, fal, gemini, leonardo and minimax, openai `commands/generate-speech.ts` and `commands/transcribe.ts`, `tests/smoke/cli.test.ts`, and `tests/unit/providers/env-file-model-defaults.test.ts` (new).

## Completeness

- **Module-scope env reads.** `process.env` across `src/` now appears only inside functions or getters. The 18 module-scope reads on base (fal, byteplus, leonardo, minimax `TASK_DEFAULTS`) are gone. The other hits (`output-dir.ts:19`, `logger.ts:20`, `image-webp-finalize.ts:54`, `byteplus/models.ts:71`, `codex-image-driver.ts:67`) all run at call time.
- **Commander option defaults are safe.** `src/cli.ts:7` calls `loadEnv()` before `registerCommands(program)` at `src/cli.ts:23`. The `.option(..., default)` calls are evaluated at registration, so they see `.env` values. These are `fal/commands/image.ts:24`, `byteplus/commands/{video,image-to-video,reference-to-video}.ts`, `byteplus/commands/generate-3d.ts:33-34`, and `openai/commands/{generate-speech,transcribe}.ts`. The only caller of `registerCommands` is `src/cli.ts`, and `src/` has no MCP server entry point.
- **Description text is correct.** The fal video default text (`fal/commands/video.ts:17`) and the byteplus 3D text are also built at registration, after `loadEnv()`.
- **No early copies.** Nothing spreads, `Object.assign`s or `JSON.stringify`s `FAL_DEFAULTS`, `BYTEPLUS_DEFAULTS`, `LEONARDO_DEFAULTS` or the minimax `TASK_DEFAULTS` (grep found none), so no getter value is captured early.
- **Worker unaffected.** `worker/src` imports only the replicate, atlascloud, heygen and cloudflare provider modules. None of the files changed here are in the Worker bundle.
- **No `node:*` imports added.** `env-default.ts` reads the global `process.env`, as the replaced code already did.

## `envDefault` semantics (`src/core/env-default.ts:6-8`)

- `process.env[name]?.trim() || fallback`. Unset, empty or whitespace-only values use the fallback. Other values are trimmed.
- **Precedence is unchanged.** It reads whatever `loadEnv` put into `process.env`: shell first, then project `.env`, then `~/.multix/.env` (`env-loader.ts:155-159`; a file never overwrites an existing value).
  - The brief said "shell > ~/.multix/.env > project .env". The code actually lets the project file win over the user file. That order predates this PR and matches the docs.
- **Gemini chains are preserved.** The nested calls (`gemini/models.ts:72,78,81`) keep the base order: IMAGE_GEN > GEMINI_IMAGE_GEN, GEMINI_TTS > TTS, MULTIMODAL > GEMINI_MODEL. The difference is that a blank primary now falls through to the next name.

## Findings

### Medium

**M1. A blank project `.env` value hides the `~/.multix/.env` value, so the user's model setting is silently ignored.**
`env-loader.ts:126` skips any name already present in `process.env`, including `""`. The project `.env` loads first (`:156`), then the user file (`:159`).

Take the exact scenario from issue #118: a project `.env` copied from `.env.example` contains `FAL_IMAGE_MODEL=`, and `~/.multix/.env` contains `FAL_IMAGE_MODEL=fal-ai/flux-pro`. `envDefault` sees `""` and uses the built-in model, not the user's choice. Before this PR the request went out with an empty model, so the PR improves things but does not finish the job.

The loader already handles this case for trusted settings: `inspectTrustedSetting` (`env-loader.ts:266`, `:280-284`) uses `userFileValues`, and `docs-site/.../reference/environment.md:158` says "An empty project value never hides the ~/.multix/.env value". Keys resolved through `resolveFirstKey` have the same gap.

- **Why not blocking:** the gap predates this PR, lives in the loader, and affects keys too.
- **Fix options:** have `loadFile` not record blank values, so a later file can fill them, or have `envDefault` check `userFileValues`.
- **Action:** open a follow-up issue rather than widen this PR (AGENTS.md: "Found an unrelated bug ... Open a new issue").

### Low

**L1. Some other model overrides are not trimmed.** `OPENAI_IMAGE_MODEL` (`openai/commands/generate.ts:29`, `image-to-image.ts:36`), `OPENROUTER_IMAGE_MODEL` and `OPENROUTER_VIDEO_MODEL` (`openrouter/commands/generate.ts:46`, `image-to-image.ts:75`, `image-to-video.ts:56`), and `CLOUDFLARE_AI_*_MODEL` (`cloudflare/models.ts:46`) use `resolveKey(...) ?? default`.
- An empty value already falls back, because `resolveKey` uses `||`.
- A whitespace-only value is still sent, and padded values are not trimmed.
- Replicate and atlascloud trim already (`replicate/node-client.ts:39,43`, `atlascloud/commands/env.ts:33`).
- Optional: switch these to `envDefault` for consistency. This is not required for #118.

**L2. Some blank-value tests write the same key twice.** `tests/unit/providers/env-file-model-defaults.test.ts:313-316` writes `GEMINI_IMAGE_GEN_MODEL=` and then `GEMINI_IMAGE_GEN_MODEL=file-image` to the same file. The test depends on dotenv's last-wins rule for duplicate keys. It works, but dropping `GEMINI_IMAGE_GEN_MODEL` from the blank list would make the intent clearer.

**L3. Some getters have no direct test.** Minimax `video`/`music`, Leonardo `image-to-image`/`image-to-video`, BytePlus `image-to-video`/`reference-to-video`, and whitespace-only values are not tested directly. Each shares a getter with a tested path, so the risk is low.

**L4. The generate-3d help shows the default twice (predates this PR).** `byteplus/commands/generate-3d.ts:33-34` puts the default in the description and also passes it as the commander default. Help prints "(default X)" and then `(default: "X")`. Both now show the `.env` value, so the text is accurate, just repeated.

## Test realism

- **Load order matches the CLI.** The unit test imports the provider modules at top level, before the `.env` file exists and before `loadEnv()` runs. This is the same order as `dist/cli.js`, so a value captured at module load would make the test fail. The PR states 10 of the 11 original tests fail on `main`, which is consistent with this.
- **Requests are inspected.** Assertions check the real request URL or body through a stubbed `fetch`. No paid calls are made.
- **Smoke test uses the built CLI.** `tests/smoke/cli.test.ts:306-327` spawns `dist/cli.js` with `extendEnv: false`, removes the shell model values, and checks the `--help` defaults. This is an end-to-end proof of the issue's symptom.
- **Environment is restored.** Each test saves and restores every variable it manages, resets the loader, and removes its temp directory.

## Behaviour change risk

- Blank or whitespace values now fall back instead of sending `""` or a padded id. Trimming non-blank values is a small change and a benign one.
- A blank Gemini `MULTIMODAL_MODEL` now falls through to `GEMINI_MODEL`. This was intended and is tested.
- Nothing in the repo uses an empty value to mean something on purpose.

## Docs impact

- Not strictly required. `docs-site/src/content/docs/reference/environment.md:94-110` lists the overrides and does not claim that blank values are honoured.
- Optional: one sentence saying "blank values use the built-in default".
- The page does not list the `MINIMAX_*_MODEL`, `LEONARDO_*_MODEL` or `GEMINI_IMAGE_GEN_MODEL`/`TTS_MODEL`/`GEMINI_MODEL` names. That gap predates this PR and should be handled outside it.

## Recommended actions

1. Merge.
2. Open a follow-up issue for M1: a blank project `.env` value shadows the `~/.multix/.env` value for model overrides and keys.
3. Optionally, in a later PR: L1 (route the remaining model overrides through `envDefault`) and L4.

## Unresolved questions

- Should a blank project value fall through to the `~/.multix/.env` value (M1)? `.env.example` ships every name blank, so the answer decides whether the issue's scenario is fully fixed for users who keep their model choices in the home file.

Status: DONE
Summary: Merge. 0 critical, 0 high, 1 medium (blank project `.env` value hides the `~/.multix/.env` value; predates this PR, follow-up issue), 4 low.
