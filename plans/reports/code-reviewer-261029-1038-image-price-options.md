# Code review: image price options in multix_run (issue #447)

## Scope
- Files: worker/src/jobs/{cli-command-policy,run-option-caps,run-argv-builder,catalog-view}.ts, worker/test/{run-argv-builder,cli-catalog}.test.ts, README.md, docs-site guides/mcp-server.md (en + vi)
- About 120 changed lines (uncommitted diff)
- Verified: focused vitest run (2 files, 73 tests pass), worker `tsc --noEmit` clean, biome clean

## Overall
The mechanism is sound and fails safe: a value that is given and does not match a known default always makes the run uncapped. Coverage is incomplete, though. Runway's resolution tier and Leonardo's bare-flag price switches are missed, and the docs claim about "repeating the CLI default" is wrong for every option that has no default in the catalog.

## High
1. **`runway image --ratio` is missing** (worker/src/jobs/cli-command-policy.ts:313-316). `src/providers/runway/models.ts` marks gen4_image with `creditsVary: true` ("from" price that varies by resolution). IMAGE_RATIOS includes 1080p-tier ratios (1920:1080, 1080:1920, 1440:1080, 2112:912, ...). The default is DEFAULT_IMAGE_RATIO 1280:720. This is exactly the "resolution tier" case in #447. Fix: add `priceOptions: ["ratio"]`. The catalog default is undefined (the default is applied in code), so any given ratio is flagged; that is acceptable, but it should be documented.
2. **`leonardo generate --ultra` / `--alchemy` are not covered** (cli-command-policy.ts:227-230). Both are bare flags (`takesValue: false`) that switch to higher-priced generation modes. The new check uses `single(values, name)` (run-option-caps.ts:110), which returns `undefined` for a bare flag (`true`). Adding the flags to `priceOptions` today would therefore do nothing silently. Fix: in `uncappedReason`, treat `values.get(name) === true` as "given, not default". Or put them in `uncappedOptions`, which uses `values.has`. Then add both flags.

## Medium
3. **Docs claim "repeating the CLI default keeps the run capped" is inaccurate** (docs-site guides/mcp-server.md:163, vi :159). It holds only where the catalog has a default: openai size/quality, leonardo quality and multiplier. Many CLI defaults are applied in code, so the catalog has no default for them: byteplus `--size` (default `BYTEPLUS_DEFAULTS.imageSize` = "2K"), leonardo width/height (`LEONARDO_DEFAULTS`), gemini/openrouter/fal/atlas sizes, and runway ratio. For those, passing the real default (e.g. `byteplus generate --size 2K`) is still marked uncapped. Fix: say "repeating a default shown in multix_catalog". catalog-view.ts already words this correctly ("when given ..."), so only the docs need the fix.
4. **In the default `budget` mode these runs can never start.** No image command has a pre-flight estimator: src/budget/command-cost.ts prices only speech and transcribe commands. `cost_policy: "strict"` plus "unknown cost" means refusal (command-cost.ts:333-336). In practice, then, `gemini generate --size 2K`, `openai generate --quality high`, `leonardo generate --width 1536` and the rest are denied unless the operator sets `allow`. This may be intended (fail closed), but it is a user-visible behaviour change for MCP callers and is not stated. README:1034 says "start only with a max_cost_usd their price estimate proves", which implies the run can start. Fix: state in the docs that image commands have no estimate, so in budget mode they are refused until one exists. Also consider mentioning it in the error message.
5. **`leonardo generate --quality` is flagged, but its default `HIGH` is already the most expensive tier** (cli-command-policy.ts:229). Only cheaper choices (LOW/MEDIUM) get marked uncapped. This adds friction with no spend protection. The same holds for `leonardo upscale --multiplier 1` (default 1.5, maximum 2): only 2 raises the price. Either drop `quality` or note this as a deliberate conservative choice.

## Low
6. **Case and trim normalisation is looser than the CLI** (run-option-caps.ts:113). The test at run-argv-builder.test.ts:727 treats `quality: "MEDIUM"` as capped, but argv forwards `--quality=MEDIUM` unchanged, and `parseImageQuality` (src/providers/openai/models.ts:67-71) is case-sensitive, so the CLI rejects the run. No money is spent, so this is safe. But the test asserts a case that fails at runtime, so it is close to a phantom test. Prefer an exact-match comparison (only trim), or test with the exact default `"medium"`.
7. **Numeric defaults are compared as strings.** `multiplier: 1.50` or `"1.50"` does not equal `"1.5"`, so the run is marked uncapped. This fails safe. Fine as is; noted only so nobody relies on numeric equality.
8. **The catalog-view text for price options has no test** (catalog-view.ts:74-79). Neither branch (with default / without default) is asserted. The `cli-catalog.test.ts` addition only checks that the option names exist (useful: it would catch typos, and it now covers `uncappedOptions` too).
9. **Not in scope, worth a follow-up issue:** `--model` is a larger price lever on every image command (e.g. a Pro or 4K-default model under `gemini generate`, `openrouter generate`, `atlas image`). `cloudflare generate --steps` (1-8, default 4) also scales the per-step price, but its range is small and bounded by the CLI.

## Checked, no issue
- Commands without price options in the catalog: gemini/openrouter/minimax image-to-image, minimax generate. Replicate image already covers `--input` through `uncappedOptions` and the count through countFromModel.
- byteplus `--aspect-ratio` maps to sizes of about 2K (ASPECT_TO_SIZE), the same tier as the 2K default, so leaving it out is fine.
- `prepareRun` passes `options` after `applyCaps`. Forced values and caps do not touch the price options.
- The precedence of `uncapped_spend` in catalog-view (countFromModel overrides) does not conflict: no option is in both lists.

## Recommended actions
1. Add `runway image` `priceOptions: ["ratio"]`.
2. Handle bare flags in `uncappedReason`, then add `ultra` and `alchemy` to leonardo generate.
3. Fix the docs sentence about defaults (en, vi, README). State that budget mode refuses these runs because image commands have no estimator.
4. Decide on leonardo `quality`: drop it or keep it as a deliberate choice.
5. Add a catalog-view test for the price-option text, and tighten or replace the `"MEDIUM"` case test.

## Unresolved questions
- Is refusing image runs in budget mode (no estimator) the intended outcome for #447, or should an image estimator come first?
- Is byteplus Seedream billed per image regardless of size? If so, byteplus `--size` is not a price option and only adds friction.
