# Re-review: PR #317 capability registry (head 936e6e2)

Reviewer: isolated code-reviewer, read-only. 2026-10-26 (Asia/Saigon).
Previous: `plans/reports/code-reviewer-261026-1750-pr-317.md` (B1, B2 blocking; M3 docs).
Head `origin/claude/gracious-heisenberg-tfydgn` 936e6e2 = merge of 4134fff + origin/main 7fd3c58 (1.19.0, #328). Merge-base with main = 7fd3c58 (up to date).

## Verdict: MERGE (no blocking findings)

## Verification (detached checkout of 936e6e2)
| Check | Result |
|---|---|
| `npm run lint` | clean (536 files) |
| `npm run typecheck` | pass |
| `npm run build` | pass |
| `npm test` | 1812 passed / 18 skipped / 0 failed |
| `npm run check:mcp` | worker 380/380, bundle clean (no `node:*`, commander, execa, cli.ts) |
| `cd worker && npm run catalog` | no drift (git status clean) |
| `npm run verify:docs` | 8/8 pass |
| `multix models --json` main vs PR | 72 -> 80 rows; same delta as M4 of previous review (accepted); `openrouter tts` / `openrouter transcribe` rows identical to main plus additive `model_scope`, `outputs`; `list` kept |

Worktree returned to `merge-328`, clean, dist rebuilt from `merge-328`.

## B1 (registry vs main) — FIXED
- `src/capabilities/command-capabilities.ts:55-64`: `openrouter tts` (speech/audio, catalog) and `openrouter transcribe` (transcription/text, catalog) added; `:153-155` utilities `openrouter speech-models`, `openrouter transcription-models`, `openrouter generation`. Classification test passes (every leaf classified, none in both).
- `models-command.ts:29-34, 96-106`: `LIST_COMMANDS` holds `speech-models` + `transcription-models`; `lister()` keeps main's guards for both. CLI output: `openrouter tts ... list: multix openrouter speech-models`, `openrouter transcribe ... list: multix openrouter transcription-models`.
- `catalogCommand("openrouter","speech"|"transcription")` -> `openrouter tts` / `openrouter transcribe` (`capability-registry.test.ts:122-127`); null case moved to `video-edit` and `fal transcription`. Discovery maps OpenRouter `transcription` to `?output_modalities=transcription` (`model-discovery.ts:29-34`), same as `transcription-models` command. `models-command.test.ts:169-171` `vendor/or-tts` -> `openrouter tts`.

## B2 (fal tts usage via MCP/REST) — FIXED
- `worker/src/jobs/catalog-view.ts:183-207` `falTtsUsage()`: typed options derived from the model's `FalSpeechModel` profile (`voiceField`, `styleField`, `formatField`, `languageField`), text field excluded, all other fields named under `"input": "<JSON object with any of …>"`. Cross-checked against `src/providers/fal/commands/tts.ts:75-103` (`--voice --style --format --language --input --text-field --voice-field`) and `speech-input.ts:96-147` (each typed flag refused if profile lacks the field; flag + same field in `--input` refused). Gemini -> voice, style; ElevenLabs v4 -> voice, format, language. Matches.
- Worker policy `cli-command-policy.ts:180` does not block `--input` for `fal tts`.
- Tests `worker/test/job-tools.test.ts:221-235` assert typed options, `input` listing `turns`, no `"by long name"`, no `"stability":` / `"style_instructions":` as options.
- CLI `printInspect` (`models-command.ts:248-250`) adds "set fields without a typed flag … through --input JSON". Good.

## M3 (env docs) — FIXED
- `.env.example:46-49`, `reference/environment.md` EN + VI: `MULTIX_MODELS_TTL` in the project-allowed list (matches `project-env-names.ts:59`), `MULTIX_CACHE_DIR` documented as refused (matches `:46`). README table unchanged and consistent.

## Merge-conflict audit (`git show --cc` 4134fff, 936e6e2)
- Only main-side lines dropped: `TASKS`, `TASK_BY_COMMAND`, `TASK_BY_LEAF` and old `modelRows` body in `models-command.ts` (intended replacement by registry; `TASKS` moved to `capability-types.ts`), and `catalogPayload` signature / import in worker (widened, not lost). Main's `transcription-models` lister guard re-added in PR form.
- `project-env-names.ts`: both `MULTIX_CACHE_DIR` and `MULTIX_OPERATION_ID` kept in exclusions.
- env docs EN/VI: main's `MULTIX_OPERATION_ID` paragraph kept, PR's TTL/CACHE_DIR text added.
- README: main's `--estimate` / `--max-cost` lines and `OPENROUTER_TTS_MODEL` row kept.
- `worker/src/jobs/job-tools.ts`: main's `src/budget/command-cost.js` imports (`estimateCommand`, `parseCostPolicy`), `BudgetError` intact; `multix_catalog` passes `{task, model}`.
- `git diff origin/main HEAD` touches nothing in `src/budget/`, `src/core/usage-extract.ts`, `src/agent/`, `src/providers/openrouter/` — main's budget/receipt/OPERATION_ID/STT code untouched.

## Non-blocking
- N1. `falTtsUsage` always shows `args ["<text>"]`; for Gemini dialogue (`speakers` + `turns` via `input`) the text must be omitted (`speech-input.ts:102` allows it; endpoint says "one of prompt or speakers + turns"). Agent following usage literally for dialogue may send both; fails at fal validation. Consider "args [\"<text>\"] (omit when input has turns)".
- N2. Previous M1 (unbounded stale cache fallback), M2 (duplicate fal catalog reader), L1–L5 still open; acceptable as follow-ups.
- N3. Merge commits carry `fix(models): …` subjects; release-please will list them as fixes (patch bump plus the PR's own feat). Harmless if squash-merged with a `feat(models)` title.

## Unresolved questions
- Squash or merge-commit for #317? If merge-commit, two `fix(models)` changelog entries appear alongside the `feat`.
