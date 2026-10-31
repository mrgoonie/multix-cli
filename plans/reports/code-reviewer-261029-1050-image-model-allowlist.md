# Code review: 76472f4 image model allowlist for multix_run (#452)

Reviewed only 76472f4 (HEAD, on top of the PR #453 branch). No files modified except this report.

## Verification run
- `npm run check:mcp`: 27 test files, 501 tests passed; worker typecheck and bundle check clean.
- `biome check` on touched TS files: clean.
- Probe script (prepareRun with `MULTIX_MCP_ALLOWED_IMAGE_MODELS=fal-ai/flux/schnell,gpt-image-2`) and a full catalog enumeration of runnable commands, their capability outputs and model-like options/positionals.

## What is correct (verified)
- Both entry points go through the check: MCP `multix_run` (worker/src/jobs/job-tools.ts:210) and REST `postJob` (worker/src/api/job-api-handlers.ts:180) both call `prepareRun`, which calls `assertAllowedImageModel` (run-argv-builder.ts:207).
- Plumbing: `serverSettings` copies the var (config.ts:109); `limitsFrom` parses it with `csv()` (config.ts:177). `toolEnvFor` spreads user keys over settings (accounts/account-store.ts:218), but saved keys are restricted to `PROVIDER_SECRET_NAMES`, so a user cannot override the allowlist.
- Coverage of "image" outputs: every runnable command that outputs images and takes `--model` is gated, including all `image-to-image` edit commands (gemini, minimax, openai, openrouter, leonardo, byteplus, atlas). No image-producing command with a model option lacks "image" in outputs. `leonardo upscale` / `leonardo variation` take no model.
- No alternative model selector on gated commands: no `--model-id`, model positional or `--provider` on any image command; positionals go after `--`, so `args: ["--model=x"]` cannot inject a flag.
- Container env cannot change the default: the job env is PATH/HOME/MULTIX_* plus provider keys only (worker/container/job-runner.mjs:142-150); env model overrides (`FAL_IMAGE_MODEL`, `GEMINI_IMAGE_GEN_MODEL`, `LEONARDO_DEFAULT_MODEL`, `ATLASCLOUD_IMAGE_MODEL`, ...) cannot be set by a caller, and inputs land under `in/`, so no cwd `.env` can be planted. Catalog defaults (`fal image` = fal-ai/flux/schnell, `openai *` = gpt-image-2) match what the CLI uses in that clean env.
- No forced `model` on any image command (forced model exists only on gemini video commands).
- Fail-closed on near misses (whitespace, case): `GPT-IMAGE-2` refused.

## Findings

### Medium 1: allowlist is a flat namespace across providers; the same id runs at a different provider and price tier
`assertAllowedImageModel` matches the bare id regardless of command (run-option-caps.ts:122-123). Leonardo accepts GPT Image ids (`src/providers/leonardo/models.ts:79`, `startsWith("gpt-image-")`) and its `quality` defaults to `HIGH` and is not a price option, while `openai generate` defaults to `medium`.
Failing input (allowlist `fal-ai/flux/schnell,gpt-image-2`, the example in wrangler.jsonc and the test):
`{command:"leonardo generate", args:["cat"], options:{model:"gpt-image-2"}}` -> accepted, argv `leonardo generate --model=gpt-image-2 -- cat` (HIGH quality on Leonardo).
An operator who listed `gpt-image-2` meaning OpenAI medium also admits a different provider at a higher tier. Fix: accept `<group>:<model>` entries (same shape as the model catalog's `provider:model` offerings) and match `${group}:${model}` first; or document that ids are matched across every provider. At minimum add a test and a doc sentence.

### Medium 2: generic pass-through commands bypass the allowlist and the docs do not say so
`fal run`, `atlas run`, `replicate run`, `heygen run` take the model as a positional and outputs `[]`, so `isImageModelCommand` is false. They are marked uncapped, so in `budget` mode a `max_cost_usd` bounds them; in `allow` mode they run any model.
Failing input (`MULTIX_MCP_UNCAPPED_SPEND=allow` + allowlist set): `{command:"fal run", args:["fal-ai/flux-pro/v1.1-ultra"]}` -> accepted.
This is consistent with the chosen design, but README.md and both mcp-server.md guides describe the allowlist as bounding image model choice without saying the run commands are outside it. Add: "The `run` pass-through commands are not covered; they are governed by `MULTIX_MCP_UNCAPPED_SPEND` (`budget`/`deny` keep them bounded)." Optionally, when the allowlist is set, treat a pass-through whose positional model is not listed as uncapped even in `allow` mode, or refuse it.

### Low 3: tool description joins model ids with "/", which model ids themselves contain
job-tools.ts:182 renders `image models ${allowedImageModels.join("/")}` -> `image models fal-ai/flux/schnell/gpt-image-2`. A caller cannot tell where one id ends. Use `", "` (resolutions can stay "/").

### Low 4: README summary omits the no-default rule
README.md (new lines ~1033-1035) says "given or as the catalog default" but not that commands without a catalog default (gemini, minimax, openrouter, leonardo, byteplus, cloudflare, atlas, replicate, runway image commands: most of them) require the caller to pass a listed `--model`. With the allowlist set, a bare `gemini generate` is refused; operators should know that before enabling it. The docs-site table (EN+VI) does state it.

### Low 5: tests
The new test (worker/test/run-argv-builder.test.ts:771-823) asserts real behavior (given/default/near miss/no default/non-image/unset). Gaps: no case for the cross-provider id (Finding 1), no REST `postJob` case (shared path, so low risk), no assertion on the tool description text.

### Informational
- `multix_model_catalog` / `multix_catalog` still recommend offerings outside the allowlist; callers learn only on refusal. Acceptable given the description lists the models.
- Video commands (`fal video --model`, `atlas video`, `replicate video`, ...) have the same model-sets-price problem; out of scope for #452, consider a follow-up issue.
- `run-option-caps.ts:2` header still says "the same limits the Worker's own image and video tools enforce"; the Worker no longer has such tools (only multix_* and skills). Pre-existing wording.
- Docs claim "`cloudflare generate --steps` ... is not bounded": verified, `cloudflare generate` has no priceOptions.

## Recommended actions
1. Decide on provider scoping (Finding 1): support `group:model` entries or document the flat match; add a test with `leonardo generate --model gpt-image-2`.
2. Document that pass-through `run` commands are outside the allowlist (README + EN/VI guides).
3. Change the description separator to ", ".
4. Add the no-default sentence to README.

Status: DONE_WITH_CONCERNS
