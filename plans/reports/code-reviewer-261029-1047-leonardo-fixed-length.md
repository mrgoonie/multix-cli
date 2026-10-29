# Code review: 48e4844, leonardo video fixed length + elevenlabs music help (#456)

Branch `claude/relaxed-clarke-ezhcju` (base origin/dev). 8 files, +54/-3.

## Verdict
No blocking findings. The fix is correct for the case the issue describes. One gap of the same kind remains in TopView (filed below as non-blocking because it is outside #456).

## Verification run
- `cd worker && npx vitest run test/run-argv-builder.test.ts`: 74/74 pass.
- `npx biome check` on the changed files: clean. `worker` `tsc --noEmit`: clean.
- The new refusal test is real: before this commit `leonardo video` had only a resolution cap, so `prepareRun(..., MAX_VIDEO_SECONDS=5)` returned argv and did not throw.
- Default `MULTIX_MCP_MAX_VIDEO_SECONDS` is 10 (worker/src/config.ts:117, wrangler.jsonc:83), so default deployments are unaffected. Only operators who set it below 8 see the new refusal, which is the intent.
- ElevenLabs compose API (checked live): `music_length_ms` "Must be between 3000ms and 600000ms", optional, and when omitted "the model will choose a length based on the prompt". The new help text matches.
- `worker/src/cli-catalog.json` diff matches the new help string exactly.

## Correctness
- worker/src/jobs/run-option-caps.ts:64-68: the check runs for every model and for an omitted `--model`. That is correct because the default model comes from `LEONARDO_VIDEO_MODEL` (src/providers/leonardo/models.ts:30-31), which the runner cannot see. It runs before any value is mutated, and it throws `ValidationError` like the other caps.
- worker/src/jobs/cli-command-policy.ts:216: keeps the resolution cap and adds `fixedSeconds: 8`. This matches src/providers/leonardo/commands/video.ts:82 (`duration: 8`, v2 path) and the absence of any length in the v1 body (video.ts:94-100).
- worker/src/jobs/catalog-view.ts:92: `video_seconds_up_to` is emitted only when the field is set, so other commands see no change.

## Blocking
None.

## Non-blocking
1. **Same gap in TopView m2v (outside #456; open a separate issue).** `topview url-to-video` and `topview materials-to-video` (worker/src/jobs/cli-command-policy.ts:358-362) have no caps and no `uncappedSpend`. Their length comes from `--video-length-type` (src/providers/topview/commands/m2v.ts:148): "1 = 30-50s (default), 2 = 15-30s, 3 = 30-45s, 4 = 45-60s". When it is omitted the CLI sends nothing (m2v.ts:120) and TopView renders 30-50 s. The ceiling for `MULTIX_MCP_MAX_VIDEO_SECONDS` is 15 (config.ts:118), so every m2v run goes past the operator's video-length cap, and nothing in `multix_catalog` reports it. The comment at cli-command-policy.ts:383-384 says this is deliberate ("range code, so none is capped"), but it leaves the length cap silently bypassed. Possible fixes: give each command `fixedSeconds: 60`, which in effect always refuses because 60 > 15, or mark them `uncappedSpend: "the video length type sets a 15-60 s video"` so they go through MULTIX_MCP_UNCAPPED_SPEND. The second option is probably the intended one. Product decision, so not edited here.
   Other video commands I checked: every one with a length either has a `duration` cap (VIDEO_CAPS / fal / runway / heygen model-video) or is marked `uncappedSpend` (heygen video/video-agent/template/lipsync/translate, sume video, topview video-avatar/product-avatar). `gemini edit-video` follows the source length and is documented at policy:170-178. The only other hard-coded length in src/providers is minimax `duration = 6` (src/providers/minimax/generators/video.ts:43), and that one is reachable only through `--duration` (default 6), which is capped. No other gap of this kind.
2. **No test for the catalog field.** catalog-view.ts:92 adds `video_seconds_up_to`, but no test asserts it (`grep video_seconds_up_to worker/test` finds nothing). The docs promise this field to MCP clients. Add one assertion in test/job-tools.test.ts or test/mcp-tools.test.ts, wherever `uncapped_spend` in the group detail view is already tested.
3. **The "up to 8 s for v1 models" claim is unverified for every v1 id.** The v1 list (src/providers/leonardo/models.ts:38-45) includes `KLING2_1` and `Kling2_5`, where Kling allows 10 s. If Leonardo's v1 default for any of them were 10 s, 8 would undercount and a cap of 8 or 9 would let a 10 s render through. I did not find Leonardo v1 per-model default durations in the repo. Confirm against Leonardo's text-to-video docs, or document the source in the policy comment.

## Nits
1. cli-command-policy.ts:26-29: the JSDoc says "The CLI sends no length", but the v2 path does send `duration: 8`. Suggested wording: "The caller cannot choose the length and the run can last up to this many seconds".
2. src/providers/elevenlabs/commands/music.ts:22: per the API, `music_length_ms` applies only with `prompt`. With `--plan` the plan's sections set the length, and the CLI still forwards the flag (music.ts:47). The help could say "(with --prompt; 3000-600000; ...)". This was already true before the commit.
3. Docs EN/VI (mcp-server.md:143-146 / vi:140-143): the paragraphs are accurate and match each other. The model id is written "Veo 3" in prose while the CLI id is `VEO3`. Acceptable.

## Conventions (AGENTS.md; no REVIEW.md in repo)
- The conventional commit `fix(mcp): ...` with `Closes #456` publishes a patch release. OK.
- The catalog JSON was regenerated together with the help-text change. OK.
- Both docs (EN and VI) are updated. `npm run verify:docs` and full `check:mcp` were not run by this reviewer; attach them to the PR.
- Scope: two unrelated fixes (leonardo cap + music help) in one commit, but both are listed in issue #456. OK.

## Unresolved questions
- Leonardo v1 default durations for KLING2_1 / Kling2_5 / VEO3_1 (see non-blocking 3).
- Should TopView m2v be `uncappedSpend` or refused? This needs a product decision before a follow-up issue.
