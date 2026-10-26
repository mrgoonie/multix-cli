# Code review: PR #317 feat(models): truthful, task-aware capability registry (Closes #293)

Reviewer: isolated code-reviewer (did not write the code). Date: 2026-10-26 (Asia/Saigon). Read-only.
Head `pr-317` (4e3fe9d), merge-base 983d8d9, main b9bc563 (with #305, #308, #313, #319, #326, #327, #331).

## Scope
- 33 files, +2579/-155. Core: `src/capabilities/*` (5 new), `src/commands/agent/models-command.ts`, `model-discovery-cache.ts`, `src/providers/fal/commands/run.ts`, `worker/src/jobs/catalog-view.ts`, `job-tools.ts`, REST/OpenAPI, docs EN+VI, SKILL.md, AGENTS.md.
- Method: trial merge `origin/main` into `pr-317` in a scratch worktree, resolved conflicts, ran lint/typecheck/build/test/check:mcp, regenerated worker catalog, diffed `multix models --json` main vs merged PR (scratch worktrees removed afterwards).

## Verification (merged tree, after my conflict resolution + classification patch)
| Check | Result |
|---|---|
| `npm run lint` | clean (530 files) |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm test` | **4 failed** / 1773 passed / 17 skipped (see B1) |
| `npm run check:mcp` | worker 379/379, bundle clean (no `node:*`, commander, execa) |
| `npm run catalog` (worker) | regenerated catalog == auto-merged one (no drift) |
| Without classification patch | `classifies every CLI command…` fails: `openrouter tts`, `openrouter speech-models`, `openrouter generation` unclassified |

## Overall assessment
Design is sound: command / model / discovered-model separation, runtime-neutral `src/capabilities` (verified by bundle check), honest `listed: null` for unread/truncated catalogs, cache rejects future timestamps and malformed entries, `MULTIX_CACHE_DIR` refused from project `.env`, TTL capped, tests stub fetch (no paid/network calls). Not mergeable as-is: it predates #313 and the registry plus 4 tests encode "OpenRouter has no speech command", which is false on main. One MCP usage hint is also wrong.

## Blocking
### B1. Registry incomplete vs main (#313, #327) and tests encode stale facts
- `src/capabilities/command-capabilities.ts:44-54, 141-142` lack `openrouter tts`, `openrouter speech-models`, `openrouter generation`. After merge, `modelRows` skips unclassified commands (`models-command.ts:115-116`), so `multix models --task speech` **loses the `openrouter tts` row that main shows today** (regression), and `--live` labels OpenRouter speech models "no multix command runs openrouter speech models yet" (false).
- Fix (verified: lint/typecheck pass, classification test passes):
  ```ts
  "openrouter tts": catalog(["speech"], ["audio"], "OpenRouter speech model ids (multix openrouter speech-models)"),
  // UTILITY_COMMANDS:
  "openrouter speech-models",
  "openrouter generation",
  ```
- Then update tests that assert the pre-#313 world (they fail after the fix):
  - `tests/unit/capabilities/capability-registry.test.ts:96-103` expected OpenRouter tasks -> add `"speech"`.
  - `capability-registry.test.ts:115-117` `catalogCommand("openrouter","speech")` -> `"openrouter tts"`; keep a null case with `catalogCommand("openrouter","transcription")`.
  - `capability-registry.test.ts:258-276` "does not point catalog models at a command that cannot run them": switch fixture to an OpenRouter `transcription` (or fal `transcription`) catalog, keep `command: null` + `/no multix command/`.
  - `tests/unit/commands/models-command.test.ts:169` `vendor/or-tts` -> `command: "openrouter tts", verified: false`.
- `models-command.ts:29, 87-96` must keep main's `speech-models` in `LIST_COMMANDS` and the `(c.name() !== "speech-models" || task === "speech")` guard in `lister()` (otherwise `openrouter tts` row has no `list`).

### B2. MCP/REST usage hint for `fal tts` models tells agents to send options that do not exist
- `worker/src/jobs/catalog-view.ts:170-175`: for `fal tts` models usage says `options {"model": …} plus the inputs above by long name`. "Inputs above" are fal endpoint fields (`stability`, `similarity_boost`, `output_format`, `language_code`, `apply_text_normalization`, `timestamps`; Gemini: `prompt`, `style_instructions`, `speakers`, `turns`). `fal tts` options are `--text --voice --style --format --language --input --text-field …`; `run-argv-builder.ts:128` throws `Unknown option --stability`. Fails safe (no spend) but contradicts the feature's purpose (truthful "how to pass it to multix_run").
- Fix: usage for `fal tts` = `command "fal tts", args ["<text>"], options {"model": "<id>", "voice": "...", "input": "<JSON of other fields above>"}` (typed flags: voice/style/format/language; rest via `input`). Add assertion in `worker/test/job-tools.test.ts` (~line 223) that usage mentions `input` and not "by long name". Same wording issue in CLI `printInspect` is acceptable since types say "fal: keys of --input", but adding one line "pass other fields with --input JSON" would help.

## High / Medium (non-blocking)
- M1. Stale fallback is unbounded: `model-discovery-cache.ts:158-160` returns a cache of any age as `stale` with `listed: true`; `MAX_MODELS_TTL_S` comment ("cannot keep a removed model listed for long") is only true online. Consider dropping cache older than N×TTL to `unavailable`, or set `listed: null` when `state === "stale"` beyond max TTL.
- M2. Parallel reimplementation: `model-discovery.ts:70-96 readFal` duplicates `listFalSpeechCatalog` in `src/providers/fal/speech-models.ts` (pagination, `\p{Cc}` strip). Model facts in `model-registry.ts` duplicate `FAL_SPEECH_MODELS` (mitigated by parity test at `capability-registry.test.ts:87-90`). Follow-up: have one fal catalog reader parameterised by category.
- M3. Docs gap: `MULTIX_CACHE_DIR` / `MULTIX_MODELS_TTL` documented in README only; missing from `docs-site/.../reference/environment.md` (EN + VI) and `.env.example` (which lists other `MULTIX_*`).
- M4. Backward compat of default `multix models --json` (measured, main vs merged): 71 -> 79 rows. Removed rows: `avatar-video/heygen model-video`, `image-edit/leonardo variation` (both correct reclassifications per command descriptions); `heygen run` loses `any_model`; `heygen tts` list `avatars` -> `voices`; 10 rows added; new fields additive. Disclosed in PR body; acceptable for a `feat`, but it is a behaviour change for agents filtering by those tasks — mention in CHANGELOG/commit body.

## Low
- L1. `writeCache` leaves `<file>.<pid>.tmp` if `renameSync` fails (caught silently). Unlink tmp in the catch.
- L2. `readCache` validates `provider`/`model` but not `voices`/`pricing` shape; a hand-edited cache with `voices: "abc"` yields `voices: 3`. Local file, low risk.
- L3. OpenRouter `pricing`/`voices` strings are not control-char stripped (only emitted in JSON, not printed) — fine today; strip if ever printed.
- L4. `findModelCapability` is exact-match; `fal tts` `findSpeechModel` trims slashes. `fal run /elevenlabs/tts/eleven-v4/` skips the input warning. Cosmetic.
- L5. `warnOnModelInput` (`fal/commands/run.ts:95`) runs after `applyFileFlags` uploads; warnings only, so harmless, but running it before upload gives earlier feedback.

## Edge cases checked (scout)
- `--live` without `--task` -> ValidationError; `--model` unknown + `--live` without task -> ValidationError. OK.
- `--provider` not in fal/openrouter + `--live` -> empty sources, no fetch. OK.
- Future `fetched_at` -> refetch, not fresh forever. OK. Truncated catalog -> `listed: null`, never `missing`. OK.
- Offline + no cache -> `unavailable`, nothing confirmed. OK.
- Concurrent writers: tmp file per pid + atomic rename. OK.
- Project `.env` cannot set `MULTIX_CACHE_DIR` (cache seeding). OK; `MULTIX_MODELS_TTL` allowed, capped 7d.
- Worker bundle: `catalog-view.ts` -> `model-registry.ts` -> `fal/speech-models.ts` -> `core/errors.js`; no node built-ins (check-bundle clean).
- MCP input schema: only new optional `task`/`model`; legacy schema test passes after merge. REST `model` validated by `MODEL_ID_RE`, bad task -> 400.
- Tests: fetch stubbed/injected, cache dir in mkdtemp; no paid API calls.

## Conflict resolution guidance
1. `src/project-env-names.ts`: keep both entries (`MULTIX_CACHE_DIR` and `MULTIX_OPERATION_ID`) in `PROJECT_ENV_EXCLUDED`.
2. `worker/src/jobs/job-tools.ts`: keep both import blocks; order for Biome: `src/budget/command-cost.js`, `src/capabilities/capability-types.js`, `src/core/errors.js`. Then check the budget hunks main added to `multix_catalog`/`multix_run` still pass `{ task, model }` through.
3. `worker/test/job-tools.test.ts`: both sides implement the same legacy-schema check; keep one (PR's version also compares non-`properties` keys; either passes).
4. `src/commands/agent/models-command.ts`: take PR side (drop `TASK_BY_COMMAND` / `TASK_BY_LEAF`), keep main's multi-line `LIST_COMMANDS` with `"speech-models"`, and add the `speech-models` guard to `lister()`.
5. Apply B1 classification + test updates; `cd worker && npm run catalog`; rerun lint/typecheck/build/test/check:mcp/verify:docs.

## Plan / DoD (#293)
- Fixtures `fal run` not speech by itself: done. OpenRouter not advertising arbitrary modalities: done, but must be updated for real `openrouter tts` (B1).
- Schema, TTL/refresh, removed/renamed, unsupported option, offline: done.
- Docs EN/VI + worker catalog + check:mcp: done, minus env reference (M3).

## Unresolved questions
- Should `openrouter tts` get verified OpenRouter speech models in the registry (e.g. Gemini TTS via OpenRouter), or stay catalog-only in this PR? Suggest follow-up issue.
- Is an unbounded stale fallback (M1) intended product behaviour?
