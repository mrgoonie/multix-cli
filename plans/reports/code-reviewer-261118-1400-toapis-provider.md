# Code review: ToAPIs provider (b8a1fb8f + working tree)

Scope: src/providers/toapis/**, src/budget/command-cost.ts, src/agent/cost-preflight.ts,
src/capabilities/command-capabilities.ts, worker/src/jobs/cli-command-policy.ts,
tests/unit/providers/toapis/**, docs-site toapis pages (EN/VI).
Checks run: `npx vitest run tests/unit/providers/toapis` -> 4 files, 23 tests pass.
No paid API calls. Lint/typecheck/build not run in this review.

## Findings (ranked)

### High

1. `--param` silently overrides priced fields; the local estimator never sees it.
   `buildToapisBody` merges `extra` last (src/providers/toapis/request-body.ts:670), so
   `--param model=veo3.1-fast`, `--param n=8`, `--param duration=15`, `--param seconds=..`,
   `--param resolution=1080p` or `--param metadata.resolution=4K` replace what
   `estimateToapisCost` priced (src/budget/command-cost.ts:344-355 reads only the named
   `--model/--count/--duration/--resolution`). Local `--max-cost` / agent preflight
   therefore approves a run priced on the default model and is charged for another.
   The worker is safe (`uncappedOptions: ["param"]` routes it to the uncapped path,
   run-option-caps.ts:185), the CLI budget guard is not.
   Fix: in `buildToapisBody` (or `generate`), reject `--param` keys that collide with
   mapped/priced fields (`model`, `prompt`, `n`, `duration`, `seconds`, `resolution`,
   `mode`, `metadata.resolution`, `size`), or make `estimateCommand` return
   `status: "unknown"` / non-proven upper bound whenever `param` is present. Add a test.

### Medium

2. Server-controlled task id reaches a file name unchecked.
   `getTask` returns `task.id || id` (client.ts:155) and `submit` uses the server `id`
   (client.ts:136-140) without `assertValidTaskId`; `outputPaths` builds
   `toapis-${kind}-${task.id.slice(-8)}-...` and `path.join`s it
   (commands/task-runner.ts:447-449). An id ending in e.g. `/../../x` escapes the output dir.
   Fix: run `assertValidTaskId` on the id returned by submit/getTask (or sanitize to
   `[A-Za-z0-9_-]` before use in the stem).

3. Seedance per_token estimate defaults to 720p while the body sends no resolution.
   cost.ts:434/500 assumes 720p when `--resolution` is absent, but `upper_bound` is
   "estimated" so only advisory. If the account/model default is 1080p (seedance-2-5,
   seedance-2 list 1080p), the high bound undercounts by ~2.25x in tokens.
   Fix: when no resolution is given, price across all listed resolutions (as per_second
   does), or send the assumed `resolution` explicitly in the body so price and request agree.

4. `toapis quote` infers kind from `--duration` (commands/index.ts:340), then upper-cases
   resolution for "image". `quote -m seedance-2-fast --resolution 720p` (no duration) sends
   `720P` and ToAPIs returns "cannot price". Fix: infer kind from the resolution pattern
   (`/p$/i` -> video) or add `--kind`, or keep case as given.

### Low

5. `status --kind` defaults to `video`; an image task id polled without `--kind image`
   hits the video endpoint and fails confusingly (commands/index.ts:285). Document the
   need prominently or try the other kind on 404.
6. Upload allowlist checks the extension of the resolved path but follows symlinks
   (env.ts:68-90): `secret.png -> ~/.env` would upload. Low on CLI (user-chosen path);
   the worker file policy governs remote jobs. Consider `fs.lstat` + reject symlinks or
   `realpath` then re-check the extension.
7. `quoteToapis` falls back to `rows[i]` when keys mismatch (client.ts:269), which can
   attach a quote to the wrong item if ToAPIs reorders/omits rows. Prefer key match only.
8. Docs EN vs VI line counts differ (143 vs 145); not a defect by itself, spot-check
   parity. Docs claims checked against code: env names, defaults
   (`doubao-seedream-4-5`, `seedance-2-fast`), `quote` keyless, `status --kind/--wait`,
   `--param` semantics all match.

## Verified OK
- Client is runtime-neutral (no node:* imports; runtime-neutral test present).
- Key only in Authorization header; output/upload URLs redacted in debug and `printableTask`.
- Base URL passes `checkBaseUrl` (https, loopback http only); upload uses `fetchSameOrigin`.
- Upload allowlist blocks non-media files and enforces size limits.
- Worker policy: image count capped with `countFromModel`, video duration/resolution capped,
  `--param` marked uncapped, file options declared for image/first-frame/last-frame/upload.
- `toapis quote` listed in FREE_COMMANDS; utility commands registered in capabilities.
- Unknown models priced "unknown", never $0.

## Unresolved questions
- Does ToAPIs ever return an `id` differing from the submitted one on GET (client_business_id)?
- Seedance default resolution per model on ToAPIs (affects finding 3).

Status: DONE_WITH_CONCERNS
