# Code review: commit 3252a21 (spend-gap classification, issue #443)

Reviewer: isolated code-reviewer (did not write the code). Date: 2026-10-29 UTC.

## Scope
- Files: worker/src/jobs/cli-command-policy.ts, run-option-caps.ts, catalog-view.ts;
  worker/test/spend-option-coverage.test.ts (new), run-argv-builder.test.ts;
  docs-site guides/mcp-server.md (EN + VI). ~259 added / 31 removed lines.
- Checks run: `npx vitest run test/spend-option-coverage.test.ts test/run-argv-builder.test.ts`
  (71/71 pass), `tsc --noEmit` in worker (clean), `biome check` on changed files (clean).
- Mutation checks (scratch worktree, since removed):
  - Removing `uncappedOptions: ["provider-options"]` from openrouter tts made the walk fail
    with `openrouter tts --provider-options (raw)`.
  - Switching atlas video back to `VIDEO_CAPS` made the resolution test fail.
  - A synthetic catalog command `fal newvid` with `--num-videos --quality --frames --payload
    --video-length` and no policy: only `--num-videos` and `--video-length` were flagged. `--quality`,
    `--frames` and `--payload` passed silently.

## Overall assessment
All four issue items are addressed. The resolution-from-model mechanism is correct for the five
commands it covers, because none of them has a CLI default for `--resolution` (verified in
cli-catalog.json), so `values.has()` matches what the CLI sends. One finding blocks merge: the
commit adds `elevenlabs music` to the docs, the policy comment and a test that assert a 30 s
default when `--music-length-ms` is omitted. That default does not exist, so the most common
music run is labelled capped when it is not.

## Blocking

### B1. `elevenlabs music` without `--music-length-ms` is uncapped but is treated as capped
- worker/src/jobs/cli-command-policy.ts:241-245; worker/test/run-argv-builder.test.ts:748;
  docs-site/src/content/docs/guides/mcp-server.md:154; vi/guides/mcp-server.md:152.
- Evidence: src/providers/elevenlabs/commands/music.ts:44 sends `music_length_ms` only when the
  flag is given. ElevenLabs compose API (elevenlabs.io/docs/api-reference/music/compose): the
  range is 3000–600000 ms, and when the field is omitted "the model chooses the song length
  based on the prompt". The CLI help text "(default 30000)" is not what the request does.
- Failure scenario: under `MULTIX_MCP_UNCAPPED_SPEND=budget` (the default) or `deny`, a caller
  sends `{"command":"elevenlabs music","options":{"prompt":"a 10 minute ambient piece"}}`. The run
  passes as capped and can bill up to 10 minutes of music. Meanwhile the explicit
  `--music-length-ms 30000` is refused. The guard is inverted for this command, and the docs
  promise "30 s otherwise".
- Fix: pick one option.
  - (a) Set `uncappedSpend: "billed by length; the model picks it when --music-length-ms is omitted"`
    on the whole command.
  - (b) Add a fill rule like `fillResolution`: send `--music-length-ms 30000` (or a value derived
    from the operator cap) when the flag is omitted with `--prompt`. Keep `--plan` and explicit
    lengths above the fill uncapped.
  - Then fix the test at run-argv-builder.test.ts:748 and both docs lines. Open a separate issue
    for the misleading CLI help "(default 30000)" in music.ts:20.
- Structural cause, which the coverage test cannot see: for options in `uncappedOptions`, the test
  checks only that the option is classified. It never checks what happens when the option is
  omitted. Omission is checked only for resolution (test 2). A duration or length option in
  `uncappedOptions` with no CLI default is the same gap as issue item 1. Extend test 2 so it fails
  for any option of kind duration in `uncappedOptions` (or in no cap at all) that has no CLI
  default, unless the command is `uncappedSpend`.

## Non-blocking

### N1. The coverage walk is name-based, so it misses common spend option names
- worker/test/spend-option-coverage.test.ts:32-42.
- Failure scenario: a new command whose spend option is named `--quality`, `--size`, `--frames`,
  `--fps`, `--steps`, `--outputs`, `--samples`, `--variants`, `--payload`, `--data` or `--json`
  passes the test unclassified (shown by the mutation above). The issue asked for a test so that
  "a new command cannot silently skip the guard". That holds only for the regex's vocabulary.
  The current catalog already has unflagged spend-relevant options: `cloudflare generate --steps`
  (Workers AI flux bills per step), `cloudflare generate-video --fps`, `leonardo upscale
  --multiplier`, `openai generate --quality`, and `--size` / `--image-size` / `--width` /
  `--height` on image commands (fal flux bills per megapixel).
- Fix: widen the regex (`^(frames|fps|steps|samples|variants|outputs|quality|size|width|height|multiplier)$|-size$|^(payload|data|json)$`).
  Classify the hits either in a cap or in `NOT_SPEND` with a reason, as is already done for
  `atlas image --resolution`. Better still, invert the default: require every value option of a
  spending command to be either in a small allowlist of known-neutral names (prompt, seed,
  output, model, voice, …) or classified. Then an unknown new name fails closed.

### N2. "Passing an allowed resolution makes the run capped again" is not always achievable
- docs mcp-server.md:162-165 (EN), vi:159-163; cli-command-policy.ts:278-279.
- Failure scenario: an Atlas video model whose schema has no `resolution` field (the
  `atlas video -m <model>` route) throws in `buildModelInput`
  (src/providers/atlascloud/model-input.ts:235-240) when `--resolution` is passed. Without it,
  the run is now uncapped. No estimator exists for atlas video, so `budget` mode refuses the model
  outright. The default models (seedance-v1-pro-fast) declare resolution, so the default path
  works. This also shifts the default behaviour for fixed-resolution models, which used to run.
  `openrouter image-to-video --resolution` is described as a "hint" in the CLI, so "capped" there
  depends on the model honouring it.
- Fix: reword the docs to "for models that accept `--resolution`…". Note that a model without a
  resolution field needs `allow` mode. Optionally mention the openrouter hint caveat. No code change
  is needed if this is the intended fail-closed choice.

### N3. The `fal video` fix effectively disables the command under the default mode
- cli-command-policy.ts:261-265.
- Marking the whole command `uncappedSpend` is fail-closed and satisfies issue item 2. But fal
  video has no estimator, so it is refused in the default `budget` mode, which is a behaviour
  change for existing remote users. The issue asked for a resolution cap. The alternative (add
  `--resolution` to `fal video` in src/providers/fal/commands/video.ts and use MODEL_VIDEO_CAPS)
  would keep the command usable. This is acceptable as a stopgap, but the PR body should say that
  fal video now needs `allow`. Consider a follow-up issue.

### N4. The docs claim about the openrouter tts estimate is literally true but overstates usefulness
- mcp-server.md:171; vi:169.
- Verified: among the uncapped commands, only `openrouter tts` is in `BUILDERS`
  (src/budget/command-cost.ts:53-109). However, uncapped runs are forced to `cost_policy: strict`
  (worker/src/jobs/job-tools.ts:216-218, api/job-api-handlers.ts:186). The default openrouter tts
  model (Gemini TTS) bills `output_audio_tokens`, which is never `proven`
  (src/budget/cost-estimate.ts:255-257). So `budget` also refuses openrouter tts
  `--provider-options` with the default model. Only per-character-priced models pass, and text from
  `--text-file` / `--turns-file` is not priced at all. Note too that the estimate ignores
  `--provider-options`, so where it passes it does not "see the uncapped part". The risk is low,
  because OpenRouter bills its listed per-model rate.
- Fix: "Of these, only `openrouter tts` has a price estimate, and only models with a proven
  per-character price pass it, so in practice `budget` refuses the others…". Mirror this in VI.

### N5. The `speech generate --extra` exemption reason is inaccurate
- spend-option-coverage.test.ts:27-28.
- The elevenlabs extras include `previous_text` / `next_text` (src/speech/speech-catalog.ts:112-120).
  The CLI's own estimator counts them as billed text for `elevenlabs tts`
  (command-cost.ts:65-76). The spend is bounded by request size like any text, so the exemption
  holds, but the stated reason ("none of which changes the billed unit") is wrong.
- Fix: "keys come from a fixed list per provider; the only text keys (elevenlabs
  previous_text/next_text) are bounded like the prompt".

### N6. The "new command" test proves the helpers, not the walk
- spend-option-coverage.test.ts:93-110.
- It calls `spendKind` / `isCovered` on a hand-built option. It does not show that the walk
  over `spendingCommands()` would include a new command. The walk also skips any group missing
  from `GROUP_KEYS` (line 54). That is fine today, because such a group gets no keys, but a new
  provider group added without a `GROUP_KEYS` entry is invisible to the test. That is the moment
  the test matters most.
- Fix: rename the test to describe what it checks, or factor the walk into a function that takes
  a catalog and policy table, and feed it a synthetic command. Add an assertion that every catalog
  group is either in `GROUP_KEYS` or in an explicit keyless list.

## Nits
- mcp-server.md:170-172 (EN) and vi:169-170: the edited lines exceed the file's ~80-column wrap.
- Commit message: "elevenlabs music … mark a run uncapped" is scope beyond #443. That is fine, but
  it carries the B1 error into the changelog (a `fix` commit publishes to npm).
- The message wording change "the server caps do not bound the request" is accurate for all
  current `uncappedOptions` (raw bodies, flags, lengths) and is consistent across uncappedReason,
  catalog-view and tests. No issue.

## Edge cases checked (no defect)
- None of the 5 MODEL_VIDEO_CAPS commands has a CLI `--resolution` default, so an omitted value
  matches what is actually sent.
- `--resolution ""` is rejected by applyCaps (normalises to "" and is not in the allowed list).
- byteplus video, cloudflare generate-video, minimax and leonardo video have CLI defaults that
  applyCaps checks. Test 2 enforces this.
- countFromModel is checked before resolutionFromModel. No command has both, so only one reason
  is reported.

## Plan / issue follow-ups
- Items 1, 2 and 3 of #443: complete, with the caveats in N2 and N3.
- Item 4: partially met. A walk exists and fails on known names, but it misses unknown names (N1)
  and omitted-length gaps (B1).

## Unresolved questions
- Is refusing fal video and fixed-resolution atlas models under the default `budget` mode an
  accepted product choice (N2, N3), or should fal video get a `--resolution` option?

Status: DONE_WITH_CONCERNS
Summary: The classification and the new test work for the issue's four items. But
`elevenlabs music` without `--music-length-ms` is wrongly treated as capped (the model picks up to
10 min, so the docs' "30 s otherwise" is false), which blocks merge. The name-based coverage test
misses spend options with other names (quality, size, frames, steps, payload).
