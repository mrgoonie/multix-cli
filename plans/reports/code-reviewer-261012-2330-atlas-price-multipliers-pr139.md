# Review: PR #139 (fix/mcp-atlas-price-multipliers @ add5802), closes #126

Reviewer: isolated code-reviewer. Read-only. The Bash tool returned no output, so `gh` could not run. Evidence comes from the GitHub REST API (`pulls/139/files`, `commits/<sha>/check-runs`), the issue page, the local worktree `agent-ad70c2463c045b3d5` (its HEAD reflog confirms add5802), and public Atlas schemas fetched with GET.

## Scope check
- 6 files changed: `worker/src/providers/atlascloud-video-policy.ts` (+104/-1), `worker/src/providers/atlascloud.ts` (+6/-1), `worker/test/fixtures/atlas-video-schemas.ts` (new, 93), `worker/test/mcp-tools.test.ts` (+199), and the EN and VI `guides/mcp-server.md` docs.
- **No `package.json` or lockfile changes** (root, worker or docs-site). The #135 revert is not present.
- CI: ubuntu Node 20 and 22, MCP Worker and Documentation site passed. Both Windows jobs were still `in_progress` when checked.

## Policy verification
- **Callers cannot set any of these fields.** `multix_generate_video` (`worker/src/mcp-server.ts:264-288`) exposes only provider, model, prompt, image_url, negative_prompt, aspect_ratio, resolution, duration and seed. zod drops unknown keys, so pinning cannot override a caller choice. None of the caller requests map onto a price field name, so there are no collisions in `buildModelInput`.
- **`audio` URL inputs are left alone.** `offValue` returns `undefined` when the field is not boolean, has no enum and has no default (`atlascloud-video-policy.ts:268-276`). I checked the real `alibaba/wan-2.5/text-to-video` and `wan-2.5/video-extend` schemas: `audio` is a string with no default ("Audio URL to guide generation"). The same model also has `generate_audio: true`, which is correctly sent as `false`. `pickField` does not route a URL onto a boolean `audio`.
- **The `*_count` pattern is safe.** `OUTPUT_COUNT_RE` (`:62-63`) is anchored and matches only `n|count|batch_size|batch_count`, `num_(outputs|videos|samples|generations|results)` and `(outputs|videos|samples|generations)_count`.
  - `frame_count`, `face_count` and `speaker_count` do not match.
  - `frame_count` is still rejected by `LENGTH_LIKE_RE` in `lengthRequests`, which runs before `priceRequests` (`atlascloud.ts:87-91`). It is never silently set to 1.
- **Tier ordering is sound.** `cheapestTier` (`:295-304`) picks from the enum only when every enum value is listed, or when the default is listed. In both cases the pick is never more expensive than the default the API would fill.
  - Placing `"default"` above `medium` in `thinking_level` is conservative. Real gemini-omni (`enum ["default","high","low"]`) sends `low`.
  - An unknown default is left alone. A free-text field with a listed default above the cheapest tier is rejected.
- **Fail-closed behaviour matches #126.** Unreadable shapes (`$ref`, `allOf`, multi-member unions) are rejected. So are a switch with no off value and an output count that cannot be 1. Readable fields with unknown values are left alone, and the docs state this.
- **A boolean with `enum: [true]`** gets `false`, then `checkConstraints` rejects it before submit. That is fail-closed with a clear message.
- **The tests are strong.**
  - Exact `toEqual` request bodies for the synthetic cases and 9 real-schema fixtures.
  - A no-POST assertion on every rejection.
  - Video-extend duration is capped and `generate_audio` is sent as false.

## Findings

### Critical
None.

### High
None.

### Medium
None in the PR's own scope.

### Low
1. **The docs overstate the count pattern.** EN `docs-site/src/content/docs/guides/mcp-server.md:208` and VI `vi/guides/mcp-server.md:211` say "`*_count` and similar … is sent as `1`". The code only matches `outputs/videos/samples/generations_count`. Elsewhere the same docs (EN :188) say `frame_count` is rejected as a length, so the two statements contradict each other. Fix: list the exact suffixes (for example "`output_count`, `video_count`, `sample_count`, `generation_count`") and drop the `*_count` wildcard.
2. **`mode` only knows `wan-std`/`wan-pro`** (`atlascloud-video-policy.ts:72`). A `mode` enum such as `std`/`pro` or `standard`/`professional` with an expensive default is left alone, so that path is not capped. The impact is limited: the Kling models I sampled split std/pro by model ID (`kling-v3.0-std`, `kling-v3.0-pro`), and none had a `mode` field. Options: add `std < pro` to the table, or accept the gap as documented.
3. **Tests do not cover the regex negatives or the `*_count` positives.** No test proves that `face_count` or `speaker_count` are left untouched, or that `video_count` or `output_count` are sent as 1. Each would be a one-line addition to the existing `it.each`.
4. **The docs' off-value list is incomplete.** They mention `"no"`/`"off"`, but the code also accepts `false`, `none` and `disabled` (`:60`). This is cosmetic.

### Informational and follow-up (outside this PR; open separate issues per AGENTS.md)
- **Unguarded 4K output.** The fixture test submits `kwaivgi/kling-video-o3-4k/text-to-video` successfully (`mcp-tools.test.ts:821`). That model has no `resolution` or `size` field and always renders 4K, so the `MULTIX_MCP_ALLOWED_RESOLUTIONS` allowlist (which excludes 4k by default) is bypassed. The same applies to `kling-v3.0-4k`. This gap predates the PR, but the new test now treats it as a pass. Only the `MULTIX_MCP_ALLOWED_MODELS` guidance in the docs covers it.
- **Price inputs that are not capped.** Vidu q3 has `bgm: true` and `movement_amplitude`. The docs already list `bgm`, `enable_prompt_expansion` and `quality` as uncapped. PixVerse `quality` (a resolution under another name) is likewise not checked against the allowlist.

## Verdict
**Approve once the Windows CI jobs pass.** The diff is correctly scoped with no package or lock changes. The policy is consistent with #126, fail-closed on unreadable shapes, and does not touch `audio` URLs or `frame_count`, `face_count` or `speaker_count`. The remaining items are documentation precision and small test additions.

## Unresolved questions
1. Pinning `thinking_level` to `low` and `motion` to `low` silently lowers quality, and operators have no way to override it. #126 left "pin vs operator allowlist" open. Does the maintainer accept pinning as the final answer?
2. Should a 4K-only model ID with no resolution field be rejected while 4k is not in the allowlist (a follow-up issue)?
