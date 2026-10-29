# Code review: leonardo video fixed length under MULTIX_MCP_MAX_VIDEO_SECONDS (b36305c, #456)

## Scope
- Commit: b36305c on `claude/relaxed-clarke-1371vf` (parent f96162b, on origin/dev)
- Files: worker/src/jobs/run-option-caps.ts, worker/src/jobs/cli-command-policy.ts,
  worker/test/run-argv-builder.test.ts, src/providers/elevenlabs/commands/music.ts,
  worker/src/cli-catalog.json, docs-site/src/content/docs/{,vi/}guides/mcp-server.md
- LOC: +40 / -7
- Checks run: `npx vitest run test/run-argv-builder.test.ts` (73/73 pass); biome on the 4 changed TS
  files (clean); `tsc --noEmit` in worker (clean); merge simulation with PR #455 (below).

## Overall assessment
Small, correct and well placed. No blocking defects. The refusal is enforced in the single choke
point every cap-consuming path goes through. Remaining concerns: an unverified provider claim
(that v1 models render at most 8 s), one vacuous test assertion, and a trivial textual conflict with PR #455.

## Verification of the specific questions

1. **Refusal reaches every path that uses caps: yes.** `applyCaps` is called only from `prepareRun`
   (worker/src/jobs/run-argv-builder.ts:201). `prepareRun` is the first step of `multix_run`
   (worker/src/jobs/job-tools.ts:210, before the estimate/costPreflight branch) and of REST
   `POST /api/v1/jobs` (worker/src/api/job-api-handlers.ts:180). Estimate-only calls are refused too,
   because `prepareRun` runs before `costPreflight`. Over-cap `--duration` values already behave this way. No other Worker
   code calls Leonardo video directly (grep: only cli-command-policy.ts and the secret list mention leonardo).
2. **Cap below 8 is reachable: yes.** `boundedInt` (worker/src/config.ts:131-135) accepts any integer
   from 1 to 15 (`VIDEO_SECONDS_CEILING`), default 10. So 1-7 trigger the new refusal, 8 passes (the test covers both sides of the boundary).
3. **v1 models longer than 8 s: unverified, plausible risk (non-blocking).** For v1 ids the CLI sends no
   `duration` (src/providers/leonardo/commands/video.ts:93-101). Leonardo documents `duration: 5 or 10`
   for KLING2_1 and Kling2_5 (docs.leonardo.ai/docs/kling-2-1-pro.md, kling-2-5-turbo.md), and does not
   document the default when the field is omitted. The Kling 2.5 text-to-video recipe sends `duration: 5` explicitly.
   Motion 2.0's page lists no duration. The repo's own `image-to-video --duration` help lists `4|5|6|8|10`.
   So "at most the 8 s of Veo 3" (cli-command-policy.ts:215-216, commit message, both docs pages) is an
   inference, not a checked fact. `--model` is also free-form: any id not in `LEONARDO_V2_VIDEO_MODELS`
   goes to the v1 endpoint with the provider's default. If a v1 default is 10 s, a cap of 8 or 9 still lets a
   10 s clip through. Lowest-risk options: (a) have the CLI send an explicit `duration` for v1 Kling ids
   (5), or (b) word the comment and docs as "8 s for the v2 models; v1 models use the provider default (5-8 s observed)"
   and record the source. Not a regression: before this commit nothing was bounded at all.
4. **Test quality** (worker/test/run-argv-builder.test.ts:142-156): the boundary checks (cap 8 passes with
   the exact argv, cap 7 throws the right `ValidationError` and message) are real. Line 144,
   `expect(run(request).argv).not.toContain("--duration")`, is vacuous. Array `toContain` checks for an
   exact element, and the builder emits `--duration=N`, so it would pass even if a duration were added.
   It also cannot fail anyway, because `leonardo video` has no `--duration` option in the catalog.
   Use `expect(argv.some(a => a.startsWith("--duration"))).toBe(false)` or drop it. The pre-existing line 769 has the
   same pattern. No REST-path test exists, which is acceptable because the REST handler shares `prepareRun`.
5. **Docs (EN/VI)**: content matches the code and the VI text is a faithful translation. Problems: (a) both
   pages repeat the unverified "renders up to 8 s / tạo video tới 8 giây" claim (EN mcp-server.md:132-134,
   VI mcp-server.md:130-132). (b) The edited line `below 8) and resolution (`MULTIX_MCP_ALLOWED_RESOLUTIONS`). The server chooses the output directory,`
   (and its VI equivalent) was not reflowed and is much longer than the surrounding wrapped lines. This is cosmetic.
6. **elevenlabs music help** (src/providers/elevenlabs/commands/music.ts:20-23): this is now accurate.
   ElevenLabs compose docs say "Must be between 3000ms and 600000ms" and "if not provided, the model will choose a length
   based on the prompt", and the CLI sends `music_length_ms` only when given (music.ts:47). cli-catalog.json was updated in step.
   README.md:568 and skill/speech-production/SKILL.md:138 use 30000 only as an example value, so they are not stale.
   Optional: the API applies the field only with a prompt (not with `composition_plan`), and the help does not say so.

## PR #455 interaction (origin/claude/relaxed-clarke-18lmki, fetched read-only)
- `git merge-tree` gives **one textual conflict** in worker/src/jobs/cli-command-policy.ts: both branches append
  a new `CapRules` member right after `fillResolution` (`fixedSeconds` vs `resolutionFromModel`). The fix is to keep both.
  run-option-caps.ts, run-argv-builder.test.ts and both docs pages auto-merge.
- **Semantics: no break.** With the conflict resolved by keeping both members, in a scratch copy of the merged tree,
  `spend-option-coverage.test.ts` plus `run-argv-builder.test.ts` pass (81/81). `leonardo video --resolution`
  has a default, so PR #455's "omitted resolution left to the model" walk does not flag it. The walk finds options by
  name only, so it neither needs nor checks `fixedSeconds`. A future command with a fixed length and no
  duration option would go undetected there. That is a gap in the coverage test, not in this change.
- The merged docs paragraph should be re-read once after the merge, because both PRs edit the same "Server limits" section.

## Findings

### Blocking
None.

### Non-blocking
1. worker/src/jobs/cli-command-policy.ts:215-217 (also the commit message and docs): "v1 models render at most 8 s"
   is unverified. KLING2_1 and Kling2_5 accept 10 s and their omitted-duration default is undocumented, and `--model` is free-form.
   Either pin the v1 duration in the CLI or soften the claim and cite a source.
2. worker/test/run-argv-builder.test.ts:144: the `not.toContain("--duration")` assertion is vacuous (argv holds `--duration=N`).
3. worker/src/jobs/cli-command-policy.ts:40-44: textual merge conflict with PR #455 (`resolutionFromModel`). The resolution is trivial; whichever PR lands second must rebase.
4. docs-site/src/content/docs/guides/mcp-server.md:134 and vi/guides/mcp-server.md:132: the paragraph was not reflowed (overlong line).
5. worker/src/jobs/catalog-view.ts: `multix_catalog` does not tell callers that `leonardo video` is refused under a cap below 8.
   This matches how other caps are shown (they are not shown either), so it is informational only.

## Metrics
- Tests: worker run-argv-builder 73/73; merged with #455: 81/81 across both files
- Lint: 0 issues (biome, changed files); worker typecheck clean

## Unresolved questions
- What does Leonardo's `/generations-text-to-video` render for KLING2_1 / Kling2_5 / MOTION2 when `duration` is omitted? A single
  live call (or Leonardo support) would settle finding 1.
