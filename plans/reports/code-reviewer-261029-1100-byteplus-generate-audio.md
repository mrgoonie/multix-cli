# Code review: 6e3fba8 fix(byteplus): send --audio as generate_audio (Closes #458)

Branch `claude/relaxed-clarke-f06f73`, base `origin/dev`. One commit, 3 files, +30/-1.

## Scope
- src/providers/byteplus/generators/video.ts, src/providers/byteplus/types.ts, tests/unit/providers/byteplus/video-body.test.ts
- Callers: src/providers/byteplus/commands/{video,image-to-video,reference-to-video}.ts
- Worker: worker/src/jobs/cli-command-policy.ts; README.md, docs-site, skill/

## Verification
- `npx vitest run tests/unit/providers/byteplus`: 4 files, 31 tests passed.
- `npx tsc --noEmit -p .`: clean. `npx biome check` on touched dirs: clean.
- Commander default check (scratch script, the repo's commander, `.option("--audio").option("--no-audio")`, same order as all three commands):
  - no flag -> `opts.audio === undefined` (key absent)
  - `--audio` -> `true`; `--no-audio` -> `false`
  Commander only sets the default to `true` from `--no-x` when `--no-x` is declared without a preceding `--x`. All three commands declare `--audio` first (video.ts:34-35, image-to-video.ts:33-34, reference-to-video.ts:57-58).

## Answers to the brief
- Default case: with neither flag, `audio` is undefined and `generate_audio` is left out of the body (video.ts:84). Requests without the flag do not change. Before this commit, no flag also sent nothing (`--wm` was only appended when audio was defined). The risk that every request now carries `generate_audio: true` does not happen.
- Flags mode: `--wm` is gone from the text, and `generate_audio` is top-level. Test asserts text === "p" for both values, so it does prove the watermark command is no longer emitted.
- Structured mode: sends both `generate_audio` and the existing `parameters.audio`. This adds a field and removes nothing.
- Worker/MCP: worker/ does not import `buildVideoTaskBody` or `VideoTaskRequest` (grep of worker/src). `multix_run` executes the CLI in the job container. The policy entries for `byteplus video|image-to-video|reference-to-video` (cli-command-policy.ts:214-223) set only file options and duration/resolution caps, and do not filter or inject `--audio`. Container/Worker compatibility is unaffected: no job spec or R2 layout change. `npm run check:mcp` is not required (the client's runtime-neutrality is unchanged, no `node:*` import added).
- Docs: README.md:458 lists `[--audio|--no-audio]` only as syntax. docs-site byteplus pages and skill/video-production do not describe Seedance `--audio` semantics or mention `--wm`. No doc claims the old behavior, so no doc update is required.

## Critical
None.

## High
None.

## Medium
1. Explicit `--audio` / `--no-audio` can now fail with HTTP 400 on models without audio support — src/providers/byteplus/generators/video.ts:84.
   Scenario: user sets `BYTEPLUS_VIDEO_MODEL` (or `-m`) to a Seedance 1.0 model id and passes `--no-audio`. Before: `--wm false` was appended to the text, so the task succeeded silently with no watermark change. After: `generate_audio: false` goes to a model that per the Volcengine doc does not accept it, and the ARK API may reject the task. This is the correct trade-off: an explicit flag the API cannot honor should not be silently dropped. It is still a user-visible behavior change shipped as a `fix` (npm patch release). The default models (seedance-2.0 family) accept `generate_audio`; third-party API examples for Seedance 2.0 send it, but I did not confirm this against the official BytePlus spec. No code change needed. Mention it in the PR body so a 400 can be traced to it.

## Low
2. Header comment placement — video.ts:8. The new line "Audio is always the top-level `generate_audio` field." sits between the `flags` and `structured` bullets, so it reads as part of the flags bullet. Move it below both bullets.
3. Help text implies audio is off unless enabled — commands/video.ts:34, image-to-video.ts:33, reference-to-video.ts:57 ("Enable audio track"). On models whose `generate_audio` default is true (1.5 pro per the Volcengine doc; likely 2.0), leaving out the flag means the server default applies, which is audio on. This behavior existed before the commit and the commit does not make it worse. Consider "(default: model decides)" in a follow-up issue rather than in this PR.
4. No command-level test pins the commander default (no flag -> undefined). The unit test covers `audio: undefined` at the builder only. If someone later reorders the options to put `--no-audio` first, `audio` becomes `true` by default and every request carries `generate_audio: true`. A small test that parses `byteplus video` with `--async` against a mocked fetch and asserts that `generate_audio` is absent would lock this in. This is optional.

## Edge cases checked
- `--audio --no-audio` together: commander takes the last one; same as before.
- `BYTEPLUS_VIDEO_PARAMS_MODE=structured`: the duplicate audio field is harmless and covered by a test.
- Existing tests that compare whole bodies still pass, so no snapshot relied on `--wm`.
- Concurrency, auth, data exposure: no impact (pure body builder; no logging of new fields).

## Plan / process follow-ups
- AGENTS.md says to branch from `main`; this branch's base is `origin/dev`. Confirm the PR target is intentional.
- Commit message follows conventional format, uses `Closes #458`, and has no plan IDs in code.

## Recommended actions
1. Optional: move the header comment line (Low 2).
2. Note the explicit-flag 400 possibility in the PR body (Medium 1).
3. Optional follow-up issue: help text and docs saying what happens with no audio flag (Low 3), plus a command-level default test (Low 4).

## Unresolved questions
- Official BytePlus (international) ModelArk spec for `generate_audio` on seedance-2.0 / 2.0-fast / 2.0-pro: supported and default value. Only the Volcengine doc and a third-party tutorial were checked.

Status: DONE
Summary: The fix is correct and safe. Commander leaves `opts.audio` undefined when neither flag is given, so the default request does not change and `generate_audio` is sent only on an explicit flag. Tests, typecheck and lint pass. Worker and docs are unaffected. The findings are Medium/Low only.
