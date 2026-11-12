# Code review: default `elevenlabs transcribe` to scribe_v2 (issue #607)

Commits: `00ad18c` fix(elevenlabs): default transcribe to scribe_v2 and list current Scribe models; `982e882` test(elevenlabs): price the default and every current Scribe model.
Files: README.md, docs-site (en/vi commands/elevenlabs.md, landing-providers-data.ts), src/providers/elevenlabs/models.ts, tests/unit/budget/elevenlabs-transcribe-cost.test.ts, worker/src/cli-catalog.json. About 47 added lines and 7 removed.

## Verdict
No Critical, High or Medium findings. Three Low items, none blocking.

## Regression check (evidence)
- `TASK_DEFAULTS.sttModel` is read in two places only: the commander default in `src/providers/elevenlabs/commands/transcribe.ts:30` and the cost builder in `src/budget/command-cost.ts:264`. Both now resolve to `scribe_v2`, which is in the pricing catalog (`src/budget/pricing-catalog.ts:536`). So the estimate and the request use the same model.
- `ELEVENLABS_STT_MODELS` is used for help text only (`transcribe.ts:29`), by the landing `listed()` guard (`landing-providers-data.ts:219`, which throws at build time when an id is missing; `scribe_v2` is present) and by the new test. The CLI never validated `--model` against this list, so the v1 ids still reach the API unchanged.
- `DEPRECATED_SCRIBE_MODELS` (`command-cost.ts:136`) still keeps v1 and v1_experimental unpriced, which matches the docs.
- Intended behaviour change: `elevenlabs transcribe --input x --max-cost N` without `--model` used to stop with BUDGET_UNPROVEN, because the old default `scribe_v1` had no price. It is now priced and allowed to run. This matches the issue. The worker's spend-option coverage test passes.
- The worker catalog is regenerated and up to date: `worker/test/cli-catalog.test.ts`, the equality check against the live program, passes.
- Tests run:
  - `npx vitest run tests/unit/budget tests/unit/providers/elevenlabs tests/unit/providers/env-file-model-defaults.test.ts tests/unit/capabilities tests/smoke/budget-guard.test.ts tests/unit/commands/models-command.test.ts`: 231 passed, 6 skipped.
  - `tests/speech tests/smoke/cli.test.ts tests/unit/release-workflows.test.ts`: 178 passed.
  - worker `test/cli-catalog.test.ts test/spend-option-coverage.test.ts`: 13 passed.
  - `tsc --noEmit`: clean. `biome check` on the changed TS files: clean.
- The env-file model default tests do not cover ElevenLabs STT. There is no `ELEVENLABS_STT_MODEL` env override, so nothing there can regress.
- Docs claims checked against https://elevenlabs.io/docs/overview/models today:
  - v1 is deprecated, with v2 as its replacement.
  - `scribe_v3` is "most accurate ... for recorded audio".
  - `scribe_v2_medical` is a batch model for clinical audio.
  - The README, en and vi pages are accurate. The vi text uses "đã ngừng hỗ trợ" for "deprecated", the same term the repo already uses (vi/commands/gemini.md:93, vi/reference/for-ai-agents.md:163).

## Low
1. **The `scribe_v1_experimental` deprecation is inferred, not documented.** README.md:606, docs-site/src/content/docs/commands/elevenlabs.md:89, models.ts:169. The ElevenLabs models page lists and deprecates only `scribe_v1`. `scribe_v1_experimental` does not appear there at all. Failure scenario: none at runtime, since the live check returned 200. The risk is only that the docs make a claim the provider does not publish. You could say "the v1 family" or cite the API reference. This text was already present (command-cost.ts:136 and for-ai-agents.md:164), so it is not new in this diff.
2. **The Vietnamese wording reads as contradictory.** docs-site/src/content/docs/vi/commands/elevenlabs.md:84: "đã ngừng hỗ trợ nhưng vẫn được chấp nhận" literally says "support has ended, but it is still accepted". "đã lỗi thời (deprecated)" or "không còn được khuyến nghị" would be more precise. The current wording matches the repo's existing glossary, so changing it is optional. If changed, change line 105 and vi/reference/for-ai-agents.md:163 too.
3. **A stale hint in the unpriced detail.** `src/budget/command-cost.ts:267` (not changed in this diff) still says "pass --model scribe_v2 or scribe_v3". Now that v2 is the default, "omit --model" would also work. This is cosmetic. In the docs, the `--model scribe_v2` examples (en elevenlabs.md:114-115, vi :108-109) now restate the default, which is harmless.

## Informational
- The list order differs between files: `ELEVENLABS_STT_MODELS` is v2, v3, v2_medical (default first), while the pricing catalog and docs use v3, v2, v2_medical. This is cosmetic.
- The new test "lists every current batch Scribe model, and each has a price" decides what counts as current with a `startsWith("scribe_v1")` prefix. A future deprecated id under another prefix would need the filter updated. It does tie the help list to the price catalog, which is the useful property.
- ElevenLabs also lists `scribe_v2_realtime` and `scribe_v3_live`. They are correctly left out: they are realtime (WebSocket) models, not batch `POST /v1/speech-to-text`.
- CHANGELOG.md:808 still lists only the v1 models. This is correct: release-please owns the file and that entry is historical.

## Plan / task status
Everything in issue #607 is done: the default is changed, the help/README/docs/landing list the current models first, v1 is still accepted, the worker catalog is regenerated, and unit tests are added. No skill/SKILL.md change is needed: it does not state the default, and its "deprecated scribe_v1 stays unknown" is still true.

Status: DONE
Summary: No blocking findings. The default switch is the same in the CLI, the cost estimator, the worker catalog and the docs, and all related tests pass. Three low items remain: the inferred v1_experimental deprecation wording, the Vietnamese "ngừng hỗ trợ" phrasing, and a stale cost hint.
