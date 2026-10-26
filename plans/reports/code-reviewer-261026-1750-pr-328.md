# Code review: PR #328, feat(openrouter): speech-to-text via /audio/transcriptions (Closes #303)

Reviewer: isolated (did not write the code). Date 2026-10-26. Head `cb84e44`, merge-base `f9a84c7`, compared with `origin/main` `b9bc563`.

## Scope
- 34 files, +1844/-64. New: `src/providers/openrouter/transcription-client.ts`, `commands/transcribe.ts`, `commands/transcription-models.ts`, 3 test files. Changed: `run-state.ts` (`summarizeUsage`), `usage-extract.ts` (`x-generation-id`), `speech-client.ts` (exports), `generation.ts` (`waitForGeneration` moved), worker policy and catalog, docs (EN+VI), SKILL, README, `.env.example`.
- Main moved on since the merge-base: #326 (redacts the URL query in dry-run bodies) and #327 (budget: estimate, `--max-cost`, `multix.cost/v1` receipt).

## Verification (trial merge of origin/main + pr-328 in a temporary worktree, now removed)
- Textual conflicts: only `skill/SKILL.md` (frontmatter description/version) and `tests/smoke/agent-mode.test.ts` (two new tests at the same spot). Everything else auto-merges, including `run-state.ts` and `usage-extract.ts`, which #327 also changed.
- After resolving (PR description + `version: 1.18.1`; keep both tests): `typecheck` clean, `lint` clean (527 files), `build` OK, `vitest`: 103 files / 1768 passed / 18 skipped, `check:mcp` passes (bundle clean), worker `catalog` regenerated with no drift (123 commands).
- Probes on the merged `dist/cli.js`:
  - `transcribe --input 'https://…/talk.m4a?X-Amz-Signature=SECRETSIG' --dry-run --json`: the body shows `url: "…/talk.m4a?[redacted]"`, no key. #326 covers the new command.
  - `--estimate`: `status: unknown, reason: unsupported`, the same as `openrouter tts` on main.
  - `--max-cost 0.01`: `BUDGET_UNPROVEN`, exit 2, nothing sent (fails closed). Consistent with main.
- `transcription-client.ts` has no `node:*` imports, and neither do the modules it imports (`redirect-fetch`, `fetch-json`, `fetch-error`, `speech-client`). The command layer keeps `node:fs/crypto/path`. AGENTS.md is followed.
- Side effect of the probes: four dry-run/estimate entries were appended to `~/.multix/history.jsonl` (argv redacted, fake key).

## Correctness
- Multipart: `FormData` with `file` (Blob, MIME from the format, else octet-stream, filename `audio.<fmt>`), `model`, `language`. Any caller `Content-Type` is removed so fetch sets the boundary. Correct.
- URL: JSON `input_audio {url, format}`. `checkAudioUrl` requires http/https, no credentials, and at most 8000 chars. When the URL has no extension, `--audio-format` is required.
- Size: 25 MB is checked twice, with `stat` before the read in the command and with `byteLength` in the client. An empty file is refused. The response is capped at 16 MB, and error bodies at 64 KB.
- Paid POST is never retried. The timeout covers both the request and the body read. A cut connection, a gateway 5xx that is not OpenRouter JSON, or a broken stream gives `UNKNOWN_REMOTE_STATE`. ECONNREFUSED/ENOTFOUND are mapped as not sent. A cross-origin redirect is refused. 303 (and 301/302 after a POST) turn into GET as the Fetch spec says, and 307/308 resend the FormData.
- `summarizeUsage`: the POST's cost or credits are skipped when a GET with the same id reports that unit. The receipt on main (`costReceiptFor({usage: summarizeUsage()})`) therefore gets the right figure without double counting. Tests on main (`cost-receipt.test.ts`) still pass after the merge.
- Key and signed URL: the key is only in headers. `input` in the result goes through `safeUrl` (no query). Errors name the OpenRouter endpoint, not the audio URL. History argv is redacted by `redactArgv`.
- Tests: the client test injects `fetch` and uses no network. The live test is gated by `MULTIX_LIVE_TESTS=1` and the key.
- Docs EN+VI match (openrouter, commands, providers, environment, for-ai-agents). `check.ts` and setup hints need no change because there is no new key. `OPENROUTER_STT_MODEL` is in `.env.example` and `project-env-names.ts`.

## Findings

### Critical / High
None.

### Medium
1. Conflict resolution is required before merge (see the guidance below). It is mechanical.
2. `transcribe` has no pre-flight estimator, so `--max-cost` always refuses with `BUDGET_UNPROVEN`. This matches `openrouter tts` on main, so it is not a regression, and it fails closed. A good follow-up issue: an estimator from the catalog price × duration. Duration can't be known for a URL input, so that case stays unknown.

### Low
3. `--language` accepts `en-US`. Whisper/OpenAI need ISO-639-1 and may answer 400 for a tag. The 400 maps to `HttpError` (not paid), so the impact is low. Consider documenting it, or sending only the primary subtag for `openai/*`.
4. `readBody` in `transcription-client.ts` re-implements capped reading next to `readCappedText` and `concat` in `speech-client.ts`. The semantics differ (throw vs truncate), so this is acceptable, but a shared helper with a `throwOnOverflow` flag would remove the duplication.
5. An OpenRouter error message (`errorMessageOf`) could echo the audio URL, query included, if the upstream provider reports "failed to download <url>". It only affects error text on a URL input. Consider passing it through `safeUrl`/redact, or file it as a separate issue like #318.
6. `MIME_BY_FORMAT` does not cover `mpga`, `mpeg`, `oga`, `pcm`. They fall back to octet-stream, and the provider still infers the format from the filename extension, so this is not a bug.
7. The PR includes `plans/reports/code-reviewer-261026-0530-openrouter-stt.md`. Consistent with AGENTS.md.

## Conflict resolution guidance
- `skill/SKILL.md`: take the PR's `description` (adds the OpenRouter STT list) and keep main's `version: 1.18.1 # x-release-please-version`. Do not take `1.16.0`.
- `tests/smoke/agent-mode.test.ts`: keep both tests, main's "dry run never prints a URL query value…" and the PR's "dry run of openrouter transcribe…", each closed with its own `});`. Optionally add a signed-URL case to the transcribe test asserting `?[redacted]`, which the probe confirmed works after the merge.
- Rebase or merge main, then run `npm run lint && npm run typecheck && npm run build && npm test && npm run check:mcp`. `cli-catalog.json` needs no regeneration because no drift was found.

## Unresolved questions
- Should `openrouter transcribe` and `tts` get a pricing estimator in `src/budget/command-cost.ts` (a separate issue)?
