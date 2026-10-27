# Code review: model and job identity in receipts (#389)

- Commit: `0e24057` feat(agent): record requested vs resolved model and job identity in receipts (base `origin/dev`, 1 commit)
- Files: src/agent/{fetch-telemetry,agent-runtime,run-state,result-envelope,history-store}.ts, tests/unit/agent/run-identity.test.ts, docs-site reference/for-ai-agents.md (EN, VI), skill/SKILL.md. +319/-4.
- Checks run: `npm run lint` clean, `npm run typecheck` clean, `npm run build` ok, `npx vitest run` 129 files / 2275 tests pass, `npm run verify:docs` pass. The working tree was not modified.
- Empirical probes: I bundled `src/agent/fetch-telemetry.ts` with esbuild in a scratch directory and ran it with mocked fetch. The results are quoted with each finding below.

## Verdict

**Blocking: 1 (H1).** The `job` field can name an upload as the job of a run whose submit failed. SKILL.md tells agents to use `job` "to resume or audit instead of resubmitting", so a wrong job id leads them to the wrong action.

## High

### H1 (BLOCKING): a failed submit after an upload reports the upload id as `job`
`recordUsage` sets `run.job` from `usage.ids[0]` of *any* 2xx non-GET response. When the submit that follows fails, nothing clears or replaces that value, and `finalizeRun` still emits `job` on failed runs (`job = notSent ? undefined : jobIdentity()`).

Scenario (probe `uploadfail`): `replicate image -m o/n --image ./in.png`. `POST /v1/files` returns 201 `{id:"file-1"}`, then `POST /v1/models/o/n/predictions` returns 422. Result: `job: {provider:"replicate", id:"file-1", attempt:1}` on an `ok:false` envelope. An agent following SKILL.md concludes that a paid job exists. It then skips the resubmit, or runs `multix replicate status file-1`, which 404s. The same happens with Leonardo (`POST /init-image` returns `uploadInitImage.id`), and with any upload whose response carries an `id` or a `request-id`/`x-request-id` header, whenever the later submit fails with a 4xx/5xx, a 429 that is never retried, or a network error.

This contradicts the docs' own wording ("the latest submit the provider accepted"). The test "takes the job from the latest accepted submit" only covers the case where the submit succeeds.

Fix options, best first:
1. Have provider submit code record the job explicitly, the same way `trackInFlight` does (for example `trackJob(id)` in the Replicate/Runway/fal/Leonardo/HeyGen/etc. submit paths), and keep the heuristic only as a fallback.
2. At minimum, drop the heuristic job when a later non-GET call failed (`status === 0 || >= 400`) after `run.job.call`, or when the run failed and the job call is not the last non-GET call.
3. Add a test for upload ok + submit 422, expecting `job` to be undefined.

### H2: `job.provider` is the command group, not the provider that issued the id
`jobIdentity()` returns `provider: run.group`. For cross-provider commands the group is not a provider: `speech generate --provider elevenlabs` gives `job.provider: "speech"`, and `scene render` gives `"scene"`. With `speech generate --fallback`, the id comes from whichever route served the request, and nothing records which one that was. An agent that builds `multix <job.provider> ...` from the field gets an invalid command, and audits join on a non-provider. The envelope `provider` already had this weakness, but `job` is a new contract, and fixing it after release changes the meaning of a published field.

Fix: derive the provider from the host of the job call (`run.calls[job.call].host`) with a small host-to-provider map, or have adapters set it. Non-blocking, but fix it in this PR before the field ships.

## Medium

### M1: the real job id is missed, and an HTTP trace id or nothing is reported instead
`job` reuses `extractUsage().ids`, whose `ID_KEYS` and header list were built for `provider_ids`, not for job identity:
- ElevenLabs dubbing: `POST /v1/dubbing` returns `{dubbing_id}`, and `dubbing_id` is not in `ID_KEYS`. Probe `dub`: `job.id = "req_http_abc"` (the `request-id` header), not `dub_123`. Polling or resuming with that id is impossible.
- Gemini Veo: `predictLongRunning` returns `{name:"models/.../operations/op123"}`. Probe `veo`: no `job` at all, for a long-running paid job.
- HeyGen: Video Agent `session_id` and translation `video_translation_ids[]` (an array) are not captured. Both are paid async jobs.
- Probe `headerafter`: a later non-GET response whose only id is an `x-request-id` header replaces the body job id (`fal-req-1` becomes `trace-999`). I found no current command that makes such a call after submitting, so this is latent. It will happen as soon as a cancel or ack POST with header trace ids is added.

Fix: give `job` its own extraction. Body ids should outrank header ids across calls, not only within one response. Add `dubbing_id`, `session_id` and operation `name` (or let submitters call `trackJob`, as in H1).

### M2: model fields are sometimes absent instead of `null`, and `model_resolved` stays null when the provider did report a model
- When neither the request body nor the path nor `--model` names a model, the code omits both fields. The issue says "`model_resolved` ... is `null` otherwise", and the docs do not mention that the fields can be absent. Agents that test `model_resolved === null` behave differently on these runs.
- `namesRunModel` is true only when the request itself names the model. With `replicate image -m owner/name` (an official-model path, empty body `model`), the response carries `model:"owner/name"`, but `model_resolved` is `null`. Likewise, `replicate image -m owner/name:ver` sends `{version}`, so `model_requested` is the version hash rather than what the user asked for, and `model_resolved` is `"owner/name"`. A naive equality check then reads this as a model substitution.

Fix: either always emit both fields (`null` when unknown) or document that they are omitted. For path-addressed models (Replicate, fal), also mark the request whose path carries the model as `namesRunModel`.

### M3: failed runs finalize without waiting for background body reads
Only the `postAction` hook awaits `settleTelemetry()`. `exitWithError` and the wrapped `process.exit` call `finalizeRun` synchronously. Scenario: OpenAI or Gemini image POST returns 200 with a multi-MB JSON body, and the command throws right after (write error, empty output check). The clone read is still pending, so `job` and `model_resolved` are missing from the failed receipt, which is where a job id matters most. `usage` already had this gap, and this change makes it more visible. Option: run a bounded `settleTelemetry` in `exitWithError` (it is async-capable before `realExit`), or record header-only ids synchronously at response time.

## Low

- **L1: attempt is computed in response order, not send order.** `sendAttempt` runs after `await original(...)` and scans `run.calls`, which other in-flight requests have already appended to. Probe `concurrent`: two parallel POSTs to the same endpoint, where the 429 lands first, give `job-A attempt: 2` even though `job-A` was sent once. I found no current command that runs concurrent same-endpoint submits.
- **L2: `attempt` counts any earlier failed send to the same endpoint.** That includes network errors (status 0) and 5xx (probe `status0` gives `attempt: 2`), and sends that were separate requests rather than retries. The issue says attempt counts retries of *non-paid* calls. A network error on a POST may already have been accepted and billed. In practice only HeyGen (with an idempotency key) and fal storage uploads resend after network errors, so the impact is small. Consider counting only statuses that are known not to have been paid (429, and 408 where documented).
- **L3: test gaps.** Nothing covers a failed run (`finalizeRun({exitCode:1})`), dry-run or `--estimate` (`model_resolved:null`, no `job`), upload followed by a failed submit (H1), a cross-provider group (H2), or out-of-order completion. The "failed submits give none" test only covers a single failed request with no earlier upload.
- **L4: docs accuracy (EN and VI are in parity).**
  - The `model_resolved` sources list names OpenAI/OpenRouter/Gemini/header, but the code accepts any top-level `model` (Replicate, BytePlus, the Cloudflare gateway).
  - The `job` row does not say that header request ids (`x-request-id`, `request-id`, `x-generation-id`) qualify, or that the field is a heuristic.
  - SKILL.md's "use it to resume" overstates what `job` holds for sync providers (OpenAI image, ElevenLabs TTS), where it is an HTTP request id. Tighten the wording, for example "for async providers (fal, Replicate, Runway, Atlas, Leonardo, HeyGen) it is the job id".

## Scout notes (edge cases checked, no defect)
- Dry run: `onDryRun` fires before `modelFromRequest`, so `model_requested` falls back to `--model`, `model_resolved` is `null` and `job` is omitted (`notSent`). The estimate-only path is the same.
- Body reads that finish out of order cannot let an earlier call overwrite a later job (`run.job.call < call.index` guard).
- The tail `modelVersion` regex ignores escaped occurrences inside strings, and its test covers that.
- OpenRouter `models:[...]` fallbacks: the response `model` correctly reports the fallback that actually served the request.
- Gemini key-pool 429 rotation: the same path gives attempt 2 and the resolved model from the successful retry, which is correct.
- Atlas: `inFlight` wins, and it equals `data.id` from the submit.
- History: the fields are optional and additive; `history stats --by model` still reads `model`. No schema break.
- AGENTS.md: the conventional `feat(agent)` commit publishes a minor version, which is appropriate. Docs are updated in EN, VI and SKILL.md. I did not verify the issue claim or label workflow, which happens outside the repo.

## Recommended actions
1. (Blocking) Fix H1: record the job explicitly from submit paths, or drop the heuristic job when a later non-GET call failed. Add the regression test.
2. Fix H2 by deriving `job.provider` from the job call's host.
3. Address M1 with job-specific id keys (`dubbing_id`, `session_id`, operation `name`) and body ids ranked above header ids.
4. Decide on M2: always emit `null`, or document that the fields can be omitted. Mark path-addressed model requests.
5. Add the tests in L3 and tighten the SKILL.md/docs wording (L4).

## Unresolved questions
- Should `job` be emitted on failed runs at all, or only when an accepted submit exists (`inFlight` or an explicit submit marker)?
- For sync providers, is an HTTP request id meant to count as a `job` (the issue says "when a provider returns an id"), or should `job` be limited to async jobs?

## Resolution (follow-up commit)

- H1 fixed: `jobIdentity` drops the job when a later non-GET call failed; regression test added.
- H2 fixed: `job.provider` comes from the answering API host (`providerOfHost`), falling back to the command group for unknown hosts (base URL overrides).
- M1 partly fixed: ElevenLabs `dubbing_id`, HeyGen `lipsync_id` and Gemini operation names are captured; within one response a body id beats a request-id header. A header-only id from a later submit can still replace an earlier body id: ranking body ids across responses would instead let an upload id beat a later header-only submit, which is worse. HeyGen `video_translation_ids[]` (array of strings) is not captured.
- M2 fixed: both model fields are present (`null` when unknown) on every run that sent a provider request; Replicate `/models/<owner>/<name>/predictions` paths name the requested model. A version hash requested vs `owner/name` reported is documented as honest data.
- M3 partly fixed: errors thrown to `exitWithError` now wait for background reads. Commands that call `process.exit()` directly still exit synchronously (pre-existing for `usage`).
- L1 not changed: latent, no command sends the same submit concurrently.
- L2 not changed: `attempt` counts sends of the submit, so a 5xx or network failure before a success is an earlier send; docs say "sent again after a failed send".
- L3/L4: tests and docs (EN/VI, SKILL.md) updated.
