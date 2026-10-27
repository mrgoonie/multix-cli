# Code review: model_requested / model_resolved / job receipts (#389)

Diff: `git diff origin/dev...HEAD` on branch claude/gracious-heisenberg-gs71bq (11 files, +306/-10).
Lint, typecheck, build and the full test suite were already reported passing; I did not run them again.

## Verdict

Nothing blocks the merge. One medium bug: a Replicate run that uploads an input file reports the uploaded file's id as `job.id` instead of the prediction id. The other findings are low severity: edge cases and docs wording.

## Medium

### M1. Replicate: `job.id` is the uploaded file's id, not the prediction id
- `src/agent/run-state.ts:150-154`: the id comes from the in-flight job, else `state.ids.find((i) => ok(i, true))`, which is the first id returned by any successful non-GET call.
- `src/providers/replicate/node-input-files.ts:54-60`: an input file over 256 KB goes through `client.uploadFile`, which sends `POST /v1/files` (`src/providers/replicate/client.ts:336-372`). The response is `{ id, content_type, size, urls }`. `id` is in `ID_KEYS`, so `fetch-telemetry.ts:284-288` records it with the upload call's index.
- The prediction is created after that (`POST /v1/models/{o}/{n}/predictions`). Its id is pushed second.
- Replicate never calls `trackInFlight` (only Atlas does: `src/providers/atlascloud/commands/prediction-runner.ts:234`), so the in-flight id cannot override the file id.
- Example: `multix replicate run owner/model --file image=./photo.png --json` with a 1 MB photo, or `replicate video --image ./big.png`, emits `job: { provider: "replicate", id: "<file id>", attempt: 1 }`. An agent that polls or cancels with that id gets a 404. Also, `attempt` then counts failed `/v1/files` posts, not prediction creates.
- `provider_ids` keeps the same order as before, so it is not a regression there. But the new field contradicts the docs, which say `job` is the id "a successful submit returned".
- Fix options:
  - (a) Preferred: have the command name its job explicitly. Add a `trackJob(id)` next to `trackInFlight`, or call `trackInFlight` from the Replicate (and Runway/BytePlus/fal) submit paths. Keep the heuristic only as a fallback.
  - (b) Cheaper: skip ids from calls whose path ends in `/files`, `/uploads`, `/assets` or `/uploadMedia` when choosing the submit id.
- Add a test with an upload response followed by a prediction response.

## Low

### L1. Docs say "Paid calls are never retried", but HeyGen retries paid creates
- The English and Vietnamese `for-ai-agents.md` (the `job` row) say this. `src/providers/heygen/client.ts:172-205` retries non-GET creates on 5xx, network errors and 409 `request_in_progress` when an Idempotency-Key is set.
- That retry is safe, but the sentence is false as written. Suggested wording: "a paid call is resent only when the provider cannot bill it twice (429 before processing, or an idempotency key)".

### L2. Failed polls count as attempts when the id only came from a GET
- `run-state.ts:157-168` counts earlier failed calls with the same method, host and path.
- When the id comes from the GET fallback, a 5xx or network error on an earlier poll of the same URL raises `attempt`, but nothing was resubmitted. This happens in status commands such as `leonardo status <id>` and `replicate status`, and in flows whose submit returns no id-keyed field.
- This conflicts with "attempt is 1 unless the command retried a non-paid call" only in spirit; a poll is not a send. Fix: count only failures for non-GET calls, and report `attempt: 1` when the chosen id's call is a GET.

### L3. A single batch with an earlier failed item inflates `attempt`
- Matching on method, host and path also matches different requests to the same endpoint. If an earlier item failed and the command went on without retrying it, the next successful item gets `attempt: 2`.
- Example: a multi-chunk or `-n` loop to one generateContent path, where chunk 1 got a 400 and was not retried.
- I found no command that continues after a non-retried failure in the flows I traced (Gemini key-pool, Replicate/Runway 429 retry, HeyGen send), so this is theoretical. An explicit attempt counter from the retrying clients would be exact.

### L4. Last-resort `state.ids[0]` can name a failed request
- `run-state.ts:154`: if no id came from a successful call, `job.id` falls back to the first id of any call. That includes `x-request-id` headers on 4xx/429 responses (see the fal test's `rl-1`).
- On a run where every call failed, `job` then names a rejected request. This is useful for support but not documented. Either document it ("or the request id of a failed call") or drop the fallback so `job` stays "a job the provider accepted".

### L5. Adding `responseId` changes `cost.operation_id` for Gemini runs
- `operationIdFor` (`src/budget/cost-receipt.ts:236-248`) uses `providerIds[0]`.
- Gemini generateContent responses had no ids before, so the operation id was `run:<history id>`. It is now `gemini:<responseId>`. Each value is still unique per run, so spend grouping is not merged incorrectly. But the format of a public receipt field changes for one provider, and the PR does not mention it.

### L6. Oversized Gemini TTS bodies get `model_resolved` but no `job`
- `fetch-telemetry.ts:278-281`: the tail path extracts `modelVersion` but not `responseId`, which comes after it in the same tail.
- Long `gemini generate-speech` runs therefore have `model_resolved` set and `job` absent, while short ones have both. A small fix: extract `responseId` from the tail the same way.

### L7. `job` row in the docs describes the selection incompletely
- The docs give only in-flight and "first id a successful submit returned".
- The code also falls back to a successful GET's id (status commands) and then to any id (L4).
- The `model_resolved` row lists `data.model`; the code also reads `data.modelVersion` and `data.model_version`. Cosmetic.

### L8. `multix guide` text does not mention the new fields
- `src/commands/agent/guide-command.ts:21-23` lists the envelope fields and omits `model_requested`, `model_resolved` and `job`. Optional, but it is the agent's one-screen protocol.

## Checked and not an issue

- **model_resolved sources.** Only responses that are both `ok` and JSON are read (`fetch-telemetry.ts:271`), and the first model found wins. None of these endpoints returns a top-level or `data.` `model`/`modelVersion` key that names anything other than the serving model:
  - Replicate `GET /v1/models/{o}/{n}` (has `default_example` nested, no top-level `model`) and `/v1/files`
  - Gemini Files upload (`{file:{...}}`), Veo operations, Imagen `predictions`
  - fal storage initiate and queue submit
  - Runway `/v1/uploads` (`uploadUrl`, `fields`, `runwayUri`)
  - HeyGen `/v3/assets` (`asset_id`) and `/v3/users/me`
  - Leonardo `generations_by_pk.modelId` (wrong key and depth, so it gives null rather than a wrong value)
  - OpenRouter `/models` (an array under `data`, skipped)
  - Atlas `data.model` echo
  - BytePlus, Sora and HeyGen model-video, which report a real `model`
- **Another run's job.** The only lookup of another run's spend (`openrouter generation`) is excluded by `SPEND_LOOKUPS`. Status commands report the job they poll, which is that run's subject.
- **Speech fallback.** Routes are chosen by whether a key is present, before anything is sent (`src/commands/speech/index.ts:195-231`). `requestModel` and `resolvedModel` cannot come from different routes.
- **Backwards compatibility.** `model` is unchanged in the envelope and in history. `history stats --by model` and the list view read `e.model` (`history-command.ts:73,123`), `rerun` reads argv, and `provider_ids` content and order are unchanged apart from the added Gemini `responseId`. History fields are optional, so old lines still parse. The envelope builder at `agent-runtime.ts:342` is the only producer, so making `model_requested`/`model_resolved` required in `ResultEnvelope` breaks no other builder (typecheck agrees). The worker does not import the changed modules.
- **Dry run / estimate.** `model_resolved` is null and `job` is absent, as documented.
- **Concurrency.** `resolvedModel ??=` and the order of `ids` depend on when background body reads finish, not on call order. For the sequential flows traced this is call order. Parallel calls within one run go to the same model, so the result does not change.

## Tests

- `tests/unit/agent/model-job-identity.test.ts` exercises real wrapper and finalize paths with mocked fetch. These are not phantom tests.
- Missing coverage: an upload before the submit (M1), a failed GET poll before the id (L2), and the oversized-tail path for `model_resolved`.

## Recommended actions

1. Fix M1: name the job explicitly from submit paths, or exclude upload endpoints. Add a test.
2. Correct the docs sentence in L1 and complete the `job` description (L7), in both languages.
3. Optional: count only non-GET failures for `attempt` (L2), extract `responseId` from the tail (L6), and mention the fields in `guide` (L8).

## Open question

- Should `job` exist on a run where every call failed (L4)? This is a product decision.

Status: DONE_WITH_CONCERNS
Summary: Nothing blocks the merge. Replicate runs that upload an input file over 256 KB report the file id as `job.id` (M1); the rest are low-severity edge cases and docs accuracy.
