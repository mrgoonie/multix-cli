# Code review: image model allowlist for multix_run (issue #452)

- Commit: 07cbbc3 on `claude/relaxed-clarke-ta8dpt`, base `origin/dev`
- Date: 2026-10-29 (UTC)
- Scope: 10 files, +190/-5. The diff was read in full, along with `prepareRun`, `run-option-caps.ts`, `cli-catalog.ts`, `catalog-view.ts`, `job-api-handlers.ts`, `account-store.ts#toolEnvFor` and the provider model resolution for every image command.
- REVIEW.md: not present.

## Verdict

No blocking issues. The allowlist covers every runnable command that has image outputs and a `--model` option. I found no bypass through aliases, short flags, forced values, JSON bodies, container env defaults, the REST API or the estimate path. Two findings are should-fix (doc accuracy, and the checked value differing from the sent value). The rest are optional.

## Verification run

- `npx vitest run test/run-argv-builder.test.ts test/job-tools.test.ts`: 99/99 passed.
- Full worker suite `npx vitest run`: 28 files, 532 tests passed.
- `npx tsc -p worker/tsconfig.json --noEmit`: clean.
- `npx biome check` on the 6 changed TS files: clean.
- Not run: root `npm test`, `npm run check:mcp` bundle check, `npm run verify:docs`. The one new import (`src/capabilities/command-capabilities.js` in `run-option-caps.ts`) is already bundled through `catalog-view.ts`, so the bundle check is low risk. It should still run before the PR.

## Bypass and coverage analysis (checked, none found)

| Vector | Result | Evidence |
|---|---|---|
| Image commands missed | None. I enumerated all runnable catalog commands with a throwaway vitest script (scratchpad only). All 19 runnable commands with `outputs` including `image` and a `--model` option are covered: gemini/minimax/openai/openrouter/leonardo/byteplus generate and image-to-image, plus cloudflare generate, fal image, atlas image and image-to-image, replicate image, runway image and sume image. The only image-output commands without `--model` are `leonardo upscale` and `topview product-anyshoot` (see S1). | `commandCapability` + `cli-catalog.json` |
| Command aliases (`gemini i2i`) | Refused as unknown before the check. `CatalogIndex.find` is an exact map lookup on canonical paths, so `commandCapability(path)` always gets a canonical key. | `worker/src/jobs/cli-catalog.ts:29-31,56-58` |
| Short flag / other option names (`-m`, `model-id`) | `-m` and `m` are not long names, so they are rejected as unknown options. No image command sets the model through a differently named option. | `run-argv-builder.ts:162-164` |
| Forced values | Forced values are applied at `:204` before the check at `:207`, so a forced model would be checked. Only video commands (`gemini generate-video` etc.) force `model`, and those are outside image scope. | `run-argv-builder.ts:204-207` |
| JSON body options | `replicate image --input` merges into the model *input* object and cannot change the model. `sume image --param model=...` is refused by the CLI (`RESERVED_FIELDS` contains `model`). Both are also `uncappedOptions`. | `src/providers/replicate/commands/image.ts:49`, `src/providers/sume/request-plan.ts:82-84,250` |
| Env-var defaults in the container | Every provider resolves `opts.model ?? envDefault(...)`, so the flag wins. When the catalog default is undefined, the allowlist forces `--model`, so env defaults (ATLASCLOUD_IMAGE_MODEL, OPENROUTER_IMAGE_MODEL, SUME_IMAGE_MODEL, CLOUDFLARE_AI_IMAGE_MODEL) are never reached. Commander defaults (`fal image`, `openai *`) have no env override. User keys cannot override `MULTIX_MCP_ALLOWED_IMAGE_MODELS`: `toolEnvFor` spreads keys over settings, but stored keys are limited to `PROVIDER_SECRET_NAMES` (pre-existing pattern shared with all caps). | `src/providers/*/commands/*image*.ts`, `worker/src/accounts/account-store.ts:217-219` |
| REST API | `postJob` calls the same `prepareRun(run, limits)`, and `api-router.ts:192` builds limits from `serverSettings(app.env)`, which now forwards the var. | `worker/src/api/job-api-handlers.ts:180`, `worker/src/config.ts:109` |
| Estimate path | `prepareRun` runs before `estimate` is consulted, so a disallowed model is refused even on estimate. This is consistent and fail-closed. | `worker/src/jobs/job-tools.ts:216-219` |
| Case / suffix tricks | Matching is exact and case-sensitive, so any variant fails closed. | `run-option-caps.ts:127` |

## Blocking

None.

## Should-fix

### S1. Docs say "every command whose outputs include images" is bounded, but two image commands run unaffected

- `docs-site/src/content/docs/guides/mcp-server.md:133-135` and `:177-183`, and `vi/guides/mcp-server.md:131-132` and `:173-179`. Both pages say every command with image outputs "then runs only with a listed `--model`".
- Code: `run-option-caps.ts:119` returns early when the command has no `model` option.
- Failure scenario: an operator sets `MULTIX_MCP_ALLOWED_IMAGE_MODELS=fal-ai/flux/schnell` and believes all image spend is pinned to one model. A caller still runs `leonardo upscale` and `topview product-anyshoot`, which output images and are billed per call, with no model check.
- The behaviour is correct (there is no `--model` to check). The prose overstates it.
- Fix: say "every command that outputs images and takes `--model`". The EN/VI table rows at `:661`/`:663` and README `:1087` already say "may use as `--model`", which is fine. Optionally also drop "their `image-to-image` forms" or make it precise: only gemini, minimax, openai, openrouter, leonardo, byteplus and atlas have one. fal, replicate, runway, sume and cloudflare do not.

### S2. The value checked is not the value sent

- `worker/src/jobs/run-option-caps.ts:121`: `model` is `.trim()`ed for the comparison, but `values` keeps the caller's untrimmed string. `run-argv-builder.ts:225` emits `--model=<raw>`.
- Failure scenario: a caller sends `model: "fal-ai/flux/schnell\n"` or `" fal-ai/flux/schnell"`. The check passes, and the CLI receives a different string from the one approved. With today's providers this only produces a provider error, or the same model if the CLI trims. It is not an exploitable bypass. It does break the invariant the rest of this file states ("Applied to the value the CLI would really use").
- Fix (pick one):
  1. Reject the mismatch: `if (raw !== raw.trim()) throw new ValidationError("--model must not have surrounding whitespace")`.
  2. Write the trimmed value back: `values.set(MODEL_OPTION, [model])` when the caller gave it.
- Add one test for whichever you choose.

## Optional

### O1. `multix_catalog` does not show the allowlist

- `worker/src/jobs/catalog-view.ts:49-93`. The catalog renders per-option `default`, `forced` and `uncapped_spend`, but nothing for the model allowlist. With `task: "image"` it also lists verified models that the server will then refuse.
- The allowlist only appears in the `multix_run` description (`job-tools.ts:93-96`). This matches how resolutions and counts are surfaced today (the catalog takes no `limits`), so it is not a regression.
- Agents will burn a call discovering the restriction. Consider a later issue to pass `limits` into `catalogPayload` and mark `model` as `allowed: [...]` on image commands.

### O2. Other price multipliers on image commands remain unbounded

- `openai generate --quality` (`high` vs `low` is roughly a 10x price difference), `leonardo generate --ultra/--alchemy/--quality`, and `gemini generate --size` / `openrouter generate --image-size` (4K tiers).
- These are outside the issue's option 1 scope, so they are not a defect of this change. The docs claim the model is the cost driver "no count or size cap bounds". Consider a follow-up issue so operators do not assume the allowlist bounds price per image.

### O3. Test gaps

- `worker/test/run-argv-builder.test.ts:796-878` covers given, default, missing, blank, exact-match and non-image commands.
- Not covered:
  - An image command without `--model` (`leonardo upscale`) still runs under an allowlist. This locks in the early return that S1 documents.
  - The REST path (`postJob`) refusing an unlisted model. It shares `prepareRun`, so this would be a cheap regression guard against someone later building limits differently in `api-router.ts`.
- Tests are not phantom: assertions check the error text and the emitted argv.

### O4. Tool description length

- `job-tools.ts:94`: the whole list is joined into the `multix_run` description. A long operator list (dozens of fal/replicate ids) inflates every `tools/list` response.
- Consider truncating after N ids with "... (see error message)", or leaving it as is.

### O5. README omits the "no known default needs `--model`" consequence

- `README.md:1087-1088`. The docs-site pages state it, but the README does not.
- Operators who read only the README will be surprised when `gemini generate` without `--model` is refused once the list is set. Add half a sentence.

## Conventions

- Conventional commit (`fix(mcp): ...`). The commit message contains no plan or finding IDs. Kebab-case files are unchanged.
- No `node:*` import was added to worker code paths.
- The wrangler var is added with an empty default and a comment, matching neighbouring vars.
- EN and VI docs are parallel. The VI text is accurate to the EN (same claims, same S1 overstatement).
- Error messages list the allowed ids. This is operator config, not a secret, so it is acceptable.

## Plan follow-up

Issue #452 option 1 is implemented as specified: comma list, empty means any model, the catalog default is used when the caller omits `--model`, `--model` is required when there is no default, exact match, and pass-through commands are excluded. Remaining before PR: fix S1 and S2, then run `npm run check:mcp` and `npm run verify:docs`.

## Unresolved questions

- Should `leonardo upscale` / `topview product-anyshoot` be called out explicitly in the docs as not covered, or does the reworded "and takes `--model`" suffice?
