# Code review: OpenRouter text-to-speech (#290)

- Commit: e9603a4 on `claude/gracious-heisenberg-ids32w`, diff `origin/main...HEAD` (28 files, +2194/-22)
- Reviewer context: isolated review. No source changes made. The paid POST /audio/speech was never called.
- Verification run: `npm run lint` clean, `npm run typecheck` clean, `npm run build` ok, `npx vitest run` 91 files / 1554 tests passed, `npm run check:mcp` passed (bundle clean). Regenerating `worker/src/cli-catalog.json` (`npm --prefix worker run catalog`) gives no diff, so the committed catalog is in sync (the file was restored afterwards).
- Live free checks: `GET /api/v1/models?output_modalities=speech` (36 models, default `google/gemini-3.8-flash-tts` exists with 30 voices); `multix openrouter speech-models`; `multix openrouter tts --dry-run --json` (stops before the POST, envelope has `request` and `dry_run: true`).

## Blocking

### B1. Gateway 5xx after the paid POST is reported as retryable, not UNKNOWN_REMOTE_STATE
`src/providers/openrouter/speech-client.ts:237-245`

Every non-2xx answer becomes a plain `HttpError`. `classifyError` turns 502/503/524 into `PROVIDER_UNAVAILABLE` (retryable, hint "retry later") and 504 into `TIMEOUT` (retryable). A Cloudflare 524/504/502 HTML page from OpenRouter's edge means the origin may still be generating, and charging for, the audio. An agent that follows the hint sends a second paid request.

Evidence (tsx probe with an injected fetch that returns `text/html` 5xx):
```
502 HTTP_ERROR PROVIDER_UNAVAILABLE retryable=true
504 HTTP_ERROR TIMEOUT              retryable=true
524 HTTP_ERROR PROVIDER_UNAVAILABLE retryable=true
```
The repo already handles this case for fal: `src/providers/fal/run-helpers.ts:60-63` (`isAmbiguousSubmitFailure` treats a gateway 5xx as UNKNOWN_REMOTE_STATE). The new test `speech-client.test.ts:94-113` locks in the opposite rule (`retryable` when `status >= 500`).

Fix: after a 5xx, return `unknownState(model, \`HTTP ${status}\`, generationId)` unless the body is OpenRouter's own JSON error envelope (`{"error":{"code":5xx,...}}`), which is a definite answer. At a minimum, cover 502/504/520-524 that come with non-JSON bodies. Add a test with a 524 HTML body.

(Judgment call: OpenRouter's own JSON 5xx answers such as "Provider returned error" are definite and can stay retryable. Only the edge or gateway pages are ambiguous.)

## Should-fix

### S1. `openrouter generation <id>` records the generation's cost as its own spend, so `history stats` counts it twice
`src/core/usage-extract.ts:151-156` together with `src/providers/openrouter/commands/generation.ts`

The new rule `/^(data\.)?total_cost$/` makes every GET /generation response report `cost_usd`. `tts` needs that. But the read-only `openrouter generation` command is also recorded in history (`UNRECORDED` at `src/agent/agent-runtime.ts:32` does not exclude it), and `historyStats` (`src/commands/agent/history-command.ts:94`) adds up `usage.cost_usd` per provider and command. Each lookup of a generation that `tts` already costed adds its cost again under provider `openrouter`. The docs tell users and agents to run that lookup after an UNKNOWN_REMOTE_STATE failure or a missing cost.

Fix: either keep GET /generation out of telemetry usage for the `generation` command (for example, add `openrouter generation` to a no-usage list, or attach the cost only inside `tts`), or report it under a non-summed metric for that command.

### S2. `speech-models` shows Gemini's per-token price as "$/s of audio"
`src/providers/openrouter/commands/speech-models.ts:214-221`, `src/providers/openrouter/speech-client.ts:282`

Live output:
```
google/gemini-3.8-flash-tts   ...  30 voices  $0.000009/s of audio
google/gemini-3.8-flash-lite-tts   30 voices  $0.000006/s of audio
```
For Gemini, OpenRouter lists `prompt` = 0.0000005 and `completion` = 0.000009. Those are prices per input text token and per output audio token ($0.5 and $9 per 1M tokens), not per second. The `completion`-means-per-second reading holds only for `bytedance-seed/seed-audio-1-0` (prompt 0). The listed price is about 25x too low, and users rely on it to choose a model. `estimateCost` correctly returns null for these models.

Fix: label the price as per second only when `prompt` is 0 or missing. When both are set, print `$X/1M input tokens + $Y/1M output tokens`. Fix the `SpeechModel.pricing` doc comment to match.

### S3. `--format wav|pcm` wraps or saves any bytes as PCM without checking the response type
`src/providers/openrouter/commands/tts.ts:378-384`

Only the mp3 path has a sanity check (`looksLikeMp3`). Suppose a user picks `--format wav` for a model whose adapter ignores `response_format` and returns `audio/mpeg` (the code already assumes such adapters exist, see `MP3_ONLY`). The MP3 bytes then get a RIFF header, and the command reports success with a bogus `duration_s` and `sample_rate_source`. The result is a corrupt WAV file.

Fix: for pcm/wav, refuse or warn when `speech.contentType.mime` is set and is not `audio/pcm`, `audio/l16` or `audio/wav`, or when `looksLikeMp3(bytes)` is true. Save the bytes under their real extension instead of wrapping them.

### S4. The catalog match ignores case, but the request and the format rules use the raw `--model` spelling
`src/providers/openrouter/commands/tts.ts:312-321, 346-356`; `speech-audio.ts:23-24`

`findSpeechModel` matches `Google/Gemini-3.8-Flash-TTS` and the check passes. But `resolveSpeechFormat` runs on the raw string first, so `PCM_ONLY` (case-sensitive) misses it and `auto` resolves to mp3. `body.model` also keeps the user's casing. The paid request then goes out with `response_format: "mp3"` to a pcm-only model, and the request most likely fails after the check said it was fine.

Fix: once the catalog matches, set `model = entry.id` and resolve the format after the catalog check, or lowercase the model before applying the family regexes.

## Nits

- N1. `src/providers/openrouter/commands/generation.ts:137-141`: "not found yet ... retry shortly" is thrown as `ValidationError`. It classifies as `INVALID_INPUT` (exit 2, not retryable, hint "nothing was billed"), which contradicts the message. Throw an error that classifies as `NOT_FOUND` or `TIMEOUT` instead.
- N2. `speech-client.ts:257-258`: `ResponseTooLargeError` while the audio is streaming discards a generation that is already billed, and the error does not include `generationId`. Put the id in the message so the cost can be traced.
- N3. `usage-extract.ts:155`: `^total_cost$` at the top level now counts as USD for every provider, not just OpenRouter. No current fixture uses it, but `data.total_cost` alone, or matching on the OpenRouter host, would be tighter. Also, `collectIds && value.length === 1` still records a catalog id when a list endpoint returns exactly one entry (verified: `extractUsage({data:[{id:"only-model"}]}).ids` gives `["only-model"]`). This is harmless but defeats the purpose of the change.
- N4. `tts.ts:140,150`: `--text` and `--prompt` given together are counted as one source, and `--prompt` is silently dropped. Refuse the combination, as is done for the other sources.
- N5. `tts.ts:77-83`: `readUtf8` reads the whole file before the 100,000-character cap applies. A stray multi-GB `--text-file` loads fully into memory. A UTF-8 BOM is not stripped, so it is sent to the model. Check `statSync().size` against a byte bound and strip a leading `﻿`.
- N6. Memory: the audio is held as chunks, then copied by `concat`, then copied again by `pcmToWav` (about 3x) under a default cap of 2 GB. Realistic TTS output is far smaller, so this is low priority.
- N7. Docs and UX: the README synopsis shows `[--voice Kore]` as optional, yet the default model (`google/gemini-3.8-flash-tts`) always fails without `--voice`, so `multix openrouter tts --text hi` never works with defaults. Either give Gemini a default voice or make the synopsis show `--voice` as required for Gemini and ElevenLabs. The prose below the README synopsis is correct.
- N8. `speech-models --json` emits camelCase (`canonicalSlug`), while the JSON of `tts` and `generation` is snake_case.

## Checked, no issue found

- Billing safety of the POST: `fetchFollowingRedirects` is called once with `crossOrigin: "error"` and there is no retry wrapper. `fetchJson` (used only for the GETs) does not retry. Network rejections are UNKNOWN_REMOTE_STATE unless ECONNREFUSED, ENOTFOUND, EAI_AGAIN or ENETUNREACH proves nothing was sent. The 300 s overall timeout and the 60 s idle timeout during the body read both map to UNKNOWN_REMOTE_STATE with the generation id. TLS and header faults stay deterministic errors. Audio is written to disk before the cost polling starts.
- Bounded reads: error bodies are capped at 64 KB with a 500-character snippet. Audio is checked against the declared Content-Length and the streamed byte count. Catalog responses are capped at 8 MB and /generation at 1 MB.
- Leakage: the key goes only into headers. Error messages contain the model, a scrubbed fetch detail and the generation id, never the text. Debug logs record only the character count. Dry-run output redacts header values (header names only). Text up to 400 characters appears in the dry-run body, which matches existing commands.
- `--dry-run`: the catalog GET is skipped and the telemetry hook stops at the POST, with `dry_run: true` and a `request` envelope. A key is still required, as with the other commands.
- usage-extract id change: no consumer outside telemetry (`src/agent/fetch-telemetry.ts:190-191`). For other providers, ids in multi-item arrays sit at depth 3 or deeper (Leonardo `generated_images`) or are not ID_KEYS (`voice_id`, `url`), so no provider_ids regression. The full suite passes.
- Runtime neutrality: `speech-client.ts` and `speech-audio.ts` have no `node:*` imports, and `check:bundle` is clean.
- MCP: the `openrouter tts` policy maps `--text-file` and `--turns-file` to downloaded inputs. `--output` falls under the global OUTPUT_FILE_OPTION rule. `speech-models` and `generation` need no file policy. The catalog is regenerated and in sync.
- Tests: no paid calls by default. The live smoke test is gated on `MULTIX_LIVE_TESTS=1` plus a key.
- Docs: EN and VI match each other and the code (flags, defaults, cost-wait max 120, format rules, UNKNOWN_REMOTE_STATE guidance). `.env.example`, `project-env-names.ts`, README, SKILL.md and the environment reference all list `OPENROUTER_TTS_MODEL`.

## Recommended actions (priority order)
1. B1: map gateway or non-JSON 5xx answers on the POST to UNKNOWN_REMOTE_STATE and update the test.
2. S1: stop `openrouter generation` from counting cost as spend in history.
3. S2: fix the per-token and per-second price labels.
4. S3: validate the response type for wav/pcm output.
5. S4: use the catalog's canonical `entry.id` for the request and the format rules.
6. Nits as time allows.

## Unresolved questions
- Does OpenRouter bill a TTS generation that finishes after a Cloudflare 524 or 504 was returned to the client? If OpenRouter guarantees it does not, B1 drops to should-fix. Without that guarantee, the fal precedent applies.

## Resolution (implementer, 2026-10-26)

| Finding | Outcome |
|---|---|
| B1 gateway 5xx after the paid POST | Fixed: a 5xx without OpenRouter's JSON error body is `UNKNOWN_REMOTE_STATE` (not retryable) and names the generation id; tests for 502/504/524 HTML pages. |
| S1 cost counted twice by `openrouter generation` | Fixed: the read-only lookup records no usage in the envelope or history (`SPEND_LOOKUPS` in `agent-runtime.ts`); verified live (`usage` absent). |
| S2 Gemini price shown per second | Fixed: prompt+completion pricing is shown per input/audio token; per second only for completion-only models (Seed Audio). Verified against the live catalog and a live Gemini charge (6 x $0.5/1M + 48 x $6/1M = $0.000291). |
| S3 no format check for wav/pcm | Fixed: MP3 bytes returned for a pcm request are saved as `.mp3` with a warning instead of a corrupt WAV. |
| S4 model case | Fixed: the request and result use the catalog spelling; family rules ignore case. Verified live with `Google/Gemini-3.8-Flash-Lite-TTS`. |
| Nit 1 generation not found | Now `NOT_FOUND` with "retry shortly if the id is right". |
| Nit 2 oversized audio drops the id | The error now names the generation id. |
| Nit 3 top-level `total_cost` | Narrowed to `data.total_cost`. The single-item list case is kept: a one-element array is how job APIs return their own job. |
| Nit 4 `--text` with `--prompt` | Rejected. |
| Nit 5 text file size / BOM | Size checked before reading; a leading BOM is stripped. |
| Nit 6 audio copies in memory | Not changed: speech output is seconds to minutes (KB to a few MB); the cap is the shared download cap. |
| Nit 7 README synopsis | `--voice` shown as required for the default model. |
| Nit 8 `speech-models --json` camelCase | Now snake_case with a `price` string. |
