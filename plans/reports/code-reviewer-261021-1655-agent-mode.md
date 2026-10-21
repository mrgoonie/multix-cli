# Code review: agent mode (#277), `git diff main...HEAD`

Scope: 3 commits, ~3.1k LOC, src/agent/*, src/core/{error-classify,usage-extract}.ts, src/commands/agent/*, worker/src/mcp-server.ts.
Checks: focused vitest (26 pass), typecheck clean, lint clean. Experiments ran with tsx and a stubbed fetch. No build, no paid calls.

## Critical

None found. No API key, auth header value or URL query string reaches the envelope, history or dry-run `request`. Verified: header names only, `safeUrl` strips the query, `HttpError` messages go through `redactUrl`, and `usage-extract` keeps only numbers and id strings.

## High

1. **`rerun --dry-run` sends the paid request.** `src/commands/agent/history-command.ts:184-203`. `addGlobalFlags` gives `rerun` its own `--dry-run`, so commander consumes the flag and does not pass it in `extra`. The repro returned `{extra:['--model','x'], opts:{dryRun:true}}`. `rerun` makes no fetch of its own, so the child is spawned without `--dry-run` and bills the provider. Fix: forward `--dry-run` like `--json` (`if (run.dryRun) args.push("--dry-run")`), or add `rerun` to `LOCAL_GROUPS` handling with a reported argv.
2. **Dry run does not cover the OpenAI Codex driver.** `src/providers/openai/codex-image-driver.ts:21-28`, used by `openai generate` and `openai image-to-image` with `--driver codex`, or with `auto` when there is no `OPENAI_API_KEY`. That path runs `codex` through execa, and the fetch wrapper never sees it. `--dry-run` uses up ChatGPT image quota and writes files. Fix: in `runCodexImageGeneration` (or in preAction when `opts.driver` resolves to codex), check `run.dryRun` and finish with `dryRunLocal`/a described command.
3. **The telemetry clone reads unbounded JSON bodies before the caller can read them, which undoes #274's bounded reads.** `src/agent/fetch-telemetry.ts:115,151-153`. `await response.clone().text()` runs before `return response` whenever the content type is JSON and no Content-Length is declared (chunked or gzip). The cap is checked only after the whole body has been read. For Gemini Omni Interaction bodies (up to 384 MiB base64), the body is held in memory about twice over (tee buffer plus string), the caller's `maxBytes` cut-off is skipped, and the `idleTimeoutMs` stall detection in `fetch-json.ts:readText` never runs. A stalled read now hangs until the overall deadline instead of failing fast and retrying. Non-JSON responses are not cloned (confirmed). Fix: do not await usage in the hot path. Read the clone with a byte-counting reader that cancels the clone at 2 MB, or skip it when there is no `content-length`. Also consider cancelling unused clones.

## Medium

4. **Error rule order sends usage errors to TIMEOUT (exit 6, "do not resubmit").** `src/core/error-classify.ts:134` comes before the INVALID_INPUT rule at 145-148. `classifyError(new Error("Invalid --wait-timeout: abc"))` returns TIMEOUT 6 retryable. A pre-submit `File upload failed: timed out` also returns TIMEOUT, and its hint wrongly says a job may be running. TIMEOUT is also `retryable:true` while its hint says not to resubmit. Fix: move INVALID_INPUT and option-name patterns ahead of TIMEOUT, require a job context for TIMEOUT, and make the retryable flag match the hint.
5. **Exit codes change for existing non-JSON users.** `agent-runtime.ts:168-172,320-323`. Commander usage errors move from 1 to 2. Any `process.exit(1)` or `exitCode=1` is reclassified from stderr text (`check` exits 1 but now prints `code: UNKNOWN … hint`). The changelog will publish this as `feat` (minor). Fix: either mark it as breaking or apply class exit codes only with `--json`/`MULTIX_OUTPUT=json`.
6. **`rerun` ignores the recorded cwd.** `history-command.ts:200`. Relative input and `--output` paths resolve against the current directory, so it reads different inputs or writes elsewhere. Fix: `spawnSync(..., { cwd: existsSync(entry.cwd) ? entry.cwd : undefined })`, or warn when they differ.
7. **The ledger stores prompts and signed input URLs by default.** `history-store.ts:56-71`. `redactArgv` redacts only by option name. Repro: `--image-url https://…?X-Amz-Signature=abc` is stored verbatim, and `history show` prints it. AGENTS.md says not to log full prompts. Fix: run `redactUrl` on URL-looking argv values. Consider an opt-in, or document plainly that prompts are stored.
8. **Every run hashes all outputs synchronously.** `output-file-inspect.ts:62-80`, up to 512 MB per file, plus one ffprobe spawn per media file at exit, including non-JSON runs. This adds seconds to large video commands. Fix: hash only in JSON mode, or with a lower cap.
9. **A third key registry.** `commands/agent/provider-group-keys.ts` duplicates `check.ts` and `setup-hints.ts`, will drift, and is not in the AGENTS.md "add a key" checklist. It also reports `openai` as not ready when Codex login works. Fix: derive it from the check registry, or add it to the checklist.

## Low

10. `SECRET_OPTION` falsely matches `--image-key` (replicate video). Its value is redacted and `rerun` then refuses (`history-store.ts:37`).
11. `safeUrl` duplicates `redactUrl` (`fetch-telemetry.ts:24`). Reuse the core helper.
12. Root-level `multix --json …` / `--dry-run …` fail with `unknown option` although `addGlobalFlags(program)` registers them, while `run.json` is still set from argv. It fails safe; either drop the root registration or make it work.
13. `update --json` runs execa with `stdio:"inherit"` (`update.ts:126`), so npm output goes to fd 1 and corrupts the envelope.
14. History rotation race: two processes that rename at the same time can overwrite `.1` (`history-store.ts:79`).
15. File size: `agent-runtime.ts` 329, `error-classify.ts` 237, `models-command.ts` 214 and `history-command.ts` 205 are over the ~200 LOC guideline. Split `finalizeRun` and the envelope/history builders.
16. MCP: `structuredContent` on an `isError` result is fine because no tool declares `outputSchema`, and the SDK skips validation on errors. `error-classify.ts` → `errors.ts` → `redact.ts` contains no node imports, so it is OK for the Worker.

## Verified OK

- `syncBuiltinESMExports` makes named `node:fs` imports and `fs/promises` (default and named) see the wrappers. Tested on Node 24.
- The process.exit wrapper cannot re-enter, because of the `finalized` guard. `update`'s own `--dry-run` keeps its meaning.
- No module captures `globalThis.fetch` at import time. All clients resolve it at call time, and `data:` URIs are decoded locally.
- `MULTIX_HISTORY_FILE` is correctly kept out of the project `.env` list.

## Recommended actions

Fix 1, 2 and 3 before merge. Then fix 4, 5 and 7. Add tests for the fetch wrapper (clone bound, dry-run interception) and for forwarding flags through `rerun`.

## Unresolved questions

- Is the exit code reclassification in non-JSON mode an intentional public contract change? If so, should it be released as major?
- Do Gemini Interaction responses send Content-Length? Finding 3 applies fully only when they do not.
- Is storing prompts in the ledger by default acceptable under the "no full prompts in logs" rule?
