# Review: status reads name the job they were given (#489, HEAD f1508fd)

## Id form parity (nameJob arg vs submit-recorded id)

| Provider | Submit records | Read names | Parity |
|---|---|---|---|
| fal | `request_id` (top level) | raw `requestId` | yes |
| replicate | `id` | raw arg (client trims later) | yes, unless padded |
| runway | `id` (lowercase UUID) | `assertTaskId` (trim + lowercase) | yes |
| leonardo | `sdGenerationJob.generationId` and its v2/motion siblings (depth 1) | raw arg | yes |
| byteplus | `id` | raw arg | yes, unless padded |
| topview legacy | `result.taskId` | `assertLegacyId` (trimmed) | yes |
| topview platform | `data.id` | `assertPredictionId` (trimmed) | yes |
| gemini | interaction `id` | raw arg (client trims later) | yes, unless padded |
| cloudflare | Replicate-shaped `id` | raw arg (encoded, not trimmed) | yes, unless padded |

`interactions/<id>` fails `INTERACTION_ID_RE`, so no read is sent and the run is `not_sent`: harmless.

## Findings

**Medium: trimming regression in replicate and gemini.** Both clients trim the id (`assertPredictionId` in `getPrediction`, `assertInteractionId` in `findInteractionKey`), so a padded id (`" abc"`) still reads successfully. Before, it joined `replicate:abc` via the response id; now it splits off as `replicate: abc`. Fix: call `assertPredictionId` / `assertInteractionId` first and pass the result to `nameJob`, or have `nameJob` trim (covers all readers).

**Low: naming happens before input validation.** Replicate, gemini, fal, byteplus, leonardo and cloudflare name the raw argument before it is validated, so a rejected argument (for example `../x`) is added to `provider_ids`. The outcome is `not_sent`, so cost is unaffected. Moving the call after the assert fixes both findings.

**Low: test gaps.** The new suite (9 cases, all pass) checks only failed reads. No case shows that a successful read joins the submit's `operation_id`, and no case uses a padded id, which would have caught the Medium finding.

**Low: docs.** The `job` row (EN and VI, line 98) gives only `fal result` as its example and was not updated. Change it to "a status or result read given a job id (e.g. `fal result`, `replicate status`)".

Verification: `npx vitest run tests/unit/agent` gives 63/63 passing.

Status: DONE_WITH_CONCERNS
Summary: Id forms match the submit for all nine readers, but replicate and gemini name the untrimmed argument, so a padded id now splits a successful read off its operation.

## Resolution (author)

- Trimming regression: `nameJob` now trims its argument, which covers all nine readers. A new test ("names a padded id by the trimmed form the client sends") fails on the previous commit and passes now.
- Naming before validation: the trimmed id is named, and a rejected argument sends no request, so the run is `not_sent` with no cost. I left the call order as is.
- Docs: the `job` row in EN and VI now names `replicate status <id>` and the other status readers.
