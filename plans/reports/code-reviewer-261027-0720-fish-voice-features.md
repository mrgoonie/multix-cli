# Code review: Fish Audio P1 voice features (commit 75e8590, base 6a96c42)

Reviewer: isolated code-reviewer (did not write the code). Read-only; no source edits.

## Scope
- 24 files, +1837/-61. Clients: `src/providers/fish/{tts-client,voice-design-client,voices-client}.ts`; commands `voice-design.ts`, `clone.ts`, `voices.ts`, `index.ts`; budget (`pricing-catalog`, `cost-estimate`, `cost-receipt`, `command-cost`); capabilities; worker policy and catalog; tests; docs (README, SKILL.md, docs-site EN+VI).
- Verification run:
  - `npm run typecheck`: clean.
  - `npm run lint`: clean (577 files).
  - `npx vitest run tests/unit/providers/fish tests/unit/budget`: 159/159 passed.
  - `npm run check:mcp`: passed; bundle clean (no `node:*`).
  - CLI with a dummy key and `MULTIX_DISABLE_HOME_ENV=1`:
    - `fish voice-design --dry-run` and `--estimate` give $0.01, proven.
    - `fish clone --dry-run` sends a multipart preview with `visibility=private`.
    - `fish voices delete --dry-run` stops at the DELETE preview; without `--yes` it exits 2.
    - `fish clone --estimate` reports unsupported (unpriced).
- Docs checked against Fish's pages:
  - Pricing: `voice-design-1` costs $0.01 per successful request; voice creation has no listed price.
  - Create-model schema: `voices` takes 1-20 files, visibility `public|unlist|private` (public is downgraded), success is 201.
  - Voice-design OpenAPI: candidate fields and `reference_text` max 150.

## Hard-constraint verdicts
| Constraint | Verdict |
|---|---|
| Paid/creating POST never retried; possibly-accepted -> UNKNOWN_REMOTE_STATE | Holds for tts, voice-design and clone. `postFishOnce` uses `fetchFollowingRedirects` (no retry), maps post-send failures through `fishFetchFailure`, and maps gateway 5xx/408 without a Fish body. Clone maps an unreadable 2xx and a 2xx without an id to UNKNOWN. Voice-design maps a cut-off 2xx body to UNKNOWN. One gap remains for clone (Medium-2). |
| No `node:*` in provider clients | Holds; `check:mcp` bundle check is clean. |
| Keys/prompts/signed URLs not logged | Holds. The debug log has only `n` / sample count, and errors never echo the instruction. Dry-run `request.body` shows the instruction, which matches the existing `fish tts` dry-run behaviour. |
| Tests offline | Holds: injected fetch / mocks only. |
| `fish tts` unchanged by `postFishOnce` refactor | Same apart from one intentional change: a non-JSON **408** is now UNKNOWN_REMOTE_STATE where it used to be `HttpError(408)` (Low-1). Headers, body, signal, `crossOrigin: "error"`, error-body cap, `fishErrorMessage`, `Retry-After`, mime check and stream-failure mapping are identical. The `mime` read was moved after the `!ok` branch, which has no effect. |
| Docs match CLI flags | Flags and defaults match, apart from `design_signature` (Medium-1) and the `--sample` help text (Low-3). |

## Critical
None.

## High
None.

## Medium

### M-1. `design_signature` / `--design-signature` workflow depends on a field Fish does not document
- Files:
  - `src/providers/fish/voice-design-client.ts:92,210`
  - `src/providers/fish/commands/voice-design.ts:133`
  - Docs: `docs-site/src/content/docs/commands/fish.md:163,177`, `vi/commands/fish.md:164,178`, `skill/SKILL.md:497,500`
- Evidence:
  - The voice-design OpenAPI candidate schema (https://docs.fish.audio/api-reference/endpoint/openapi-v1/voice-design) has `id, index, audio_base64, sample_rate, duration_ms, text, instruct, language` and no `signature`.
  - The feature guide does not mention one either.
  - Create-model does accept `voice_design_signatures`, but no Fish doc shows where a caller gets one.
  - No test covers a signature value.
- Scenario: an agent follows the docs. It runs `fish voice-design --json`, reads `design_signature` (`null` in practice) and runs `fish clone --design-signature null ...`.
  - `voice_design_signatures=null` is uploaded.
  - Fish rejects the request ("An invalid signature rejects the request"), or the agent has to improvise.
  - The documented flow cannot be done as written.
- Fix (either option):
  1. Confirm the field with a live probe and cite the source in the client comment, or
  2. Remove `design_signature` from the documented happy path until it is verified. If you keep it:
     - document that it may be `null`;
     - have `clone` refuse `--design-signature` values that are empty or the literal `null`;
     - add a test where a candidate has no signature.

### M-2. Clone treats any Fish-shaped JSON 5xx as a definite "nothing created"
- Files: `src/providers/fish/tts-client.ts:179` (shared `postFishOnce`), used by `createFishClone` at `src/providers/fish/voices-client.ts:209`.
- Why the shared rule is wrong for clone:
  - The rule "Fish JSON error body = nothing happened" comes from TTS billing docs, where an error answer is not billed.
  - For a creating POST, an origin 500 whose JSON has a `status` or `message` key can come after the model row was written (for example, a failure in post-processing or an ASR step).
  - `isFishError` accepts any JSON object with `status`, `message` or `detail`.
- Scenario:
  1. Clone upload → origin returns `500 {"status":500,"message":"Internal error"}`.
  2. The CLI raises `HttpError(500)`, which is a retryable-looking 5xx.
  3. The agent re-runs and creates a second private voice with the same title.
- This is the duplicate the commit explicitly guards against.
- Fix: pass a per-call policy to `postFishOnce`, for example `definiteStatuses`. For clone, treat only 4xx JSON (and the documented 503 "high load") as definite. Map other 5xx to UNKNOWN_REMOTE_STATE with `VOICES_CHECK`. Leave tts unchanged.

## Low

### L-1. `fish tts` behaviour change: a non-JSON 408 is now UNKNOWN_REMOTE_STATE
- File: `src/providers/fish/tts-client.ts:179`.
- Before (6a96c42): the 408 HTML/text answer became `HttpError(408)`, which is retryable, and under `speech generate --fallback` it could move on to the next route. Now the run stops with UNKNOWN_REMOTE_STATE, with no fallback and a "check usage" message.
- This is conservative and is mentioned in the commit message.
- Gaps: no `fish tts` / `speech generate` test pins it (the 408 test is only in `voice-clients.test.ts:174`), and the user-facing docs do not mention it.
- Fix: add a tts-client test for the 408 mapping, or keep 408 handling to voice-design and clone if tts behaviour must stay byte-identical.

### L-2. Voice-design receipt counts $0.01 for an empty-candidates 2xx that Fish says is not billed
- Files: `src/providers/fish/voice-design-client.ts:168` (`onAccepted` before the body is read) and `:190`.
- Fish's guide says requests are "Not billed for ... empty candidate responses". A 200 with `candidates: []` still records `request.count: 1`, so the receipt shows $0.01 actual.
- This over-reports, which is the safe direction. Fix: drop the usage entry (or mark it uncertain) when the parsed body has zero candidates. Keep counting for unreadable or truncated bodies.

### L-3. `--sample` help text lists fewer formats than the code accepts
- File: `src/providers/fish/commands/clone.ts:78`.
- The help says "wav, mp3, m4a, opus". `SAMPLE_EXTENSIONS` and the docs also accept `.ogg` and `.flac`, so help and docs disagree.
- Fix: build the help string from `SAMPLE_EXTENSIONS`.

### L-4. Duplicate or out-of-order candidate `index` overwrites saved files
- Files: `src/providers/fish/commands/voice-design.ts:115`, `voice-design-client.ts:194`.
- The file name uses Fish's `index`. If two candidates share an index, or a non-integer index collides with a fallback position, `writeFileSync` silently overwrites a paid candidate, and the JSON then lists two entries with the same path.
- Fix: use the array position for the file name, or refuse duplicate indexes.

### L-5. Remote MCP: `fish voice-design --count` is not under the operator output cap
- File: `worker/src/jobs/cli-command-policy.ts:162`.
- No `"fish voice-design": { caps: { count: ["count"] } }` entry exists. Today `MULTIX_MCP_MAX_OUTPUTS=4` equals the CLI maximum, so this is harmless. If an operator lowers the cap, voice-design ignores it.
- Price is flat, so cost is unaffected; only the output count is.
- Fix: add the count cap for consistency with the other multi-output commands.

### L-6. `fish voices delete` uses `fetchJson`, which fails on a non-JSON 2xx body
- File: `src/providers/fish/voices-client.ts:137`.
- The Fish spec defines no body for the DELETE 200. An empty body is handled. A plain-text `OK` would raise `HttpError(200, "Invalid JSON response")` after the voice was deleted. A re-run then gets a 404.
- Fix: ignore the body on a 2xx (read it, discard it, catch parse errors).

## Edge cases checked and found OK
- `fish voices delete` without `--yes` exits 2 before any request; dry-run shows the DELETE without sending it.
- `fishModelId` blocks path changes (`../`, `/`).
- Clone:
  - `--consent`, visibility allowlist, sample count/size/extension checks and the transcript-count match all run before any request.
  - Transcripts and signatures are checked again in `cloneForm`.
  - Samples are streamed with `fs.openAsBlob` in the command layer only.
  - `--no-enhance` sends `enhance_audio_quality=false`.
- Voice-design:
  - Strict base64 with a pre-decode size cap. The whole body is capped by `maxDownloadBytes()`.
  - `ResponseTooLargeError` is tagged "still billed".
  - Usage is recorded on 2xx, so the `--max-cost 0.005` acceptance gives `BUDGET_EXCEEDED` (covered by a test).
- The new `requests` meter is only produced by voice-design. `measuredUnits` maps `request.count` alone, and no exhaustive meter switch was missed (typecheck is clean).
- Redirects: a POST answered with 301/302/303 becomes a body-less GET (per `redirect-fetch.ts`). For clone that would land on a GET `/model` list. That list has no `_id`, so the result is UNKNOWN_REMOTE_STATE, the safe outcome.
- The remote policy for `fish voices delete` matches the existing `elevenlabs voices delete` exposure.

## Recommended actions (priority order)
1. M-1: verify or de-document `design_signature`.
2. M-2: clone-specific 5xx handling in `postFishOnce`.
3. L-1: add a tts 408 test, or keep tts unchanged.
4. L-3, L-4, L-6: small fixes.
5. L-2, L-5: optional.

## Metrics
- Typecheck: clean. Lint: 0 issues. Focused tests: 159 passed. `check:mcp`: pass.
- Coverage: not measured.

## Unresolved questions
- Does `/v1/voice-design` actually return a per-candidate `signature` (undocumented)? A live probe needs approval for a $0.01 charge.
- Does Fish's create-model ever return a JSON 5xx after it has persisted the model?

## Resolution

- M-1: fixed by removing the unverified `design_signature` output and `fish clone --design-signature` from the code, docs and skill. It can come back once a live call shows Fish returns the field.
- M-2: fixed. `postFishOnce` takes `creates: true` for clone, so any 5xx other than 503 is an unknown remote state even when Fish answers with its JSON error. A test covers 500, 400 and 503.
- L-1: fixed by restoring tts parity. Only 5xx gateway pages are unknown states; a 408 is an `HttpError` again.
- L-3: fixed. The `--sample` help now lists ogg and flac.
- L-4: fixed. Candidate files are named by their position, not Fish's `index`.
- L-2, L-5, L-6: left as they are. L-2 over-reports, which is the safe direction. L-5 is bounded by the CLI's cap of 4. L-6 (DELETE goes through `fetchJson`, which already accepts an empty 2xx) is unlikely and leaves no paid state behind.
