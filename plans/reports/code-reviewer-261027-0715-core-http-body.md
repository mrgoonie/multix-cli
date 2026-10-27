# Code review: move shared HTTP body helpers to src/core (#358)

Commit `6dd7276` on `claude/gracious-heisenberg-co1c1e`. Reviewed in isolation on 2026-10-27, UTC.

## Scope
- Files: `src/core/http-body.ts` (new), `src/core/audio-kind.ts`, `src/providers/openrouter/speech-client.ts`, `src/providers/openrouter/speech-audio.ts`, `tests/unit/core/http-body.test.ts` (new), `tests/unit/core/worker-safe-http.test.ts`
- LOC: +248 / -133
- Base: the branch was cut from `9a63e7d`. After `git fetch`, `origin/dev` is at `6a96c42`, two commits ahead (`c955217` feat(fish), PR #359, merged 07:07:45Z).

## Overall assessment
Taken on its own, the refactor is correct: the moved code behaves exactly as before, every previous export is kept, and the new modules are runtime-neutral. **Against current `dev`, though, it is superseded.** PR #359 already landed `src/core/response-read.ts`, which holds the same helpers. The Fish clients on `dev` import from that module and nothing under `providers/openrouter`, so #358's acceptance criteria are already met on `dev`. This commit also does not merge cleanly into `dev`.

## Critical (blocking)

1. **Duplicates a module that is already on `dev`, and conflicts with it.**
   - `origin/dev:src/core/response-read.ts` exports `NOT_SENT_CODES`, `UNKNOWN_REMOTE_STATE`, `concatBytes`, `readCappedText`, `errorCodes` and `readCappedBytes`. `readCappedBytes` is this commit's `readAudio` under another name.
   - On `dev`, `openrouter/speech-client.ts` and `fish/tts-client.ts` both import from it already.
   - A test merge of `origin/dev` into this commit conflicts in `src/providers/openrouter/speech-client.ts`, checked in a throwaway worktree.
   - Resolving the conflict naively leaves two parallel core modules with the same helpers (`http-body.ts` and `response-read.ts`). That is exactly the drift the issue tries to remove, and AGENTS.md forbids parallel reimplementation.
   - Fix: drop `http-body.ts`. If anything is still wanted, rebase onto `dev` and keep only the parts that add value:
     - the `audio-kind.ts` move of `parseAudioContentType` and `looksLikeMp3`;
     - the provider-isolation guard;
     - the `worker-safe-http` entry, which would then list `response-read.ts`, if it is not already covered.

2. **Claim order (AGENTS.md "Issue workflow", step 3).**
   - Issue #358 carries an earlier claim: `session_01FL32rwz7btZUHaosyAzbRy`, branch `claude/gracious-heisenberg-7ljaxd`, at 07:07:01Z. That branch exists on the remote.
   - This branch's claim is at 07:07:12Z, 11 seconds later.
   - Under the repo rule the first claim wins, so this session should stop and support that branch, and post a `Released` comment.
   - Combined with item 1, this PR should not be opened as it stands.

## High
None in the code itself.

## Medium (optional)

3. **The guard regex misses some import forms.** The pattern is `/from\s+["'][^"']*\/openrouter\//`. Against `origin/dev` it reports no offenders and no false positives.
   - Not caught by the regex:
     - side-effect imports, `import "../openrouter/x.js"`;
     - dynamic imports, `import("../openrouter/x.js")`;
     - `.tsx` / `.mts` files, because only `.ts` files are scanned.
   - Not scanned at all:
     - top-level files in `src/providers/*.ts`, such as `provider-keys.ts`, because the walk only enters subdirectories;
     - `src/core/**`, where an import from a provider would be worse.
   - It can match text in comments and string literals, for example a doc comment saying `from "…/openrouter/…"`. The risk is low, since no such text exists today.
   - Suggested pattern: `/(?:from\s+|import\s*\(?\s*)["'][^"']*\/openrouter\//`.
   - Consider moving the guard into its own `tests/unit/providers/provider-isolation.test.ts`. It has nothing to do with `http-body`, and a reader looking for architecture guards will not look there.

4. **The guard passes vacuously on this branch's base.** No provider imported from `openrouter/` at `9a63e7d`, so the test proves nothing yet. It only becomes meaningful after a rebase onto `dev`, which has Fish, and there it passes as well.

## Low
- `readAudio` was module-private in `origin/dev~2:speech-client.ts` and is now exported from both `core/http-body.ts` and the OpenRouter re-export. This is additive and harmless, but it widens the public surface of the OpenRouter module without need.
- `path.resolve("src/providers")` depends on the working directory. Other tests already do the same (`url-safety.test.ts`, `atlascloud/prediction-output.test.ts`), so it matches repo convention.

## Verification of the requested checks
1. **The moved code behaves the same.** I compared line by line against `git show 9a63e7d:<path>`.
   - These are token-identical apart from comments: `readCappedText`, `concat`, `errorCodes`, `readAudio`, `NOT_SENT_CODES` and `UNKNOWN_REMOTE_STATE` in `http-body.ts`, and `parseAudioContentType`, `AudioContentType` and `looksLikeMp3` in `audio-kind.ts`.
   - Comment changes: "never reached OpenRouter" became "never reached the server", and the module docblocks were extended.
   - `ResponseTooLargeError` is still imported and used in `speech-client.ts`, so the import is not dead.
2. **Exports are preserved.**
   - `speech-client.ts` still exports `UNKNOWN_REMOTE_STATE`, `NOT_SENT_CODES`, `readCappedText` and `errorCodes`, and now also `readAudio`.
   - `speech-audio.ts` still exports `AudioContentType` (type), `parseAudioContentType` and `looksLikeMp3`.
   - A test asserts identity (`toBe`) between the re-exports and the core implementations.
3. **Runtime neutrality.**
   - `http-body.ts` imports only `./errors.js`.
   - The `audio-kind.ts` additions have no imports.
   - Both files were added to `WORKER_SAFE_MODULES`, and that test passes.
4. **Guard regex.** Correct for the forms in use today. Its gaps are listed in item 3.
5. **Tests.** `npx vitest run tests/unit/core/http-body.test.ts tests/unit/core/worker-safe-http.test.ts` gives 2 files and 85 tests passing.
   - The idle-timeout test uses a real 20 ms timer, which is cheap and not flaky.
   - The `readCappedText` test covers truncation inside a chunk.
   - Not covered:
     - the `content-length` early rejection in `readAudio`;
     - the `"(could not read body)"` path.
   - Both are optional.

## Edge cases from scouting
- `origin/dev` moved during the work. The Fish PR (#359) merged at 07:07:45Z and brought its own core module, which makes this branch stale.
- There is a parallel claimant branch, `claude/gracious-heisenberg-7ljaxd`.
- On `dev`, Fish does not import `parseAudioContentType` or `looksLikeMp3` from OpenRouter; it has its own `fish/audio-check.ts`. That weakens the reason for the `audio-kind.ts` move, which is now optional tidying rather than an acceptance item.

## Recommended actions
1. Do not open a PR from this commit as it stands. Coordinate on #358 with the earlier claim (`7ljaxd`) and release this claim.
2. If any part is kept, rebase onto `origin/dev`, delete `src/core/http-body.ts`, and use `src/core/response-read.ts`. Keep only the `audio-kind.ts` move and the isolation guard, with the regex widened and the guard in its own test file.
3. Note on #358 that #359 already satisfies its acceptance criteria. The issue may simply be closeable.

## Metrics
- Type coverage: no `any` and no suppressions in the diff.
- Focused tests: 85/85 pass.
- Lint: clean, as reported by the caller; not re-run.

## Unresolved questions
- Does the earlier claimant (`7ljaxd`) plan to open a PR, or should #358 be closed as done by #359?

Status: DONE_WITH_CONCERNS
Summary: The refactor itself behaves the same, keeps every export and is runtime-neutral, but it is superseded. `origin/dev` already has `src/core/response-read.ts` from #359 with the same helpers, this commit conflicts with `dev`, and an earlier claim on #358 exists.
Concerns/Blockers:
- blocking: duplicates `src/core/response-read.ts` on `dev` and conflicts in `openrouter/speech-client.ts`; rebase and drop `http-body.ts`.
- blocking (process): an earlier claim on #358 (branch `claude/gracious-heisenberg-7ljaxd`, 07:07:01Z) takes precedence under AGENTS.md.
- optional: the guard regex misses side-effect and dynamic imports and skips top-level provider files and `src/core`; move it to its own test file.
- optional: `readAudio` is now exported needlessly; there are no tests for the `content-length` rejection or the read-error path.
