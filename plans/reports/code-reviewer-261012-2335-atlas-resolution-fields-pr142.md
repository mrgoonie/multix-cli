# Code review: PR #142 (closes #140), Atlas resolution fields in the MCP Worker spend guard

- Head: `2becdcd` (`fix/mcp-atlas-resolution-fields`), base `80c3a31`.
- Files: `worker/src/providers/atlascloud-video-policy.ts`, `worker/test/mcp-tools.test.ts`, `worker/test/fixtures/atlas-video-schemas.ts`, `docs-site/src/content/docs/guides/mcp-server.md`, `docs-site/src/content/docs/vi/guides/mcp-server.md`.
- CI at `2becdcd`: all 6 check runs pass (Node 20/22 on ubuntu and windows, Documentation site, MCP Worker).
- Local commands were not run because the Bash tool returned no output. The review is by reading code at the PR head and the PR diff.

## Verified correct

- **Normalisation matches the allowlist.** The allowlist is trimmed and lower-cased (`worker/src/config.ts:90`). The caller's resolution is lower-cased (`worker/src/mcp-server.ts:300`). `normaliseResolution` (`atlascloud-video-policy.ts:399-406`) trims, lower-cases, and turns bare 3-4 digit strings and positive integers into `Np`. So `"1080P"`→`1080p`, `"2K"`→`2k`, `"4K"`→`4k`, `1080`→`1080p` and `"1080"`→`1080p` all match the default list. Non-integers, zero, negative numbers and objects become `undefined` and are rejected. Upscale tiers such as `4k-sr` and `1080p-esr` stay unmatched and are rejected.
- **Every rejection happens before the POST.** `assertVideoBodyWithinLimits` runs after `buildModelInput` and before `atlas.submit` (`worker/src/providers/atlascloud.ts:87-93`). The ID check runs inside the same function, so its order relative to #139's `priceRequests` does not matter.
- **ID regex** (`:67`). The lookbehind/lookahead on `/ _ -` rejects `2.4k`, `4kids` and `ultra4k`, and accepts `-4k/`, `-1080p/` and `_4k`. `matchAll` clones the global regex, so no `lastIndex` state is shared between requests. Lookbehind is supported in V8/Workers.
- **No key leak.** Messages contain only the model ID, the schema value and the allowlist. The new rejection tests assert `not.toContain(ATLAS_KEY)` (`mcp-tools.test.ts:1090, 1167`).
- **Test discipline.** Every new rejection case asserts no POST (`mcp-tools.test.ts:1091, 1138, 1168`). Accept cases assert the exact submitted body. The non-resolution `quality` test proves `quality: high` is left alone (`:763-765`). The PixVerse fixture test uses the real catalog shape with a narrowed allowlist.
- **EN and VI docs are consistent** in content and structure (EN `:128, 191-221, 242-244`; VI `:127, 194-224, 246-247`).

## Critical

None.

## High

None.

## Medium

**M1. Integer or bare-digit `quality` values are not detected, so `quality` is skipped entirely (fails open).** `atlascloud-video-policy.ts:61, 425`
`qualityIsResolution` tests only strings against `RESOLUTION_VALUE_RE`, which requires a `p`/`k` suffix. The same PR teaches `normaliseResolution` that `1080` and `"1080"` mean `1080p`, and it applies that to `output_resolution`, but `quality` never gets that far.
Scenario: a schema with `quality: { type: "integer", enum: [720, 1080, 2160], default: 2160 }` (or string `"2160"`). `qualityIsResolution` returns false, `quality` is not added to `resolutionFields`, and Atlas fills 2160 and bills 4K under the default allowlist. The docs (EN `:197`) say "An integer such as `1080` is read as `1080p`", which a reader will assume covers `quality` too.
Fix: in `qualityIsResolution`, also accept integers ≥ 240 and `/^\d{3,4}$/` strings, for example by testing `normaliseResolution(v)` against `/^\d{3,4}p$|^\d{1,2}k$/`. No sampled model has this shape yet, so this is a gap, not a live exploit.

**M2. A `quality` defined only through `$ref`, `allOf` or a nested union is not detected (fails open), contrary to the docs' fail-closed claim.** `atlascloud-video-policy.ts:413-426`
`qualityIsResolution` reads `default`/`enum` from the property and its first-level `anyOf`/`oneOf` members only. Per-property `$ref` is not resolved by `parseModelSpec` (only the top-level `$ref` is).
Scenario: `quality: { $ref: "#/components/schemas/Quality" }`, or `quality: { allOf: [{ enum: ["720p","4k"], default: "4k" }] }`. No resolution-looking value is found, so `effective()` is never called for `quality`, and the unreadable shape is silently accepted. For `resolution`, the same shape is rejected (tests `:610-619`). The docs (EN `:208-210`, VI `:212-214`) say that a schema shape that cannot be read is rejected.
Fix: when `quality` (raw or a union member) has `$ref`/`allOf`, or nested unions, treat it as a resolution field so that `effective()` rejects it. Accept the false positive on a non-resolution `quality` behind a `$ref`. Otherwise, document the exception.

## Low

**L1. `4k`≡`2160p` and `2k`≡`1440p` are not treated as equal, which causes false rejections.** `atlascloud-video-policy.ts:399-406, 498-505`
`maxBox` (`:390`) treats `4k` as 2160 and `2k` as 1440, and the tool's zod regex accepts `2160p`. But the field and ID checks compare strings exactly.
Scenario: an operator sets `MULTIX_MCP_ALLOWED_RESOLUTIONS=720p,2160p`. Then `kwaivgi/kling-v3.0-4k/...` is rejected ("renders at 4k"), and `quality: "4K"` is rejected. This fails closed, but it is confusing. A related regression: an allowlist entry written without a `p` (`1080`) used to match a schema string `"1080"`. Now the value normalises to `1080p` and never matches.
Fix: canonicalise both sides (`2160p`→`4k`, `1440p`→`2k`, bare digits→`Np`) in `limitsFrom` and in `normaliseResolution`. Or document that `4k`/`2k` must be written in that form.

**L2. `bgm` is pinned off, which reverses the decision recorded on the issue.** `atlascloud-video-policy.ts:77`, docs EN `:218-221`
The #140 owner comment says Vidu `bgm` "remains an uncapped price input, documented as a limitation rather than fixed". The PR sends `bgm: false` instead. That is a user-visible change: Vidu videos silently lose background music, and there is no tool argument to turn it back on. The PR body explains the reasoning openly, so this is not a silent change. Still, the maintainer should confirm the reversal on the issue before merge, per the user-decision rule.

**L3. A mixed `quality` enum causes a false rejection.** `atlascloud-video-policy.ts:425, 486-493`
Scenario: `quality: { enum: ["standard", "1080p"], default: "standard" }`. One enum value looks like a resolution, so `quality` is checked. `"standard"` does not normalise into the allowlist, so the call is rejected with "would render at standard". This fails closed and is theoretical, but the message is misleading.
Fix: when the effective value is not resolution-shaped, skip it if the property also has non-resolution enum values. Alternatively, accept the trade-off and note it in the docs.

**L4. The docs understate what counts as a resolution.** EN `:196`, VI `:199-200`
They say "(`360p` to `1080p`, `2k`, `4k`)", but `RESOLUTION_VALUE_RE` and `ID_RESOLUTION_RE` accept any `\d{3,4}p` / `\d{1,2}k` (`2160p`, `8k`, `1k`, `24k`). An ID token such as `-1k` or `-16k` is therefore rejected under the default list. Fix: say "any `NNNp`/`NNNNp` or `Nk`/`NNk` value".

**L5. A test name is now stale.** `mcp-tools.test.ts:573`
"a non-string resolution default" (`resolution: integer 2160`) still passes, but now because `2160p` is not allowlisted, not because the value is non-string. No test covers an integer `resolution` (not `output_resolution`) inside the allowlist. Rename the case and add `resolution: { type: "integer", default: 1080 }` to the accept table.

**L6. Resolution field names come from a closed list.** `atlascloud-video-policy.ts:58`
`video_resolution`, `upscale_resolution` and `output_quality` are not covered. This is not a regression, and #140 scoped the fields explicitly. As a follow-up issue, consider failing closed on any field matching `/resolution/i`, in the same way as `LENGTH_LIKE_RE`.

## Plan and acceptance follow-ups

- #140 asks for `quality` (when it looks like a resolution), `output_resolution` and `target_resolution` to be checked. Done, except for the M1 and M2 gaps.
- #140 asks for models whose ID names a fixed resolution to be rejected. Done for IDs; the "or schema" half is not applicable.
- #140 asks for mocked-fetch tests that assert no POST on a rejection. Done.
- `bgm`: the PR goes beyond the recorded decision (L2); this needs the maintainer's acknowledgement.

## Verdict

**Approve with follow-ups.** There are no blocking defects. All new paths fail closed except the two `quality`-detection gaps (M1, M2). No sampled live schema has those shapes, so they can ship as a fast follow-up or be fixed in this PR with small changes. Before merge, get the maintainer to acknowledge the `bgm` reversal (L2).

## Unresolved questions

- Does the maintainer accept pinning `bgm` off, which reverses the limitation-only decision on #140?
- Should the allowlist canonicalise `4k`/`2160p` (L1), or should the docs require the `4k`/`2k` spelling?
