# Code review: atlas --format enum case (commit 454e9ec vs origin/dev, issue #610)

## Scope
- src/providers/atlascloud/model-input.ts, types.ts, commands/three-d.ts
- tests/unit/providers/atlascloud/model-input.test.ts
- README.md, docs-site en+vi atlascloud.md, skill/SKILL.md
- Callers checked: generation-command.ts (buildModelInput, called twice: raw refs then uploaded URLs), run.ts (validateRawInput), three-d.ts, audio.ts, src/commands/speech/speech-adapters.ts:221. worker/src does not import model-input.ts, so check:mcp is not affected.

## Verification
- `npx vitest run tests/unit/providers/atlascloud`: 149 passed, 2 skipped
- `npx tsc --noEmit`: clean. `npx biome check` on the touched dirs: clean.

## Overall
The fix is correct and narrow. It changes case only on an exact, unique case-insensitive match against the selected field's own enum, and only in buildModelInput, so raw `run --input` payloads are still sent as written. No blocking defects.

## Regression analysis (no issues found)
- Other convenience flags (image/video/audio/speech: --resolution, --aspect-ratio, --voice, audio --format, --language) now get the same case mapping. The only visible effect: input that the enum check used to reject (e.g. `720P` against `720p`, `mp3` against `MP3`) now maps to the schema's spelling. Input that already matched exactly is unchanged (model-input.ts:170). Ambiguous enums (`mp3`/`MP3` both listed) are left alone, and the existing enum check then accepts the exact spelling.
- Non-string values: canonicalEnumValue returns early for non-strings (model-input.ts:169). Numeric enums with coerce: coerce runs first and returns a number, which is left untouched, and the enum check still compares with String(e)===String(v). Nothing changes there.
- New items.enum check (model-input.ts:200-207) uses the same lenient comparison as the scalar check, so a numeric items enum given strings (or the reverse) still passes. A previously working `run --input` is rejected only when an array item is outside items.enum (wrong case included) or the array is shorter than minItems. In both cases the provider would have rejected it anyway (that is the #610 failure mode), so this is the intended tightening.
- minItems: only applies to arrays that are present. buildModelInput skips empty request arrays (line 262), and defaults filled by finalizeAgainstSpec are not checked. The double buildModelInput call in generation-command.ts is idempotent.

## Findings (ranked)

### Medium
1. The doc examples now use lowercase, but without a schema the value is sent verbatim to the default Hunyuan model.
   README.md:718, docs-site/src/content/docs/commands/atlascloud.md:78 (and vi:78) changed `--format GLB` to `--format glb`. The example's default model is tencent/hunyuan3d-rapid, whose enum is uppercase. When the schema is unavailable (loadModelSpec returns undefined on fetch error or a model missing from the catalog, prediction-runner.ts:119-147) or `--no-validate` is passed, buildModelInput takes the no-spec branch (model-input.ts:263-269). That branch does no case mapping, so `format: "glb"` goes to Hunyuan exactly as typed. The old `GLB` example worked in that mode; the new one may not. The help text "any letter case" (three-d.ts:37) and the new docs paragraph ("you can type it in any letter case") are only true when a schema is loaded.
   Fix: either keep the example as `GLB` (correct for the default model in every mode), or qualify the claim, e.g. "any letter case when the model's schema is loaded; with --no-validate it is sent as typed".

### Low
2. A scalar sent for an array field with items.enum skips the enum check in validateRawInput (model-input.ts:195 and 201). `run --input '{"target_formats":"GLB"}'` passes client validation and the provider rejects it. This predates the change and is not a regression, but it is the same #610 class of error. Optional: when `prop.type === "array"` and v is not an array, reject with a "must be an array" error.
3. Pre-existing and out of scope: the no-spec fallback maps `--format` to `format` (candidate[0]), so `--no-validate` with a meshy-v7 model still sends the wrong field. Mention it in the PR, or open a follow-up issue as AGENTS.md asks, if anyone cares.
4. Test gaps (model-input.test.ts): no test for (a) an ambiguous enum (`["mp3","MP3"]` keeps the input), (b) a non-string or numeric enum passing through unchanged, (c) validateRawInput leaving a scalar enum case mismatch unrewritten (e.g. hunyuan `{format:"glb"}` should throw rather than be rewritten), or (d) minItems in buildModelInput. These are cheap, and they lock in the "verbatim for run --input" claim made in docs and SKILL.md.

### Docs accuracy
- The claim "`glb` for Meshy and Hi3D, `GLB` for Hunyuan3D" matches the schemas described in the task context. I did not check it against the live Atlas schemas (no network or paid calls). The en and vi paragraphs match each other. The SKILL.md sentence is accurate apart from the schema-loaded caveat in finding 1.
- The "sent verbatim" claim for `run --input` is accurate: validateRawInput only reads values (only finalizeAgainstSpec adds missing defaults), and the test at model-input.test.ts:311-313 confirms the array is left as written.
- `npm run verify:docs` was not run here (docs-site deps not installed). The author must run it because docs-site changed.

## Recommended actions
1. Resolve finding 1 (revert the example to `GLB`, or qualify "any letter case").
2. Add the four small tests in finding 4.
3. Optionally reject a scalar sent for an array-typed field in validateRawInput (finding 2).

## Unresolved questions
- Does the live meshy-v7 schema also declare minItems on image_urls? If so, a single `--ref` now fails before submit. That is correct, but it is worth a line in the PR evidence.

Status: DONE_WITH_CONCERNS
Summary: The fix is correct and causes no regressions in the other atlas adapters or in run --input, and tests, typecheck and lint pass. One medium doc/help issue: the "any letter case" claim and the lowercase `--format glb` example do not hold when no schema is loaded (--no-validate or schema fetch failure) on the default Hunyuan model.
