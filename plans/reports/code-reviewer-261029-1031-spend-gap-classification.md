# Code review: 9484b8b spend-gap classification (#443)

Commit: `9484b8b fix(mcp): mark omitted resolutions, fal video models, raw provider options and audio lengths as uncapped spend` vs parent `3ca77f8` (PR #441 head).
Reviewer: isolated code-reviewer, 2026-10-29.

## Scope
- Files: worker/src/jobs/{cli-command-policy,run-option-caps,run-argv-builder,catalog-view}.ts, worker/test/{cli-catalog,run-argv-builder}.test.ts, docs-site guides/mcp-server.md (EN + VI). +282/-21.
- Verified against: worker/src/jobs/job-tools.ts, worker/src/api/job-api-handlers.ts, src/budget/command-cost.ts, src/budget/cost-estimate.ts, worker/src/cli-catalog.json and the CLI sources of every touched command.

## Verification run
- `npx vitest run test/cli-catalog.test.ts test/run-argv-builder.test.ts`: 77/77 pass.
- Full worker suite: 27 files, 503 tests pass. `tsc --noEmit` clean. Biome on touched files clean.
- I computed `modelResolutionOptions` over the whole catalog. It reports openrouter image-to-video, atlas video, atlas image-to-video, replicate video, heygen model-video and heygen video (that last one is already uncapped at the command level). This matches the docs list exactly.

## Claims verified (no finding)
- Each of these CLIs sends a resolution only when one is given: atlas (`src/providers/atlascloud/commands/video.ts:30`; an unknown field throws at `model-input.ts:240`), replicate (`commands/video.ts:54`), openrouter i2v (`commands/image-to-video.ts:78`) and heygen model-video (`request-builders.ts:420-421`). Treating an omitted resolution as "the model picks" is correct.
- fal video has no resolution option (`src/providers/fal/commands/video.ts`). Its defaults are Kling 1.6 standard t2v/i2v (`models.ts:31,35`). The job env contains only provider key vars (`worker/src/jobs/job-runner.ts:78-83`), so `FAL_VIDEO_MODEL` cannot swap the default remotely.
- openrouter tts `--provider-options` goes into `body.provider.options` (`tts.ts:317-322`). byteplus generate-3d `--flags` is raw model flags. Both are correctly marked.
- elevenlabs music sends `music_length_ms` only when given, so the API picks the length (`music.ts:44`). sfx sends `duration_seconds` only when given (`sfx.ts:41`). ElevenLabs help centre: auto length costs a flat 100 credits; a set length costs 11 credits/s up to 30 s.
- Both run paths (MCP `job-tools.ts:210-219` and REST `job-api-handlers.ts:180-181`) feed `prepared.uncappedSpend` into `assertSpendGuard`, and the MCP path forces strict pricing.
- `speech generate --extra` is a typed per-provider whitelist (`src/speech/speech-catalog.ts`). It is not a raw body.
- `uncappedOptions` changed from array to record. There are no other consumers (grep). The catalog text for fal tts and replicate `--input` is unchanged.
- The EN and VI docs carry the same lists and caveats.

## Findings

### Blocking
None.

### Should-fix
1. **replicate video: an allowed `--resolution` counts as capped even if the chosen model does not honour a field named `resolution`.** Locations: `worker/src/jobs/cli-command-policy.ts:304`, `src/providers/replicate/commands/video.ts:54`. The CLI places `resolution` in the model input, and `-m` accepts any model. Some models name it something else (`size`, `quality`, `mode`) or render a fixed resolution. If Replicate/cog drops input fields the model's schema does not declare, `replicate video -m X --resolution 720p` is classified as capped while the model picks the resolution. That is the exact gap this commit closes for `fal video --model`. Replicate's 2024-05 validation change covers top-level payload keys only, so I could not confirm how nested `input` keys behave. The same weakness applies to `--duration` (pre-existing). Options:
   - (a) Confirm that Replicate rejects undeclared input keys, then document it in the policy comment.
   - (b) Mark `--model` as uncapped for replicate video, as for fal video. This is stricter and costs usability.
   - (c) Validate the model's OpenAPI schema before submitting, as atlas does.

   This is a policy call. If it is not fixed here, open a follow-up issue.

### Nits
2. **Dead allow-list entry.** Location: `worker/test/cli-catalog.test.ts:143`. `"speech generate extra"` is never consulted. `--extra <provider.key=value>` matches no kind pattern, does not match `<json|raw>`, and its description does not match the raw-body regex, so the entry never runs. Remove it, or add an assertion that every `notSpend` key was hit, so stale entries fail the test.
3. **Gaps in the catalog-wide test.** Locations: `worker/test/cli-catalog.test.ts:157,161`. The test skips:
   - boolean flags (`!option.takesValue`),
   - `fileOptions`, which are assumed never to be raw bodies,
   - positionals.

   It does not fail today. `elevenlabs music --plan` (a JSON composition plan) is a file option, but its command is already uncapped. Still, a future JSON-body file option, or a price-tier flag, would pass unnoticed. Current price-tier flags outside the issue's four categories: `byteplus video|image-to-video|reference-to-video --audio`, `leonardo generate --ultra/--alchemy`, `leonardo video|image-to-video --frame-interpolation`. Suggest a follow-up issue next to #447, since these are tier multipliers like image quality.
4. **Misleading option mark on an uncapped command.** Location: `worker/src/jobs/catalog-view.ts:80-82`. For `heygen video`, which already has `uncappedSpend` at the command level, `multix_catalog` marks `--resolution` "when omitted, the model picks the resolution". This suggests that passing it makes the run capped, and it does not. Skip the option-level resolution and count marks when `policy.uncappedSpend` is set.
5. **The fal video default-model claim is not pinned by a test.** Locations: `worker/src/jobs/cli-command-policy.ts:271-278`, `src/providers/fal/models.ts:31,35`. The new test "bounds or marks the resolution of every video-generating command" passes for fal video only because the reason given for `--model` mentions "resolution". If `FAL_DEFAULTS.videoModel` is later changed to a 1080p model, fal video stays "capped" with no failing test. Add an assertion pinning both defaults to the 720p ids, so that changing them forces someone to revisit the policy. Related: passing `--model` set to the default id is also marked uncapped. This is harmless but over-strict.
6. **The resolution hint lists the server's values, not the command's.** Location: `worker/src/jobs/run-option-caps.ts:133`. With the default list it says `pass --resolution: 480p, 720p, 768p, 1080p`. For `heygen model-video`, `720p` passes the server cap but the CLI rejects it (`480p|768p|1080p|2k`, `request-builders.ts:420`). Consider "an allowed value such as ..." or pointing to the option's description.
7. **sfx message slightly overstates the risk.** Location: `worker/src/jobs/cli-command-policy.ts:253-256`. The provider limits `--duration-seconds` to 30 s, at most about 3.3 times the auto price. "No server cap bounds" is literally true, but the run is bounded. Acceptable as a conservative choice. Optionally mention the provider's 30 s limit in the comment.

### Informational (behaviour change; worth a line in the PR body)
8. In the default `budget` mode, none of these runs has an estimator (`estimateCommand` returns unknown), so they are now refused even when `max_cost_usd` is given:
   - every `elevenlabs music` run,
   - `elevenlabs sfx --duration-seconds`,
   - `fal video --model`,
   - atlas/replicate/openrouter/heygen-model video without `--resolution`.

   The last group recovers by passing `--resolution`, and the error says how. Music cannot be run at all in `budget` mode, even with `--music-length-ms`. This is consistent with "no server cap bounds audio length", but it is a product decision; the alternative is an audio-length cap. Note it in the PR so the operator default is a conscious choice.
9. **Pre-existing, out of scope.** `src/providers/elevenlabs/commands/music.ts:20` says "(default 30000)", but the CLI sends nothing and the API picks the length. `leonardo video` has no `--duration`, and its V2 path hard-codes `duration: 8` (`src/providers/leonardo/commands/video.ts:82`). If an operator sets `MULTIX_MCP_MAX_VIDEO_SECONDS` below 8, the run is classified as capped but exceeds the cap. There is no duration counterpart to the new resolution test. Suggest separate issues.

## Plan / issue follow-up
#443 items: (1) omitted resolution: done. (2) fal video: done, by marking `--model`. (3) openrouter tts / byteplus generate-3d: done. (4) catalog-wide test: done, with the coverage limits in nits 2-3. The open question is finding 1.

## Unresolved questions
- Does Replicate reject or silently drop `input` keys that a model's schema does not declare? This decides whether finding 1 is real.
- Does the operator want `elevenlabs music` to be impossible in `budget` mode, or an audio-length cap?
