# Code review: da1323e, receipt model and job identity (#389)

Base: `origin/dev...HEAD` (10 files, +462/-17). Reviewer did not write the code.

## Verification
- `npx vitest run tests/unit/agent`: 6 files, 41 tests pass
- `npm run typecheck`: clean
- `biome check src/agent tests/unit/agent/receipt-identity.test.ts`: clean
- Scratch probe (outside the repo, real `installFetchTelemetry` + `jobIdentity`): Replicate upload then official-model prediction returns `job.id = "file-abc"` (the uploaded file) instead of `"pred-xyz"`. Confirms H1.

## High

### H1. Replicate official-model runs with an uploaded file report the file id as the job
`src/agent/fetch-telemetry.ts:277` (`base = call.named ? 0 : GET ? 4 : 2`) together with `preferRanked` tie-break on earliest seq (`src/agent/run-state.ts:125-128`).
- `replicate run owner/name --input image=@big.png` (>256 KB) first does `POST /v1/files`, which returns a top-level `id` (`ReplicateFile.id`, `src/providers/replicate/types.ts`). Then it does `POST /v1/models/{owner}/{name}/predictions` with body `{input}`. The body has no `model` key, and `modelFromRequest` only matches `/models/<x>:` paths, so this request has `named=false`.
- Both POSTs rank 2. The earlier seq wins, so `job = { provider: "replicate", id: "<file id>", attempt: 1 }`. The probe reproduced it. In agent mode `inFlight` is not set for Replicate, so nothing overrides it.
- The same pattern applies to any provider whose generation request carries the model in the path or nowhere (fal queue submit, Replicate official models, multipart FormData bodies, which `modelFromRequest` ignores) when an earlier POST returns an `id`/`*_id`. fal's `upload/initiate` returns no id today, so fal is safe only by luck.
- Impact: the receipt names a wrong job, and the docs present that value as authoritative. A consumer that polls or cancels by `job.id` hits the Files API id.
- Fix options: (a) treat a request as the generation request when its path matches the `<model>` positional or `--model` value as well as when the body names one, e.g. pass `run.positionalModel` into the ranking, or `path.includes(model)`; (b) for equal rank, prefer the latest POST over the earliest; (c) exclude known upload endpoints (`/files`, `/storage/upload`, `/uploadMedia`) from job candidacy. (a) is the most cause-aligned. Add a regression test for upload then official-model predictions.

## Medium

### M1. `job.provider` is the command group, not the provider, for cross-provider commands
`src/agent/run-state.ts:152` returns `provider: state.group || best?.host`.
- `speech generate --fallback ...` and `scene render` run under group `speech`/`scene`. A run that ends on the Fish or OpenRouter route reports `job: { provider: "speech", id: "<fish/openrouter id>" }`. Nobody can resolve that id without knowing the actual provider. The issue asks for `job: { provider, id, attempt }` so that the id can be looked up.
- Fix: derive the provider from `best.host` (or a host-to-provider map) when the group is not a provider group. At minimum, document that `provider` is the command group.

### M2. `model_requested` / `model_resolved` can come from different requests and imply routing that did not happen
`src/agent/fetch-telemetry.ts:125-126` (`requestModel` = first request that named a model, even a failed one), compared with `resolvedModel`, which only comes from ok responses.
- Scenario: `speech generate --fallback`. The ElevenLabs route (`model_id: eleven_v3`) returns 503, and the OpenRouter route succeeds and echoes `model: "openai/gpt-4o-mini-tts"`. The envelope then says requested `eleven_v3`, resolved `openai/gpt-4o-mini-tts`, which reads as if the provider substituted the model. The same mismatch happens in Gemini text→image flows that call two models.
- The issue requires `model_resolved` to be what the provider reported for the request. Pair it with the model named by the same winning request: store `named` (the string) in `CallInfo`/`resolvedModel`, and emit `model_requested` from it when a resolved model exists.

### M3. Gemini never yields a `job`, and the Gemini test uses a fabricated response shape (phantom coverage)
`tests/unit/agent/receipt-identity.test.ts` ("counts failed calls to the same endpoint...") serves `{ name: "operations/abc", id: "op-1", modelVersion: "veo-3.0-001" }`. Real `predictLongRunning` returns `{ name: "models/.../operations/..." }` with no `id` and no `modelVersion`. `name` is not in `ID_KEYS` (`src/core/usage-extract.ts:84`), and generateContent's `responseId` is not either.
- Result: for Gemini Veo (a long-running job, the main case for "the job being waited on") and for Gemini generateContent, `job` is always absent. Key-pool retries (the attempt logic tested here) therefore never show up in a real Gemini receipt. The test passes only because of the invented `id`.
- Fix: either accept Gemini's operation `name` (and `responseId`) as the job id for Gemini, or state in the docs that Gemini runs carry no `job`. Then rewrite the test with the real response shape.

### M4. `attempt` counts unrelated parallel failures, not retries
`src/agent/run-state.ts:139-148` counts every failed call on the same method/host/path with `seq < best.seq`.
- A batch or scene run that fires several requests to the same endpoint concurrently, where one item fails with 429 and no retry happens, reports `attempt: 2` for an earlier-sequenced success. The issue text says "attempt is 1 unless the command retried". The value is therefore inferred, not reported. Low frequency, but it contradicts the "never a guess" framing.
- Fix: count only failures whose request finished before the winning request started (track `startedAt`/`endedAt` per call), or have the retry helpers report retries explicitly.

## Low / informational

- L1. `model_resolved` comes from any ok response's top-level `model`/`model_version` (`fetch-telemetry.ts:238-247`), including unnamed POST/GET responses (rank 2/4). For `fal run`/`replicate run` result payloads, a model output object with a top-level `model` string (e.g. an LLM-wrapping fal endpoint) would be reported as the served model. Consider limiting it to the named request, or to rank ≤ 2.
- L2. Replicate versioned runs: `model_requested` is the 64-char version hash (body `version`, existing `requestModel` behavior) while `model_resolved` is `owner/name` from the response. The pair looks like a substitution. Optional: prefer `model_version`/`version` for resolved when the request named a version.
- L3. Lookup-only commands (`fal status`, `replicate`/`atlas` get, ElevenLabs list endpoints that send a `request-id` header) now carry a `job`, sometimes the request id of a catalog GET. This matches the doc wording "job or request id", but `UNRECORDED`-like exclusions such as `SPEND_LOOKUPS` (`agent-runtime.ts:44`) do not suppress `job`. Optional.
- L4. Behavior change outside the stated scope: `positionalModel` now also feeds the legacy `model` field and `costReceiptFor(model)` (`agent-runtime.ts:272-274, 292`). `history stats --by model` will now bucket `fal run`/`replicate run`/`fal status`/`fal result`/`fal voices` by model instead of `(none)`. `resolveRate` has no fal/replicate entries, so cost status does not change today. This is an improvement, but mention it in the PR so stats consumers are not surprised.
- L5. Error exit paths (`agent-runtime.ts:440, 465`) finalize without `settleTelemetry()`, so a failed run can report `model_resolved: null`/no `job` purely because of timing. This was already true for `usage`. Optional.
- L6. Docs (EN/VI/SKILL) describe `attempt` as "failed calls to the same endpoint the command retried". Per M4, the code counts all earlier failures to that endpoint. Align the wording once M4 is decided.

## Security / leaks
- No secrets in the new fields: ids are capped at 128 characters and taken from fixed body keys or `*request-id`/`x-generation-id` headers. Models come from top-level string keys (≤200 characters) or the request path or body. `modelFromTail`'s regex cannot match escaped JSON inside string content. Query strings never enter `path`. A provider echoing a signed URL in `model` would pass through unredacted, but no current provider does that. Optional: apply the existing `URL_QUERY` stripping to `model_resolved`.

## Backward compatibility
- `model` is kept. The new history fields are optional, so `history`/`stats`/`rerun` read old entries unchanged. Rerun uses `argv` only. No schema-version bump is needed because the fields are additive.

## Test gaps
1. Upload then official-model Replicate prediction (H1). There is no test where the generation request is unnamed and an upload precedes it. The existing "prefers the generation request's id" test passes only because its generation body names `model`.
2. A fal upload → submit → status → result flow end-to-end through the wrapper.
3. Cross-provider fallback (`speech generate --fallback`) for `job.provider` and model pairing (M1/M2).
4. Real Gemini LRO and generateContent response shapes (M3).
5. Atlas with in-flight id equal to the body id, so the attempt count path is exercised.
6. `positionalModel()` itself (commander `registeredArguments`/`processedArgs`) is only covered by the smoke test; the unit finalize test sets `options.model` instead.

## Recommended actions
1. Fix H1 (rank the request whose path carries the requested model as the generation request) and add the regression test.
2. Fix or explicitly document M1 and M2 before the docs promise a lookup-able `{provider, id}` and a same-request model pair.
3. Decide on Gemini job ids (M3) and replace the fabricated fixture.
4. Tighten or reword `attempt` (M4/L6).
