# Code review: OpenRouter speech-to-text (#303)

Scope: `git diff origin/main...HEAD` (bc19cb0 feat, fe6c077 docs; rebased after #313 merged, contents byte-identical to the
pre-rebase head 9ba84b4 except the release-please SKILL.md version line, which I checked). 33 files, +1657/-63.

## Verdict

**Approve with should-fix items. No blockers.** The paid POST is sent once, the classification of ambiguous failures is
conservative and correct, nothing leaks the key, the transcript or signed-URL query strings at info level, and the
summarizeUsage change has no effect on the other providers today. The should-fix items are a fixed 300 s timeout that
long audio can hit after OpenRouter already accepted the request, and a dedupe rule that ignores units, which is a latent risk.

## Findings

### Blocking
None.

### Should-fix

1. **Fixed 300 s timeout, no flag, unbounded URL audio length.** `src/providers/openrouter/transcription-client.ts:230`,
   `src/providers/openrouter/commands/transcribe.ts:195-200`.
   Scenario: you pass a URL for a 1-2 h recording (URL inputs have no 25 MB cap), or a 25 MB file to a slow
   model such as Gemini Transcribe or Scribe. The upload succeeds, OpenRouter starts processing, and the 300 s
   `AbortSignal.timeout` fires. The run fails with `UNKNOWN_REMOTE_STATE` even though the request was probably billed, and you
   have no way to give the request more time. Each retry repeats the same billed request.
   Fix: add `--timeout <s>` (default 300, bounded, e.g. ≤ 1800), forward it as `timeoutMs`, add it to the worker catalog,
   and add one line of docs. Alternatively, scale the default with the input size.

2. **The settle rule ignores units.** `src/agent/run-state.ts` (the `charged` set and `settled` in `summarizeUsage`).
   A GET that carries only `credits` suppresses a POST's `cost_usd` with the same id, and the reverse also happens. I
   reproduced it with a probe: POST `{cost_usd: 0.5, ids:[j1]}` plus GET `{credits: 10, ids:[j1]}` produces `{"credits":10}`,
   so the USD charge disappears from the envelope and from history. I found no provider that hits this today. Runway's
   POST carries only `estimatedCost` (already excluded by `ESTIMATE_PATH`). fal, Replicate and HeyGen polls carry no
   cost or credits. OpenRouter TTS POSTs have no cost, and STT POST/GET both report USD. So the risk is latent, but the
   rule is global and the next provider whose POST and GET report different units will lose money silently.
   Fix: build one charged set per key:
   ```ts
   const chargedBy = (k: "cost_usd" | "credits") =>
     new Set([...state.getUsage.values()].filter((r) => r[k] !== undefined).flatMap((r) => r.ids));
   ```
   Then check `settled` separately for cost and credits (and their `sources`). Add tests for: a GET without
   cost/credits does not settle; a GET with credits does not drop the POST's USD; a settled POST's source is dropped.

### Nits

3. **A 2xx body with `{error:{…}}` loses OpenRouter's message.** `transcription-client.ts:153`. OpenRouter sometimes returns
   200 with an error object. The user then sees only "returned no transcript text". Fix: if `isOpenRouterError(raw)`, put
   `errorMessageOf(raw)` in the ProviderError message.
4. **`--language` accepts more than the docs say.** `transcribe.ts:42`. The regex accepts `en-US`, `zh-Hant` and 3-letter
   codes. The help, docs (EN/VI) and the error message say ISO-639-1. I confirmed with `--dry-run` that `en-US` is sent
   as-is. Either restrict the regex to `^[a-z]{2}$` (case-insensitive) or change the wording to "ISO-639 code".
5. **Size check and read are separate steps.** `transcribe.ts:93-109`. The code checks the size with `statSync`, then calls
   `readFileSync` with no bound. A file that grows between the two calls is read in full into memory. The client re-checks
   `byteLength` before the POST, so nothing oversized is ever uploaded; only memory is at risk. You can leave it, or read
   through a file handle up to `MAX_UPLOAD_BYTES + 1`.
6. **A failed `--output` copy loses cost info after a paid call.** `transcribe.ts:118-127`. If `--output` cannot be
   written (EACCES or similar), the error is thrown after billing and before the cost lookup. The envelope then has no
   `generation_id` or cost. The error is classified UNKNOWN and not retryable, so it cannot cause a double charge.
   This is the same pattern as `tts.ts` `writeAudio`. Check that the `--output` parent directory is writable before the
   POST, or catch the copy error and report it with the generation id.
7. **MCP behaves differently from the CLI for URL inputs.** `worker/src/jobs/cli-command-policy.ts` (`input: "file"`) makes
   the container download the URL and upload it as multipart (`worker/test/run-argv-builder.test.ts`). So under MCP: (a) the shared
   help text "downloaded by the provider" is wrong, (b) URL audio over 25 MB that works from the CLI fails, and (c) a
   dry run shows a multipart body instead of the `input_audio.url` JSON. This is acceptable for the security model, but
   it should be stated in the MCP-facing docs.
8. **Docs promise a generation id that may not exist.** README "STT" paragraph and docs-site EN/VI say "on
   `UNKNOWN_REMOTE_STATE` check `multix openrouter generation <id>`". If the connection drops before response headers,
   there is no id; the error correctly points to https://openrouter.ai/activity instead. Suggested wording: "check the
   generation id or the activity page named in the error".
9. **Unclear price unit.** `transcription-models.ts:292`. "input $x/unit" does not say whether the unit is a second or
   a token. Consider naming the unit when OpenRouter's pricing makes it clear, or keep it and document it.
10. **Test gaps** (beyond item 2): no command-level test asserts that the envelope's `usage.cost_usd` equals
    `out.cost_usd` when both the POST `usage.cost` and the GET `total_cost` exist. That was verified only in the live
    run. A smoke test with a fake fetch returning both values would cover the dedupe end to end.

## Checked, no issue found

- **Runtime neutrality:** `transcription-client.ts` and its imports (speech-client, fetch-json, fetch-error, redirect-fetch,
  errors) have no `node:*` imports. Node is used only in the command layer.
- **POST never retried:** the client makes one `fetchFollowingRedirects` call with `crossOrigin: "error"`, so the
  Authorization header never goes to another origin; there is no retry wrapper. The tests assert one call for
  400/401/402/413/429/502/503.
- **Error classification** (checked with the real `classifyError` from a throwaway probe, which I removed afterwards):
  - Connection reset or timeout after sending: `UNKNOWN_REMOTE_STATE`, not retryable.
  - Refused / DNS / unreachable: network error, retryable.
  - HTML gateway 5xx: `UNKNOWN_REMOTE_STATE`, naming the generation id when present.
  - OpenRouter JSON 5xx and 429: retryable `HttpError`. This matches the TTS precedent; OpenRouter does not bill failed requests.
  - Empty, missing or malformed transcript and response > 16 MB: `ProviderError`, classified UNKNOWN and not retryable,
    so an agent will not resend a possibly billed request.
  - Unknown model: `INVALID_INPUT`, raised before any paid call.
- **Bounded reads:** the response is capped at 16 MB, the error body at 64 KB, and the catalog at 8 MB. Telemetry reads
  its clone under `MAX_JSON_BYTES`.
- **Leaks:** dry runs for both a file and a URL list header names only, never the key. `input` and `next` strip the URL
  query (`?[redacted]`). History entries do not store `data`, so the transcript stays out of `~/.multix/history.jsonl`.
  Text mode prints only the file path. The debug line has no URL or transcript. The echo of the query string in the
  dry-run body is the known, separately filed issue.
- **summarizeUsage effect on other providers:** I checked Runway (POST `estimatedCost` excluded, GET `cost.credits`), fal and
  Replicate queue polls (no cost/credits), the OpenRouter TTS POST (no cost; it now gains the `x-generation-id` id, which
  is an improvement in `provider_ids`), and the OpenRouter image chat POST (no GET). The rule changes nothing for any of them. The OpenRouter
  `/generation` GET collects `data.id`, which matches the `x-generation-id` header, so the STT POST estimate is counted
  once. Tokens are not double counted: `/generation` has no `usage` object.
- **Input resolution, run through the built CLI with `--dry-run` and a fake key behind a dead proxy:**
  - Rejected: a URL with no extension (`?file=a.mp3`, `/.mp3`, `%2E`), `file://`, a directory, and `mp3;rm` as the format.
  - Rejected: bare model `foo` and a non-numeric `--cost-wait`.
  - Accepted: an uppercase `--audio-format`, which is lowercased and gets the right MIME type.
  - Accepted: a trailing-slash URL `/a.mp3/` (harmless).
- **`multix models --task transcription`** lists `openrouter transcribe` with its default, its example models and
  `list: multix openrouter transcription-models`. The lister filter does not leak `transcription-models` into
  other OpenRouter tasks.
- **Docs vs `node dist/cli.js openrouter transcribe --help`:** the flags, defaults (`openai/whisper-large-v3-turbo`,
  `--cost-wait 20`), the 25 MB cap and the URL caveat match README, `.env.example`, SKILL.md and docs-site EN/VI (apart
  from items 4 and 8). The worker catalog entry matches the help.
- **The live smoke test** is gated by `MULTIX_LIVE_TESTS=1` plus the key. Mocked tests cover 4xx/429/5xx, empty
  transcript, oversized input, multipart vs URL, and no key in output.
- I did not re-run lint, typecheck, the full test suite, `check:mcp` or `verify:docs`; you reported them green.

## Housekeeping
- A stray `vitest --root /` probe I started was killed. A temporary probe test under `tests/unit/zz-review-probe/` was
  removed after it ran. My first two dry runs, made before I set `MULTIX_HISTORY=0`, appended two `dry_run` entries to
  `~/.multix/history.jsonl` (05:30 UTC).

Status: DONE_WITH_CONCERNS
Summary: No blockers. Two should-fix items: the fixed 300 s timeout can turn long transcriptions into UNKNOWN_REMOTE_STATE after billing, and the summarizeUsage settle rule ignores units (latent; no current provider hits it).

## Resolution (commit acbd3f5)

- Should-fix 1: added `--timeout <s>` (default 300, 10–3600), passed to the client and listed in the worker catalog; docs EN/VI updated.
- Should-fix 2: `summarizeUsage` now settles cost and credits against separate id sets; test covers a credits-only GET leaving the POST dollars counted.
- Nit 3: a 2xx body with `{error}` now carries OpenRouter's message.
- Nit 4: help, error and docs say "ISO-639 code or a tag like en-US".
- Nit 7: docs note that through the remote MCP server a URL is downloaded by the server and uploaded (25 MB limit applies).
- Nit 8: docs say to use `generation <id>` when the error names one, else openrouter.ai/activity.
- Nit 9: price label reads "/unit (second or token, by model)".
- Nits 5, 6, 10: kept as is (no double charge or oversized upload is possible; same behavior as `tts`; the envelope cost was verified live).
