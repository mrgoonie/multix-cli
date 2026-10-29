# Code review: image size / quality as uncapped spend (#447)

Commit 7a1adf9 on `claude/relaxed-clarke-puur47` vs `origin/dev` (only this commit differs).
Files: worker/src/jobs/{cli-command-policy,run-option-caps,catalog-view}.ts, worker/test/{run-argv-builder,catalog-view}.test.ts, README.md, docs-site mcp-server.md (en, vi). About 120 LOC.

Checks run: `vitest run test/run-argv-builder.test.ts test/catalog-view.test.ts` (67 passed), worker `tsc --noEmit` (clean), `biome check` on touched files (clean).

## Verified as correct

- **`values` never holds CLI defaults for these options.** In `prepareRun` (worker/src/jobs/run-argv-builder.ts:150-205), `values` gets only:
  - options the caller passed;
  - resolved `inputs` paths;
  - `policy.forced` (only `driver` and `model`);
  - `output-dir`;
  - values filled by `applyCaps`, which only fills `duration` / `resolution` for video `CapRules`.

  None of the new `imageSizeOptions` overlap a cap list. So a run that omits the option stays capped. Atlas `resolution` is not in a `caps.resolution` list for `atlas image` or `atlas image-to-image`, so it is never auto-filled.
- **Short flags are not a bypass.** Option lookup uses `optionName(o)`, which is the long name (worker/src/jobs/cli-catalog.ts:39-41). `{"w": 1536}` or `{"-w": 1536}` fails with "Unknown option --w" before argv is built. `{"--width": ...}` is stripped to `width` and is marked.
- **A falsy value is still marked.** An empty string `size: ""` passes `scalar` and is marked, which errs on the closed side. `false` on a value option throws.
- **Ordering in `uncappedReason`** (worker/src/jobs/run-option-caps.ts:104-118): a size option is reported before an omitted model count. Either way the run is uncapped, so the order is harmless.
- **Every listed option exists in worker/src/cli-catalog.json for its command.** This includes `leonardo upscale --multiplier`, `atlas image(-to-image) --resolution` and `openrouter generate --image-size`. I checked this with a script.
- **The REST path inherits the change.** `POST /api/v1/jobs` (worker/src/api/job-api-handlers.ts:180-187) uses `prepareRun`, `assertSpendGuard` and the strict preflight, so the docs claim of "same rule" holds.
- **Commands correctly left out:**
  - `gemini image-to-image`, `openrouter image-to-image` and `minimax generate` / `minimax image-to-image` have no size, quality or tier option in the catalog.
  - `byteplus --aspect-ratio` maps to about 2K, the same as the default `imageSize: "2K"` (src/providers/byteplus/generators/image.ts:37-63).
  - `leonardo generate --quality` defaults to `HIGH`, already the top tier.

## Findings (ranked)

### High

**H1. `runway image --ratio` is missed even though it changes the price per image.**
worker/src/jobs/cli-command-policy.ts:308-311 has no `imageSizeOptions`. The repo itself records that `gen4_image` has `credits: 5, creditsVary: true` ("from" price when it varies by resolution), at src/providers/runway/models.ts:99-112. The default is `DEFAULT_IMAGE_RATIO = "1280:720"` (models.ts:40). `IMAGE_RATIOS` includes 1080p-class ratios (`1920:1080`, `1080:1920`, `1440:1080`, `2112:912`, ...).

Failure scenario: a remote caller runs `runway image` with `{"ratio": "1920:1080"}`. The run is treated as capped and starts without `max_cost_usd`, at the higher 1080p credit rate. This is exactly the class of run #447 is meant to gate.

Fix: add `imageSizeOptions: ["ratio"]` to `"runway image"`, then update the docs (en, vi) and the test table.

### Medium

**M1. `leonardo generate --ultra` (and `--alchemy`) is missed.**
worker/src/jobs/cli-command-policy.ts:225 lists only `width` / `height`. The CLI sends `ultra` / `alchemy` straight into the generation body (src/providers/leonardo/commands/generate.ts:58-59, 105-106). Ultra is Leonardo's higher-resolution, higher-cost generation tier, and Alchemy is also an upcharge.

Failure scenario: `{"ultra": true, "num": 4}` stays capped by count only, while each image is billed at the Ultra rate.

Fix: add `"ultra"` and `"alchemy"` to the leonardo generate `imageSizeOptions`. If the field name should stay strictly "size", widen its doc comment to say "tier".

**M2. Marking ignores the value, so cheaper or default values are now refused under the default `budget` mode.**
`uncappedReason` marks a run whenever the option is present (run-option-caps.ts:108). No image command has a pre-flight estimator: `pricedCommands()` covers speech only (src/budget/command-cost.ts:53-118). So in `budget` mode every such run fails with BUDGET_UNPROVEN, and in practice it behaves like `deny`.

Failure scenarios that now break in a default deployment:
- `openai generate {"quality": "low"}` is cheaper than the default `medium`, but is refused.
- `openai generate {"size": "1024x1024"}` is the CLI default, but is refused.
- `leonardo upscale {"multiplier": 1}` is below the default 1.5, but is refused.
- `leonardo generate {"width": 512, "height": 512}` is refused.

These were all accepted before this commit. That is a silent behaviour regression for MCP and REST clients. The docs-site does say "None of these commands is priced yet, so in practice `budget` refuses them", but the new bullet only says "omitting keeps the model default", not that passing the default explicitly is refused.

Options, for the issue owner to decide:
- (a) Accept the regression and state it explicitly in the docs and the error message. The current message says "omit it to keep the model default", which is good.
- (b) Allow values at or below the default per command: openai quality in {low, medium}; size equal to the default; leonardo multiplier <= 1.5; width*height <= the default pixel count.

Option (b) needs a small per-option predicate instead of a name list.

**M3. The policy name check does not cover `imageSizeOptions`.**
worker/test/cli-catalog.test.ts:21-47 ("has a policy that only names ... options ... the CLI has") collects `fileOptions`, `urlOptions`, `forced`, `unsupported`, `nameOptions`, `repeatable` and `caps.*`. It does not collect `imageSizeOptions` (nor the existing `uncappedOptions`).

Failure scenario: a future CLI rename (for example `--image-size` to `--size`) or a typo in the policy fails open. `values.has(name)` never matches, the run is treated as capped, and no test fails.

Fix: add `...(policy.imageSizeOptions ?? [])` and `...(policy.uncappedOptions ?? [])` to `named`. All current names pass this check (verified).

### Low

**L1. `cloudflare generate --steps` is not marked.**
It ranges from 1 to 8 with a default of 4 (src/providers/cloudflare/commands/generate.ts:23, src/providers/cloudflare/models.ts:56-62). Workers AI bills flux-1-schnell per step, so `steps: 8` roughly doubles the step portion of the cost. The CLI bounds it at 2x, so the impact is small. Mark it, or note it as accepted.

**L2. Test gaps in worker/test/run-argv-builder.test.ts:687-712.**
- The case table skips `openai image-to-image`, `byteplus image-to-image`, `leonardo image-to-image` (`height`), `atlas image-to-image` and `gemini generate`'s default-off case.
- No test exercises the guard end to end: that `multix_run` or `POST /api/v1/jobs` with `{"size": "4K"}` and no `max_cost_usd` is refused in `budget` mode, and refused even with `max_cost_usd` because the estimate is unknown.
- worker/test/catalog-view.test.ts checks only `openai generate`. A table over `COMMAND_POLICIES` asserting that each `imageSizeOptions` name carries `uncapped_spend` would catch drift.

**L3. Docs.**
- README.md:1034-1036: "an image `--size` / `--quality` the caller sets" leaves out `--resolution`, `--image-size`, `--width` / `--height` and `--multiplier`. It also keeps the wording "start only with a `max_cost_usd` their price estimate proves" without the docs-site caveat that no such command is priced, so `budget` refuses them.
- docs-site/src/content/docs/guides/mcp-server.md:152-155: the previous bullet ends with "capped again." and the new bullet ends with "capped.", while earlier bullets end with ";". This is cosmetic.
- en and vi content match.

**L4. One message per option for `catalog-view`.**
catalog-view.ts:74-76 overwrites `uncapped_spend` if an option were in both `uncappedOptions` and `imageSizeOptions`. That does not happen today, so this is a note only.

## Edge cases scouted
- Alias command paths (`leonardo gen`): `normaliseCommand` does not resolve aliases, and the catalog index has canonical paths only, so aliases are rejected rather than bypassing the policy.
- Options spelled with dashes (`--size`): stripped, then marked.
- The `estimate: true` call path still answers without the guard, as documented.

## Recommended actions
1. Add `ratio` to `runway image` (H1), and `ultra` / `alchemy` to `leonardo generate` (M1). Update the en and vi docs and the tests.
2. Decide on M2: either document explicitly that passing any value, including the default, is refused under `budget`, or add value-aware predicates.
3. Extend the cli-catalog policy name test to `imageSizeOptions` and `uncappedOptions` (M3).
4. Broaden the test table and add one guard test at the `job-tools` or REST layer (L2).

## Unresolved questions
- Is the M2 regression (cheaper or default values refused in `budget` mode) intended by #447?
- Should `cloudflare --steps` and the `replicate image` / `atlas` `--aspect-ratio` count as "tier" options? Some per-megapixel models price by aspect ratio; the repo has no price data for this.

Status: DONE_WITH_CONCERNS
Summary: The mechanism is correct: no CLI defaults leak into `values`, short flags are rejected, and all listed option names exist in the catalog. But `runway image --ratio` (High) and `leonardo generate --ultra/--alchemy` (Medium) are missed, value-blind marking refuses cheaper or default values under `budget`, and the policy name test does not cover the new field.
