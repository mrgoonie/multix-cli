# Code review: native Runway Dev API provider (commit 181f948, issue #229)

Reviewer: isolated code-review agent; did not write the code. Date: 2026-10-15 (UTC).

## Scope
- Commit 181f948 on `claude/gracious-heisenberg-22nfb5`: 48 files, about 3.9k lines (including 451 generated catalog lines).
- Reviewed: `src/providers/runway/**`, `src/core/logger.ts`, `src/commands/{index,check}.ts`, `src/providers/provider-keys.ts`, `src/project-env-names.ts`, the worker policy and secret-name diffs, `tests/unit/providers/runway/**`, and the EN docs page, README and skill diffs.
- Checked against `@runwayml/sdk` 4.22.0 typings for gen4.5 and gen4_turbo (`image_to_video`), gen4.5 (`text_to_video`), gen4_image and gen4_image_turbo (`text_to_image`), and uploads.
- Commands run:
  - `npx vitest run tests/unit/providers/runway`: 53 passed, 1 skipped (live test).
  - `npm run typecheck`: clean.
  - `biome check` on the changed files: clean.
  - `node dist/cli.js runway ... --help`.
  - A local fake Runway server (RUNWAY_BASE_URL=http://127.0.0.1) to check what `status` prints. The real API was never called.

## Overall assessment
The code is solid. Request bodies, ratios, durations (gen4.5), prompt limits, tag rules and reference counts match the SDK typings. Creates retry only on 429. Network errors, 5xx and unusable 2xx responses carry a dashboard hint about possible orphaned (and billed) tasks. Task IDs from the server and from the user are restricted to `[A-Za-z0-9-]`, and output file names are sanitized, so neither can be used for path traversal. Download URLs, upload URLs and every redirect hop go through `checkUrlSafety`. The upload POST does not carry the API key and uses `redirect: "manual"`. The runtime-neutral files (`client.ts`, `models.ts`, `output.ts`, `types.ts`) and their core dependencies have no `node:*` imports. There are no critical or high findings. Two medium findings are worth fixing before merge.

## Critical
None.

## High
None.

## Medium

### M1. `cancel` can delete a finished task's paid outputs without `--delete`
- **Where:** `src/providers/runway/client.ts:326-337`, reported by `src/providers/runway/commands/cancel.ts:250-251`.
- **Failure scenario:**
  1. `cancelTask` sends GET, sees `RUNNING`, then sends `DELETE /v1/tasks/{id}`.
  2. If the task reaches `SUCCEEDED` between those two requests (likely when someone cancels a nearly finished video), Runway's DELETE removes the finished task and its outputs.
  3. The user has paid for the output, passed no `--delete`, and the CLI prints `Task ... cancelled (was RUNNING)`.
- **Contradiction:** The docs promise "cancel refuses a finished task unless you pass `--delete`" (`docs-site/src/content/docs/commands/runway.md:105-106`, README, SKILL.md).
- **Root cause:** The API has no cancel-only endpoint, so the race cannot be fully closed. The code and docs present the guard as absolute.
- **Fix:**
  - Change the success message to something like "Cancel requested for task X (was RUNNING); if it finished in the meantime, Runway deleted it and its outputs."
  - State the race in the docs and in the `cancel` help text.
  - Optionally refuse to cancel without `--delete` when `progress` is at or above roughly 0.95, with a clear message.

### M2. `status --wait` without `--download` prints raw signed output URLs, in both text and `--json`
- **Where:** `src/providers/runway/commands/status.ts:201-210` sets `download = opts.download === true`. `src/providers/runway/commands/task-flow.ts:132-139` then prints `task.output` unredacted.
- **Verified** against a local fake server:
  - `multix runway status <id> --wait` prints `https://cdn.example.com/v.mp4?X-Amz-Signature=SECRETSIG` on stdout.
  - `--wait --json` prints the same URL unredacted.
  - One-shot `status <id> --json` prints `?[redacted]`.
- **Impact:**
  - Contradicts the docs: "Status JSON strips the signed query strings from output URLs" (`runway.md:124-125`).
  - Contradicts the code comment in `output.ts:286-289`, which says raw URLs only come with an explicit `--no-download`.
  - Contradicts the commit message: "Signed URLs are redacted in summaries."
  - Signed URLs end up in CI logs or agent transcripts when a user only asked to wait. AGENTS.md says signed URLs must not be logged.
- **Fix:** In `status`, print raw URLs only when `opts.download === false` (explicit `--no-download`). Otherwise print `summarizeTask(final)` (redacted) plus the "Download with: ..." hint. For example, pass a `rawUrls` flag into `reportSucceeded` and use `summarizeTask` when it is not set. Add a test that `status --wait` (no download flag) output has no query string.

## Low

### L1. Errors during the wait phase lose the resume hint after a paid task was created
- **Where:** `src/providers/runway/client.ts:369-372`, `src/providers/runway/commands/task-flow.ts:167-178`.
- **Scenario:** Only `PollTimeoutError` carries `Resume with: multix runway status <id> --wait --download`. Any other error after a successful create loses it, for example:
  - a 401/403 mid-poll;
  - a malformed or unknown-status task body: `validateTask` throws a `ProviderError`, which `isTransientHttpError` does not retry, so a single odd response aborts the wait;
  - a non-transient 4xx.
- **Impact:** In `--json` mode the task ID then appears only in a stderr info line (`logCreated`). An agent or script sees a failure with no handle and may resubmit, paying twice.
- **Fix:** In `completeTask`, catch errors other than `RunwayTaskError` and rethrow them with the task ID and `resumeCommand(id)` appended.

### L2. `--image ""` silently turns image-to-video into a paid text-to-video
- **Where:** `src/providers/runway/commands/video.ts:242` (`withImage = Boolean(opts.image)`); the `--image` option at `video.ts:275-278` has no `nonEmpty` parser.
- **Scenario:** A script runs `multix runway video "$PROMPT" --image "$FRAME"` with an empty `$FRAME`. With the default ratio `1280:720`, a gen4.5 text-to-video task is submitted and billed instead of failing validation.
- **Fix:** Add the existing `nonEmpty` parser to `--image`, as `--ratio` already does.

### L3. Help text bakes environment-derived defaults into the generated worker catalog
- **Where:** `src/providers/runway/commands/video.ts:88-89` and `image.ts:102-103` call `runwayVideoModel()` / `runwayImageModel()` while registering commands. No other provider does this.
- **Verified:** `RUNWAY_VIDEO_MODEL=gen4_turbo node dist/cli.js runway video --help` shows "default model: gen4_turbo".
- **Impact:**
  - `worker/test/cli-catalog.test.ts:18` compares the committed `cli-catalog.json` with `buildCliCatalog(program)`. The freshness check therefore fails, or the regenerated catalog picks up the developer's local default, whenever RUNWAY_VIDEO_MODEL or RUNWAY_IMAGE_MODEL is set in the shell or loaded from `~/.multix/.env`.
  - The remote MCP catalog also states a default that the container may not use.
- **Fix:** Use static text, for example `(default gen4.5; override with RUNWAY_VIDEO_MODEL)`.

## Nits
- **N1** `src/providers/runway/node-input-files.ts:170-181`: a local file whose name looks like a tag (for example `--ref shot_01=final.png`, meaning a file named `shot_01=final.png`) is parsed as tag `shot_01` with path `final.png`. This follows the documented syntax, but `./shot_01=final.png` is the only workaround; mention it in the help or docs.
- **N2** `node-input-files.ts:75`: `DATA_URI_RE` accepts `image/jpg`, which is not a standard MIME type. Runway may reject it with a 400. Nothing is billed, but the check is looser than the comment claims.
- **N3** `task-flow.ts:93`: the handle JSON uses `status: "SUBMITTED"`, which is not a Runway task status. Consumers that compare against Runway's statuses (`PENDING`, `RUNNING`, and so on) may be confused. Consider `"PENDING"`, or a separate `submitted: true` field.
- **N4** `cancel` has no `--json` output, unlike `status`. This is a consistency issue only.

## Checked and not an issue
- **Double billing:**
  - The create loop retries only HTTP 429 (at most 2 retries, honouring Retry-After, capped at 30 s).
  - `fetchJson` has no hidden retries.
  - Timeouts and network errors (status 0), 5xx, 2xx with invalid JSON, an empty body or a missing ID all get `ORPHAN_HINT`.
  - 3xx and 4xx do not get the hint.
- **SSRF and path traversal:**
  - Output downloads are checked on every hop.
  - Upload URLs must be https and public. The upload does not follow redirects and does not send the API key.
  - Remote `--image`/`--ref` URLs are never fetched locally; they are only checked syntactically (https, a domain name, at most 2048 characters).
  - Task IDs are regex-checked before any URL is built. A server-supplied ID is checked before it is used.
  - File names use the alphanumeric ID prefix and an extension from a fixed media list or a known MIME type.
- **Secret leakage:**
  - The key is sent only as a Bearer header.
  - `HttpError` messages redact URL query strings, and `rawUrl` is non-enumerable.
  - Download failures are re-wrapped without the URL.
  - Debug logs use `redactUrl`.
- **`--json` stdout:** With `stderr: true`, `logger.info`, `success`, `debug` and `header` go to stderr; `warn` and `error` already did. `saveTaskOutputs` and `finalizeGeneratedImages` log only through the logger. I confirmed with the fake server that stdout is pure JSON.
- **API contract:**
  - The `X-Runway-Version: 2024-11-06` header is sent.
  - `promptImage: [{uri, position: "first"}]` and `referenceImages: [{uri, tag?}]` match the SDK.
  - gen4.5 text-to-video ratios are `1280:720` and `720:1280`; image-to-video ratios have 6 values; image ratios have 16 values.
  - gen4.5 requires prompt text; gen4_turbo makes it optional.
  - gen4_image takes 0-3 references and gen4_image_turbo takes 1-3.
  - Tags must match `^[A-Za-z][A-Za-z0-9_]{2,15}$`.
  - Polling waits at least 5 s (`minIntervalMs: 5000`).
- **Worker:**
  - `runway video` and `runway image` take file inputs and are flagged repeatable correctly.
  - The duration cap applies, falling back to the server default when the CLI default exceeds the cap.
  - The group key is `RUNWAYML_API_SECRET`.
  - Uncapped commands (`status`, `cancel`) use the caller's own key, so they are acceptable.
  - The gen4.5 ratios are all under 1600x720-class, so the missing `resolution` cap does not matter.
- **Tests:** No paid API calls; everything goes through an in-memory fake fetch. The live test requires both `MULTIX_LIVE_TESTS=1` and the secret, and never prints the key. The tests assert behaviour (request bodies, headers, refusal before any request, `--json` purity), not just execution.

## Recommended actions (priority order)
1. M2: redact signed URLs in `status --wait` unless `--no-download` is explicit, and add a test.
2. M1: reword the cancel success message, and document and help-text the DELETE race.
3. L1: add the task ID and resume command to wait-phase errors after a create.
4. L2: add `nonEmpty` to `--image`.
5. L3: use static default-model help text.

## Metrics
- Type check: clean. Lint (changed files): 0 issues.
- Runway unit tests: 53 passed, 1 skipped (live).
- Coverage: not measured.

## Unresolved questions
- gen4_turbo duration: the SDK 4.22.0 types it only as `duration?: number`, with no range. Older Runway docs allowed only 5 or 10 seconds. The registry allows 2-10. I could not confirm the current range from the public API reference, which was truncated when fetched. If Runway still allows only 5 or 10, `--duration 3 -m gen4_turbo` gets a 400 (not billed), so the risk is low.
