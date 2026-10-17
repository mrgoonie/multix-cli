# Code review: ad0e18d feat(runway): offline models listing and JSON-only status output

Reviewer: isolated code-reviewer (did not write the code). Date 2026-10-17 UTC. Issue #242.

## Scope
- Files: src/core/logger.ts, src/providers/runway/commands/{index,models,status,task-flow}.ts, tests (logger, runway commands, smoke), worker/src/cli-catalog.json, worker/test/run-argv-builder.test.ts, README.md, skill/SKILL.md, docs-site en+vi runway.md
- LOC: +374 / -15
- Verification run:
  - `npx vitest run tests/unit/providers/runway tests/unit/core/logger.test.ts tests/smoke/cli.test.ts`: 108 passed, 1 skipped (a live test that needs opt-in); the new smoke test `runway models --json works offline` passes against the current dist (dist contains the new command)
  - `worker: npx vitest run test/cli-catalog.test.ts test/run-argv-builder.test.ts`: 47 passed, so the generated catalog matches the CLI
  - `biome check src tests`: clean. `tsc --noEmit`: clean
  - Manual: `RUNWAYML_API_SECRET= node dist/cli.js runway models` lists models with no key. `runway status <uuid> --json` with no key sends the ConfigError to stderr and leaves stdout empty

## Overall assessment
Small, scoped change that matches the issue. `createLogger` stays backwards compatible: `stderr` is an optional field, the default path still uses `console.log`, and `c()` defaults to `process.stdout`, so `defaultLogger` and the other ~168 callers behave as before. In the status paths, the only `console.log` calls left are the JSON summary and, for `--download` without `--json`, the saved-file list. `summarizeTask` still strips signed query strings, and saved paths carry no URL. No blocking defects found.

## Critical / blocking
None.

## Non-blocking findings

1. **`status --wait` writes nothing to stdout on FAILED/CANCELLED or timeout** (src/providers/runway/commands/task-flow.ts:146-148; status.ts:49-57)
   `completeTask` calls `assertSucceeded(final)` before `reportOutputs`, so `multix runway status <id> --wait | jq .status` gets empty stdout and jq fails. A wait timeout does the same. One-shot `status` on a FAILED task prints the JSON first and then throws (status.ts:70-74), so the two modes disagree. This behaviour predates the commit, but the new docs line "`status` writes only JSON to stdout ... so `| jq .status` works" (docs-site en:115-118, vi:113-116) makes it look like stdout always holds a parseable document. Fix: for status with `--wait`, print `summarizeTask(final)` before `assertSucceeded` when the status is terminal and not SUCCEEDED. Or document "non-zero exit with no stdout on failure or timeout under --wait".

2. **Partial download failure with `--download --json` leaves stdout empty** (task-flow.ts:107-112, node-outputs.ts throws after the loop)
   If one of two outputs fails, `saveTaskOutputs` throws after saving the other file. The JSON with `files` is never printed, and the saved path only reaches stderr as "Saved ...". A script that relies on `files` loses the path of the file that did download. This is acceptable because the exit is non-zero and the retry hint is printed, but the docs should say so.

3. **SKILL.md contradicts the docs** (skill/SKILL.md:201)
   `multix runway status <task-id> [...] [--download] [--json]   # stdout is JSON only` is wrong for `--download` without `--json`, which prints the plain-text "Saved N file(s)" list on stdout (task-flow.ts:117-119). An agent reading SKILL.md will pipe that to a JSON parser and fail. Fix: "stdout is JSON only (add --json with --download)".

4. **README usage line leaves out the new flag** (README.md:591)
   `multix runway status <task-id> [--wait] [--download] [--output <path>] [--wait-timeout <ms>]` has no `[--json]`, though the notes bullet at README.md:604 mentions `--download --json`. Add it so the synopsis matches.

5. **TTY colour detection for warn/error still checks stdout** (src/core/logger.ts:56-59)
   The commit adds a `stream` parameter to `c()`, but `warn`/`error` (both on stderr) still use the default `process.stdout`. With the new piping use case, `multix runway status <id> | jq` on a terminal shows info/success/debug lines in colour on stderr and warn/error lines plain. With `2>log` and stdout on a TTY, warn/error write ANSI codes into the log file. This predates the commit. The fix is one line each: pass `process.stderr` for warn/error, keeping the existing NO_COLOR check.

6. **An unsupported `RUNWAY_VIDEO_MODEL`/`RUNWAY_IMAGE_MODEL` silently marks no default** (src/providers/runway/commands/models.ts:26-39)
   With `RUNWAY_VIDEO_MODEL=gen3a`, `runway models` shows every model without "(default)" and exits 0, while `runway video` would fail with ValidationError. A user who runs `models` to debug a configuration gets no signal. Suggestion: `logger.warn` (stderr) when the resolved default is not in the registry.

7. **The remote Worker can now run `runway models` as a container job** (worker/src/cli-catalog.json:8066-8083; no policy entry needed)
   The command takes no file, output or URL options, so it adds no attack surface. It does start a billable container job for static data, and the job is gated on the caller's `RUNWAYML_API_SECRET` only through `has_keys` (catalog-view.ts:24-29). The key is passed into the job (job-runner.ts:79) even though the command never reads it, which is harmless but needless key exposure. Optional: add `"runway models"` to `EXCLUDED_COMMANDS`, or skip passing keys for offline commands. `runway status --json` remotely: `files` are container-local paths under the job output dir, the same exposure other commands already have when they print saved paths. No signed URL is exposed.

8. **The smoke test's "no request" check proves little** (tests/smoke/cli.test.ts:104-108)
   `RUNWAY_BASE_URL=http://127.0.0.1:9` proves nothing because `models` never reads the base URL. The unit test (`fake.calls` length 0) is the real proof, so this is only a misleading comment.

## Edge cases checked (no defect)
- `defaultLogger` and existing `createLogger({verbose})` callers: the output path is unchanged. The new logger tests prove the default goes to stdout.
- Console spies: `out` resolves `console.error`/`console.log` on every call, so spies installed later still capture output (the tests depend on this).
- `status --download` on a non-SUCCEEDED task prints the JSON summary (download is ignored) and puts the hint on stderr. A one-shot running task still exits 0.
- Signed URLs: the summary goes through `redactUrl`, log lines and `files` contain no URLs, and the tests assert that SIGNED_TOKEN and SECRET never appear in any output.
- `runway models` resolves only the model env names (via `resolveKey`), never the secret, and makes no request.
- `--json` does not clash with any root option (the root has `enablePositionalOptions` and no global `--json`). Its Worker argv form round-trips (run-argv-builder test).
- video/image commands do not pass `json`, so their stdout behaviour is unchanged.

## Recommended actions (priority order)
1. Fix the SKILL.md comment (finding 3) and the README synopsis (finding 4). These are cheap and agent-facing.
2. Decide on and document the `--wait` failure/timeout stdout contract (finding 1). Printing the summary before throwing would complete the issue's "parseable JSON on stdout" goal.
3. Optional hardening: stderr TTY detection for warn/error (5), a warning for an unknown env default (6), and whether to exclude `runway models` from the remote runner (7).

## Metrics
- Type check: clean. Lint: 0 issues. Focused tests: 108 CLI + 47 worker passed.

## Unresolved questions
- Should `status --wait` print the terminal summary on FAILED/CANCELLED (a behaviour change beyond the commit), or is "non-zero exit with empty stdout" the intended contract?
- Is it intended that remote callers can run `runway models` as a container job that needs the caller's Runway key?

## Resolution (implementer)

- Finding 1: `status --wait` now prints the JSON summary for FAILED/CANCELLED before exiting non-zero; timeout and download failures stay stderr-only and are documented.
- Finding 2: documented (stderr-only on a failed download); no change.
- Findings 3, 4: SKILL.md and README synopsis fixed.
- Finding 5: warn/error colour detection now checks stderr.
- Finding 6: `runway models` warns on stderr for an unsupported RUNWAY_VIDEO_MODEL / RUNWAY_IMAGE_MODEL.
- Finding 7: `runway models` added to the Worker's EXCLUDED_COMMANDS; test asserts it cannot run remotely.
- Finding 8: smoke-test comment corrected.
