# Code review: native Runway provider (issue #229)

- Commit: c2002ad (HEAD of claude/gracious-heisenberg-ux6o7c), base origin/main
- Reviewer: isolated code-reviewer (did not write the code)
- Date: 2026-10-15 UTC

## Scope
- Files: src/providers/runway/** (client, models, types, node-client, node-inputs, node-outputs, commands/*), wiring (commands/index.ts, check.ts, setup-hints.ts, provider-keys.ts, project-env-names.ts, .env.example, cli.ts, package.json), worker policy/secret names/keys card/catalog, tests.
- LOC: +2849 / -3 (31 files)
- Checks run:
  - `npx vitest run tests/unit/providers/runway tests/unit/providers/keyed-redirects.test.ts`: 84 passed, 1 skipped (live)
  - `npm run typecheck`: clean
  - `npx biome check src/providers/runway tests/unit/providers/runway`: clean
  - worker `tsc --noEmit`, `test/run-argv-builder.test.ts` (41 pass), `test/cli-catalog.test.ts` (5 pass, catalog in sync)
  - `findNodeOnlyUses` (tests/helpers/import-graph.ts) on runway client.ts/models.ts/types.ts: no node-only imports, including transitive ones

## Overall assessment
The core requirements hold. Every flag is validated before a paid request, unknown models are rejected, create retries only on 429, and the orphan hint covers status 0, 2xx-malformed and 5xx. UUID task ids are checked before they go into a path or file name. Cross-origin redirects are refused for keyed calls. The upload URL goes through the SSRF check and gets no credential. Downloads are https-only, checked on every hop, size-capped and written atomically. Video does not block by default. The client is runtime-neutral. No blocking defects. The findings below are leaks and contract gaps around the edges, plus docs that AGENTS.md requires.

## Critical
None.

## High
None.

## Medium

### M1. `runway status <id> --wait` (without `--download`) prints raw signed output URLs
- Where: src/providers/runway/commands/status.ts:44-50 -> task-flow.ts:98-100
- Scenario: `status` passes `download: Boolean(opts.download)`, so a plain `--wait` sets `download: false`. `reportOutputs` then runs `console.log(url)` for each raw signed URL, query string included. The same command without `--wait` prints a redacted summary. The module docstring says "Prints a JSON summary (output URLs without their signed query strings)". On MCP, `runway status` has no policy restrictions. Its stdout is returned to the client and stored in the job result. `redactSecrets` scrubs only key values, not signed URLs. This breaks the issue requirement "never leak signed output URLs".
- Fix: make "print raw URLs" an explicit opt-in. For example, give `status` a `--no-download`/`--print-urls` flag, and when `--wait` finishes without `--download`, print `summarizeTask(final)` instead. Alternatively, pass `download: opts.download ? true : "summary"` and handle the summary case in `reportOutputs`. Add a test: `status --wait` with a SUCCEEDED task must not print `?X-Amz-...`.

### M2. Required docs surfaces not updated (AGENTS.md "Code conventions")
- Missing from the commit: README.md, docs-site English and Vietnamese pages, skill/SKILL.md. `docs-site/src/content/docs/commands/runway.md` exists only as an untracked file. It is not in the commit and has no `vi/` counterpart.
- Impact: the commit is `feat(runway)`, so release-please publishes a new npm version on merge. That release would ship with no README, docs-site or agent-skill entry for the provider.
- Fix: commit the EN page, add `docs/vi/commands/runway.md`, add Runway to README and skill/SKILL.md (key, commands, the "video returns a task id unless --wait" behaviour), then run `npm run verify:docs`.

## Low

### L1. `cancel` can delete a task that finished after the status check (TOCTOU)
- Where: src/providers/runway/commands/cancel.ts:24-32 (docstring lines 3-4)
- Scenario: `getTask` returns RUNNING, the task reaches SUCCEEDED, then `DELETE /v1/tasks/{id}` runs. That DELETE removes the finished task and its paid outputs. The comment "a finished task is only deleted with an explicit --delete" does not hold inside that window. The API offers no cancel-only verb, so this cannot be fully closed.
- Fix: make the docstring and help honest ("cancel may delete a task that finishes at the same moment"). Optionally, when not `--delete`, skip the DELETE if the task is RUNNING and progress >= 0.99, and suggest `status --wait --download`. At minimum, document the race.

### L2. `validateTask` does not check the types of `failure`, `failureCode`, `progress` or `createdAt`
- Where: src/providers/runway/client.ts:172-190, used at :66
- Scenario: a FAILED task whose `failure` is not a string (an object, a number, or a schema change) makes `new RunwayTaskError(task)` throw `TypeError: task.failure.slice is not a function`. The user sees an internal error instead of "task <id> failed". The issue asks for JSON shape validation, and these fields reach the error path unchecked.
- Fix: in `validateTask`, reject or normalise non-string `failure`/`failureCode` and a non-number `progress`, or coerce them with `String(...)` in `RunwayTaskError`.

### L3. A SUCCEEDED task with `output: []` exits 0 with nothing saved
- Where: client.ts:183-188 accepts an empty array; task-flow.ts:94-97 prints the summary and returns [].
- Scenario: `video --wait` or `image` reports "Task ... succeeded", saves nothing and exits 0 for a billed task, so scripts read it as success.
- Fix: in `validateTask`, require `output.length > 0` for SUCCEEDED, or throw a ProviderError in `reportOutputs` when `download` is true and there are no URLs.

### L4. Create POST timeout is a fixed 60s regardless of body size
- Where: client.ts:42 and :249, used by `create` at :270
- Scenario: `runway image` with three references, each just under the 5MB data-URI limit, posts about 15MB of JSON. On an uplink of about 250 KB/s, the 60s `AbortSignal.timeout` fires mid-send. That surfaces as a "Network error" with the orphan hint, which tells the user a task may have been billed when almost certainly none was. The "retry" then re-sends the same payload.
- Fix: let callers pass a create timeout scaled to the body size. The repo already has the `MULTIX_UPLOAD_MIN_KBPS` precedent; keep env reading in node-client. Alternatively, upload inline images through the ephemeral upload once their combined size passes a threshold.

### L5. No regression test for the runtime-neutral requirement
- Where: tests/unit/providers/runway/ has no counterpart to tests/unit/providers/heygen/runtime-neutral.test.ts or the replicate models-output neutrality test.
- The requirement holds today (verified with `findNodeOnlyUses`). However, the worker does not import the runway client, so `check:bundle` does not cover it either. A future `node:*` import would pass CI.
- Fix: add a 10-line test that runs `findNodeOnlyUses` on client.ts, models.ts and types.ts.

### L6. MCP: `--no-download` returns signed Runway URLs in job stdout
- Where: worker/src/jobs/cli-command-policy.ts:141-146 (no `unsupported`)
- This matches the existing fal, atlas and replicate policies, and the caller asks for it explicitly. Still, the issue explicitly says no signed URLs in MCP, and job stdout is stored and returned. The R2 output path already gives remote callers the files.
- Fix (decision for the lead): either add `unsupported: ["download"]` (which covers `--no-download`) to the runway policies, or record that this is accepted on precedent.

### L7. MCP video caps: no resolution cap for `runway video`
- Where: cli-command-policy.ts:141-142
- Fixed ratios cap Runway at 720p-class output (1280x720, 1584x672, 960x960). An operator who limits `allowedResolutions` to something lower (for example 480p only) is bypassed. The `fal video` policy sets a precedent for this. Informational: confirm it is intentional, or map ratio to resolution in the policy.

## Nits
- node-inputs.ts:152: `UPLOAD_MIN_BYTES` is unreachable in practice. The upload branch runs only when the base64 form is over 5MB, which means the file is over about 3.75MB.
- node-inputs.ts:139 and :146: size is checked by `stat`, then the file is read with no re-check. A file growing between the two calls passes the 200MB guard. Use `bytes.length` after reading.
- node-inputs.ts:75 and :134-137: MIME comes from the extension or data-URI prefix only, and `data:image/jpg` is accepted. A mislabelled file earns a 400 from Runway (no charge). Optionally sniff the magic bytes.
- video.ts:51: `--image ""` silently switches to text-to-video.
- status.ts: `--output` without `--download`, and video `--wait-timeout` without `--wait`, are silently ignored.
- models.ts:515-516: the gen4_image estimate is "from 5 credits", but the 1080p-class ratios could be priced exactly (8 credits) because the ratio is known.

## Unrelated but real (touched shared code, separate issue)
- src/core/async-poll.ts:122: the last sleep is clamped to `remaining`, so the final poll can come sooner than `minIntervalMs` (5s for Runway) just before the deadline. Impact is negligible (one early GET); open an issue only if strict poll spacing matters.

## Requirement checklist (issue #229)
| Requirement | Status | Evidence |
|---|---|---|
| Runtime-neutral client/models/types | OK (no test, L5) | import-graph scan clean |
| Model/ratio/duration/images validated before paid call | OK | planVideo/planImage run before createRunwayClient and uploads; tests assert 0 calls |
| Unknown models rejected | OK | models.ts videoModelSpec/imageModelSpec |
| Only 429 retried on create; orphan hint | OK | client.ts:266-280, :133-148; tests |
| Retry-After/backoff on status reads, >=5s | OK | pollUntil minIntervalMs 5000, jitter off |
| Task id validated before path/file use | OK | assertTaskId/isValidTaskId (UUID) |
| JSON shape validation | Partial (L2, L3) | validateTask/validateCreatedTask |
| Downloads https-only, private/IP/loopback incl. redirects, size cap, atomic .part | OK | node-outputs.ts validateUrl per hop; downloadToFile |
| Upload size/MIME rules | OK (nits) | node-inputs.ts |
| SSRF guard on upload URL | OK | client.ts:381, redirect: manual, no auth header |
| No key / signed URLs / prompts in logs, errors, MCP | Partial (M1, L6) | summarizeTask redacts; status --wait does not |
| Indicative vs billed cost | OK | logEstimate / logCreated / "Billed:" |
| Video non-blocking by default | OK | video.ts:133-136 |
| Credentials never follow cross-origin redirects | OK | fetchJson crossOrigin "error"; keyed-redirects test |
| MCP caps not weakened | OK with note (L7) | duration cap applied; runway video has no resolution cap |
| Tests do not call paid APIs; live opt-in | OK | stubs; live.test.ts gated on MULTIX_LIVE_TESTS=1 + secret |
| Docs per AGENTS.md | Missing (M2) | README / docs-site / SKILL.md |

## Recommended actions
1. M1: stop printing raw signed URLs from `status --wait`, and add a test.
2. M2: commit the docs (EN+VI), README and skill/SKILL.md updates.
3. L2/L3: tighten `validateTask` (string `failure`, non-empty SUCCEEDED output).
4. L5: add the runtime-neutral test.
5. L1, L4, L6, L7: document the cancel race; scale the create timeout; decide on MCP `--no-download` and the resolution cap.

## Unresolved questions
- Does Runway enforce a total request-body limit that 3 x 5MB data-URI references would exceed? This affects L4.
- Is `--no-download` over MCP acceptable on precedent, or should the issue's "no signed URLs in MCP" requirement win? (L6)

## Resolution (applied before the PR)
- M1: fixed. `status --wait` without `--download` prints the redacted summary; only an explicit `--no-download` on `video --wait` / `image` prints signed URLs. Test added.
- M2: fixed in the docs commit.
- L1: documented. Docstring and EN/VI docs now state the race; Runway has no cancel-only verb.
- L2, L3: fixed in `validateTask`. Field types are checked, and SUCCEEDED requires a non-empty output list. Tests added.
- L4: fixed. The create timeout grows with body size at `MULTIX_UPLOAD_MIN_KBPS` (default 1 MB/s). Test added; docs updated.
- L5: fixed. `tests/unit/providers/runway/runtime-neutral.test.ts` added.
- L6, L7: kept as is. The MCP `--no-download` behaviour matches fal, atlas and replicate, is an explicit caller request, and the URLs belong to the caller's own account. Runway Gen-4 outputs are 720p-class, and fal video has no resolution cap either.
- Nit `--image ""`: now a validation error. The other nits have negligible impact and are left as is.
- async-poll final-sleep clamp: negligible (one early GET just before the deadline); no issue opened.
