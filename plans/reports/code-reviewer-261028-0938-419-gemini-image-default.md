# Code review: #419, Gemini image default moves to GA `gemini-3.1-flash-image`

Reviewer: isolated code-reviewer (did not write the change). Date: 2026-10-28 (UTC).
Scope: uncommitted diff against HEAD (`cc84589`, origin/dev), 15 files, +72/-36.

## Verdict

Status: DONE_WITH_CONCERNS. The diff is correct and safe to merge. The concerns are wording in the docs only. Nothing blocks the merge.

## Verification performed

| Check | Result |
|---|---|
| `npm run lint` | clean (599 files) |
| `npm run typecheck` | clean |
| `npm run build` | ok |
| Focused tests (gemini, openrouter, env-file-model-defaults) | 366 passed, 2 skipped |
| `npm test` (full) | First run: 1 failure out of 2319. Rerun: 2297 passed, 22 skipped, 0 failed. The failure looks like a timing flake under load. Its name was not captured, so the change is not proven to be unrelated, but the change touches only constants. |
| `npm run catalog` in `worker/` | Output is byte-identical to the committed `worker/src/cli-catalog.json`, so the catalog has no drift |
| `IMAGEN_MODELS` in the published entry | Not exported from `src/index.ts`. `dist/index.d.ts` and `dist/index.js` have 0 hits, so removing it does not break the public API |
| Gemini `GET /v1beta/models` (free metadata) | Listed: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`, `gemini-nano-banana-2.1`, `gemini-2.5-flash-image`, `gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`. No `imagen-*` and no `gemini-2.5-flash-image-preview`. All support `generateContent`. |
| OpenRouter `GET /api/v1/models` (public) | `google/gemini-3.1-flash-image` is listed with output modalities `["image","text"]`, as are the other three GA ids |
| Deprecations page | Matches the issue. It names `gemini-nano-banana-2.1` as the replacement for the preview, the Imagen 4 ids, and `gemini-3.1-flash-image` itself. |

## Requested checks

### 1. References to the removed `IMAGEN_MODELS` or the old ids
- `IMAGEN_MODELS` had no consumer at HEAD apart from its spread into `GEMINI_IMAGE_MODELS`. Searched `src/`, `worker/src/`, `tests/` and `scripts/`. Removing it is safe.
- `GEMINI_IMAGE_MODELS` itself has no runtime consumer. Only the new unit test reads it (see L1).
- `src/capabilities/model-registry.ts` and `src/budget/**` have no Gemini or OpenRouter image ids. `command-cost.ts` does not estimate image generation, so there is nothing to update there.
- Worker: `worker/src` does not import the gemini or openrouter image clients. Only `cli-catalog.json` carries the help strings, and it has been regenerated correctly. The gitignored `worker/dist/index.js` still shows the old OpenRouter help text. It is a local build artefact and is not tracked.
- Remaining old ids that are intentional:
  - `tests/unit/providers/openrouter/build-payload.test.ts:13,46` use `google/gemini-3.1-flash-image-preview` as sample input for `isOpenRouterModel` and `resolveModalities`. They are still valid.
  - `tests/unit/providers/gemini/video-shared.test.ts:71` uses `imagen-4.0-generate-001` as an arbitrary non-video id. This is fine.
- `IMAGE_MODEL_FALLBACK` (`gemini-2.5-flash-image`) is the default for `gemini i2i`, and the OpenRouter i2i default is `google/gemini-2.5-flash-image`. Both are still served. Google lists a 2027-03-15 shutdown for the Gemini id, which is outside this issue.

### 2. Special cases for `-preview` or Imagen that the new id would miss
- `gemini generate` always calls `generateContent` with `responseModalities: ["IMAGE"]` and `imageConfig`. Nothing routes to `generateImages` or `:predict`, so no Imagen branch exists to update. This confirms the issue's note that Imagen was never actually served.
- The only `-preview` regex is in `src/providers/gemini/commands/video-shared.ts:157`, which is the Veo deprecation warning for video. It does not apply to images.
- OpenRouter `resolveModalities` matches on an image-only prefix list (flux and similar). `google/gemini-3.1-flash-image` falls through to `["image","text"]`, which matches OpenRouter's metadata.
- `--size` / `imageSize` is not gated per model. This behaviour predates the change.

### 3. Docs accuracy
Covered in M1, L2 and L3 below. The EN and VI docs-site pages say the same thing. `.env.example`, README, `skill/SKILL.md`, the CLI help strings and the catalog all agree on the new defaults.

## Findings

### Critical
None.

### High
None.

### Medium
- **M1. The docs overstate that the preview ids are shut down.** README:262, `docs-site/.../commands/gemini.md:45-46` (EN and VI) say the `-preview` image ids "are past their shutdown date". Google's dates are the *earliest possible* shutdown dates, and both preview ids are still listed by `GET /v1beta/models` today. The code comment in `models.ts` is accurate ("past their earliest shutdown date and may stop at any time"), and the code still accepts both ids in `GEMINI_IMAGE_MODELS`, so the docs contradict the code. Suggested wording: "the `-preview` image ids are past their earliest announced shutdown date and may stop at any time." Apply it to EN and VI.

### Low
- **L1. `GEMINI_IMAGE_MODELS` is dead data, and the new set-membership tests only check a constant.** Nothing validates `--model` against the set, so `imagen-*` in `IMAGE_GEN_MODEL` or `--model` still reaches `generateContent` and fails with the upstream 404. That matches HEAD behaviour, so this is not a regression. The new tests in `tests/unit/providers/gemini/models.test.ts` are acceptable as a guard on the list, but they prove nothing about runtime behaviour. A clear `ValidationError` for `imagen-*` ids would be a separate follow-up issue, not part of this PR.
- **L2. "(cheapest)" for `gemini-3.1-flash-lite-image` is a tie.** README:262 and SKILL.md:109 call it the cheapest. On the Google pricing page, both `gemini-3.1-flash-lite-image` and `gemini-nano-banana-2.1` cost $30/1M image tokens, or $0.0336 per 1K image. Lite has a published price only for 1K, while the SKILL table shows `--size 1K|2K|4K` for every model. Suggest "1K only, lowest price" or dropping the superlative.
- **L3. "(Nano Banana 2, default, fastest)" is not backed by any source.** Lite is likely faster. Suggest dropping "fastest". It was carried over from the old preview wording.
- **L4. No test pins the new OpenRouter default through `resolveModalities`.** `build-payload.test.ts:46` still checks only the preview id. Adding `resolveModalities(DEFAULT_OPENROUTER_MODEL)` would be a one-line guard. Optional.

### Informational (decision already made in #419)
- Google lists `gemini-nano-banana-2.1` as the recommended replacement for the preview, the Imagen ids, and `gemini-3.1-flash-image` itself. It is also half the price at 1K ($0.0336 vs $0.067). The issue deliberately chose `gemini-3.1-flash-image` because it is the same model as the old default and the move keeps behaviour unchanged. That choice is sound, and this review does not reverse it. Moving to nano-banana-2.1 is a separate product decision on price and quality.
- `gemini-3.1-flash-image` also supports a 0.5K size that `IMAGE_SIZES` does not expose. This predates the change and is out of scope.

## Scope and AI-risk lens
- No scope drift. Every edited file maps to the issue's "Expected" list. Adding the three GA ids to `GEMINI_IMAGE_MODELS` goes slightly beyond the issue, but the issue's evidence names those ids, and they are verified live.
- No catch-and-swallow, `any` widening or lint suppression was introduced. The lockfile is untouched.
- The commit type should be `fix(gemini): …`, which publishes a patch release. That is appropriate: the default changes, but no breaking flag is needed because overrides still work and the old ids are still accepted.

## Recommended actions
1. Reword M1 in README and the EN and VI docs-site gemini pages.
2. Optionally tighten the L2 and L3 wording in README and SKILL.md, and add the L4 test line.
3. Ship as `fix(gemini): default image model to GA gemini-3.1-flash-image` with `Closes #419`.

## Unresolved questions
- The name of the one-off flaky test failure in the first full run was not captured. The rerun was green.
