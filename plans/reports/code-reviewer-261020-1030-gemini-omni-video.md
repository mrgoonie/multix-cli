# Code review: 53c57bb feat(gemini): default video to Omni Flash 1.1 with edit, extend and status

Reviewer: isolated code-review agent (did not write the code). Base: 53c57bb~1. Date: 2026-10-20 (UTC).

## Scope
- Files: src/providers/gemini/{omni.ts, omni-run.ts, client.ts, key-pool.ts, models.ts}, src/providers/gemini/commands/{generate-video, image-to-video, omni-follow-up, omni-options, video-status, index}.ts, worker/src/jobs/cli-command-policy.ts, worker/src/cli-catalog.json, tests/unit/providers/gemini/omni.test.ts, tests/smoke/cli.test.ts, README.md, skill/SKILL.md, .env.example
- LOC: +2346 / -188 (18 files)
- Note: HEAD moved during the review (merges 6b8fed0, 970ca10 added a `gemini omni-video` alias and docs commit b23a81d). Those are not part of 53c57bb and are only mentioned as context.

## Verification run
- `npx vitest run tests/unit/providers/gemini/omni.test.ts`: 19/19 pass
- `npm run typecheck`, `npm run lint`: clean
- `npm run check:mcp`: worker 366/366 tests pass, bundle check clean (no node:* in Worker bundle)
- Regenerated the CLI catalog in memory with `worker/scripts/cli-catalog-builder.ts`: identical to committed `worker/src/cli-catalog.json` (generated file is in sync)
- Offline CLI probes (no network): edit-video with `VIDEO_GEN_MODEL=veo-*` fails; malformed session `key_env` crashes with TypeError (see below)
- Shutdown dates checked against https://ai.google.dev/gemini-api/docs/deprecations: all nine match

## Overall assessment
Solid structure: key rotation is limited to the create call, follow-ups pin the creating key by env-var name, interaction ids are validated before entering URL paths, the API key goes only to `generativelanguage.googleapis.com` (cross-origin redirect drops headers; `fetchJson` refuses cross-origin redirects for keyed requests), Veo defaults (1080p, 16:9) and validation are preserved, `omni.ts` is runtime-neutral, the catalog is regenerated. No critical defects. The main residual risk is billing: the default synchronous create can lose a paid result with no recovery handle, and non-network failures of the create POST are not flagged as possibly billed.

## Critical Issues
None.

## High Priority

### H1. Default synchronous create can lose a billed video with no recovery handle
- Where: src/providers/gemini/omni-run.ts:102 (`background: opts.background === true`), :290-305 (create with `timeoutMs: settings.timeoutMs`), :308-334 (session written only after create returns)
- Scenario: user runs `multix gemini generate-video --prompt ... --resolution 4k` (default, not background). The POST holds the connection for the whole generation. Wi-Fi switch, laptop sleep, proxy idle-timeout, or a 900 s local timeout aborts it. The server finishes and bills, but the CLI never received the interaction id, so no session file exists and `video-status` cannot recover it. The error tells the user to "check AI Studio", but the paid video is effectively lost. The comment at omni-run.ts:10-12 promises no double billing, which holds, but not that the paid result can be retrieved.
- Fix: when `store` is on (the default), always send `background: true` and poll; keep sync only for `--no-store` (where background is impossible). This makes the id and session file exist before any long wait, and makes `--background` a no-op flag or removes it. Add a test that a stored run sends `background: true` and writes the session before the first GET.

## Medium Priority

### M1. Create POST failures other than status 0 are not treated as "may be billed"
- Where: src/providers/gemini/omni-run.ts:250-252 (`ambiguousFailure` = `HttpError && status === 0`)
- Scenario: Google's front end returns 502/503/504 after the request reached the backend (common for long-held sync requests), or returns 200 with a truncated/non-JSON body (`fetchJson` throws `HttpError(200, "Invalid JSON response")`). The CLI shows a plain HTTP error with no billing warning; the user re-runs and may pay twice.
- Fix: treat status 0, 5xx (except 501/505, reuse `isRetryableServerStatus`) and 2xx parse failures on the create call as ambiguous and use the same "may still finish and be billed" message. H1's always-background default shrinks this window further.

### M2. Inline video from GET is fully buffered, size-checked only after allocation, and re-downloaded under a 120 s per-poll cap
- Where: src/providers/gemini/omni.ts:217 (`timeoutMs: Math.min(remainingMs, 120_000)`), src/providers/gemini/omni-run.ts:175 (size check after the string exists), `fetchJson` `response.text()`
- Scenario: per the module's own contract (omni.ts header), GET returns the video inline even when created with `delivery: "uri"`. In `--background` runs and in `video-status`, the terminal poll returns a base64 4k/1080p video in one JSON body. It is read into a string, parsed (second copy), then decoded (third copy) before `maxDownloadBytes` is checked, so `MULTIX_MAX_DOWNLOAD_BYTES` gives no memory protection (relevant in the Worker job container). On a slow link the 120 s per-request cap aborts the body read with `HttpError(0)`, which pollUntil treats as transient and retries, downloading the full body again until the deadline, ending in `PollTimeoutError` although the video is ready.
- Fix: for the terminal fetch use the remaining deadline (not 120 s); bound the body by streaming with a byte limit (or check `content-length`) before `text()`; consider documenting that `--delivery uri` has no effect on background/status paths, or fetch the status without media if the API offers a field mask.

### M3. Worker resolution cap no longer applies when `--resolution` is omitted
- Where: worker/src/jobs/cli-command-policy.ts:73-90 with worker/src/jobs/run-option-caps.ts:73-80; catalog diff removes `"default": "1080p"` from gemini generate-video and image-to-video `--resolution`
- Scenario: an operator sets `MULTIX_MCP_ALLOWED_RESOLUTIONS=480p,720p`. Before, an omitted `--resolution` was checked as the catalog default `1080p` and rejected. Now `raw` is undefined, the cap is skipped, and a remote `gemini generate-video --model veo-3.1-generate-preview` renders at 1080p (Veo default applied in code). The same applies to Omni's implicit 720p if an operator allows only 480p, and to the new edit-video/extend-video. Production config currently allows 1080p, so there is no live exposure today.
- Fix: in the policy, give these commands an implicit default for the cap check (e.g. a `defaultResolution` field, or have `applyCaps` inject the server's lowest allowed resolution when omitted, like the duration fallback). Add a worker test for omitted `--resolution` on gemini generate-video.

### M4. Follow-ups take their default model from VIDEO_GEN_MODEL and ignore the session's model
- Where: src/providers/gemini/commands/omni-follow-up.ts:103
- Scenario (verified offline): a user who kept Veo via `VIDEO_GEN_MODEL=veo-3.1-generate-preview` runs `multix gemini edit-video --interaction-id v1_abc --prompt hi` and gets `Error: edit-video needs a Gemini Omni model (got 'veo-3.1-generate-preview')`. Also a session created with `gemini-omni-flash-preview` is continued with `gemini-omni-1.1-flash` without notice.
- Fix: `opts.model ?? record?.model (if omni) ?? GEMINI_OMNI_MODEL_DEFAULT`; only consult `VIDEO_GEN_MODEL` if it names an Omni model.

## Low Priority

### L1. Session file fields are not type-checked
- Where: src/providers/gemini/omni-run.ts:137-151 (`readSessionRecord`), key-pool.ts:126
- Scenario (verified): session with `"key_env": 123` makes `video-status --session` crash with `keyName.slice is not a function`. `"key_env": ""` silently falls back to rotation instead of the pinned project. `store` missing is reported as "created with --no-store". No security impact: `key_env` is restricted to `GEMINI_API_KEY(_n)` names and `interaction_id` is validated.
- Fix: validate `key_env` (string matching the key regex, or absent), `store` (boolean), and give a clear ValidationError.

### L2. `--interaction-id` (and video-status by id) without `--key-env` rotates across projects
- Where: omni-run.ts:159; omni-follow-up.ts:73; video-status.ts:61
- Scenario: the interaction lives in GEMINI_API_KEY_2's project; the run tries GEMINI_API_KEY first and gets 404 (not rotated), or gets 429 and rotates to another project, then 404. The error does not hint at `--key-env`.
- Fix: when a stored id is used without a pinned key, add "pass --key-env or --session" to the 403/404 message.

### L3. A Gemini-host video URI that does not match the strict regex is fetched without the key
- Where: src/providers/gemini/omni.ts:232-243, omni-run.ts:217
- Scenario: if the API returns e.g. `https://generativelanguage.googleapis.com/download/v1beta/files/x:download?alt=media`, `geminiFileName` returns undefined and the download goes out unkeyed, so it fails with 403 after the video was billed (recoverable with video-status only when stored). Not a leak, so the strictness is safe. The live run shows the current shape matches.
- Fix: for a URI on API_HOST that does not parse as a Files name, throw a ProviderError naming the shape (and pointing to `video-status --download`) instead of a confusing unkeyed 403.

### L4. `--timeout` is not an overall bound
- Where: omni-run.ts:294 (create uses full `settings.timeoutMs`, not the remaining time after upload), :376 (`Math.max(deadline - now, 60_000)` for file wait), saveOmniVideo download fixed at 300 s
- Scenario: upload (unbounded) + create (900 s) + file wait + 300 s download can exceed the documented "overall wait". In the Worker the container's 30 min budget can then SIGTERM the CLI mid-download.
- Fix: pass `deadline - Date.now()` to the create and document that the download has its own budget.

### L5. `extend-video` equals `edit-video` and i2v frame semantics are implicit
- Where: omni-follow-up.ts:135-147; image-to-video.ts (Omni branch, `[imagePath, lastFrame]`)
- Neither sets `generation_config.video_config.task`; extend relies only on the prompt, and the "closing frame" is just a second image part with no ordering instruction. Help text promises "extend by 3-10 s" and "first/last-frame interpolation". Not verified live.
- Fix: default `task` to `extend` for extend-video (and `image_to_video` for i2v) unless `--task` is given, or soften the help text.

### L6. video-status side effects
- Where: video-status.ts:88 and :93
- After a successful download it rewrites the session file in place; if that path is read-only, the command exits non-zero after saving the video and prints no summary. The output name is derived from the session basename in the output dir, so it can overwrite the original `omni_generated_<ts>.mp4` (same content) or a user file named like the session.
- Fix: wrap the session update in try/warn; skip if the target exists unless sizes differ, or add a suffix.

### L7. Worker caps cannot bound Omni duration
- Where: cli-command-policy.ts edit-video/extend-video entries
- Omni has no `--duration`, so `MULTIX_MCP_MAX_VIDEO_SECONDS` (10 in production) cannot be enforced for extend-video (adds 3-10 s per call; chained extends grow the clip). 360p and 4k are rejected remotely by the default resolution list. Informational: document it in the policy comment, or decide that extend-video stays CLI-only.

## Informational
- The session file stores the full prompt (mode 0600) and the absolute `output_path`. Remotely it is uploaded to the caller's own R2 with the container path. This is not a log, so it does not break the "never log full prompts" rule; mention it in docs.
- 53c57bb itself did not update docs-site (EN/VI) as AGENTS.md requires; they landed in follow-up commit b23a81d on the branch. Fine if they ship together.
- Billing-safety claims verified: `fetchJson` never retries; `withGeminiKey` rotates only on 429/RESOURCE_EXHAUSTED (no interaction created); polling and download stay on the creating key; the timeout/network path is not resent (test at omni.test.ts:308).
- Credential handling verified: the key goes only to API_HOST (strict https, default port, `/v1beta/files/<id>` regex); `downloadToFile` drops headers across origins; error messages use `redactUrl`; the session file holds the env-var name only (test asserts the key value is absent).

## Edge cases found by scouting
- No-store + background is rejected up front (good); no-store sync timeout leaves no recovery path (warned).
- Status `undefined` on create is treated as completed, which yields "finished without a video" if a background create response omits status. The live run shows status is present.
- Concurrent runs in the same millisecond share `omni_generated_<ts>` dest and session path (pre-existing naming pattern; out of scope).

## Test gaps
- No tests for the video-status command (download path, session update, running-state error).
- No test for PollTimeoutError marking the session `in_progress` and printing the resume hint.
- No unit test for `rejectOmniFlagsForVeo` beyond one smoke case, or for Veo defaults (1080p/16:9) still being sent when flags are omitted.
- No tests for: inline size limit, FAILED file state, non-https URI rejection, 5xx on create.
- No worker policy tests for the three new commands (file options for `--session`/`--video`, omitted-resolution cap).

## Out of scope (pre-existing or later commits)
- `downloadVeoVideo` (veo.ts:172) sends the key to any path on API_HOST; pre-existing.
- `gemini omni-video` alias added by later merge 970ca10 (not in 53c57bb): it hardcodes `omniSettings({})`, so it has no `--timeout`/`--background`, and it bypasses the deprecation warning path. Review it separately.
- Timestamp-based output names can collide across parallel processes (shared pattern across providers).

## Recommended actions
1. H1: default stored Omni runs to `background: true` so an id and session exist before any long wait.
2. M1: widen the "may be billed, not resent" classification to 5xx and unparseable 2xx on the create.
3. M2: use the remaining deadline for the terminal GET and bound the body before buffering.
4. M3: restore cap enforcement for an omitted `--resolution` in the Worker policy.
5. M4: follow-ups default to the session's model or the Omni default, not VIDEO_GEN_MODEL.
6. Add the missing tests listed above.

## Metrics
- Type coverage: tsc clean; no new `any` (casts limited to parsed JSON shapes)
- Tests: 19 new unit tests plus 2 smoke tests; command layer (video-status, follow-up actions) is untested
- Lint issues: 0

## Unresolved questions
- Does Omni treat a second image part as a closing frame without a `task` hint?
- Does GET /interactions/{id} really always return inline data (as the omni.ts header states)? If so, 4k background runs pull the full video through JSON.
- Should extend-video stay remotely allowed given the duration cap cannot be enforced?
