# Code review: leonardo video fixed length cap (issue #456)

Commit: f158b9f (`fix(mcp): refuse leonardo video when the video length cap is below its 8 s render`), the only commit in origin/dev..HEAD.
Files: worker/src/jobs/run-option-caps.ts, worker/src/jobs/cli-command-policy.ts, worker/test/run-argv-builder.test.ts,
src/providers/elevenlabs/commands/music.ts, worker/src/cli-catalog.json, docs-site EN/VI guides/mcp-server.md (+45/-3).

## Verification run
- `cd worker && npx vitest run test/run-argv-builder.test.ts`: 73/73 pass.
- `cd worker && npx tsc --noEmit -p .`: clean.
- `npx biome check` on the touched files: clean.
- Catalog JSON change matches the new commander help text byte for byte.

## Assessment
The fix is small and correct for what it targets. `fixedSeconds` is checked in `applyCaps`, which `prepareRun` always calls, so `--no-wait`, `--wait` and `--download` all go through it. The error is a `ValidationError` with no secrets. `MULTIX_MCP_MAX_VIDEO_SECONDS` defaults to 10 with a ceiling of 15 (worker/src/config.ts:117-118), so the default setup still allows the command. Only operators who set the cap to 1-7 see the refusal. The elevenlabs help fix is accurate: nothing is sent when the flag is omitted.

No blocking defects in the diff itself.

## Findings

### 1. (optional, medium) "8 s is what a run can reach" is not verified for every v1 model
`leonardo video` sends no duration on the v1 path (src/providers/leonardo/commands/video.ts, `/generations-text-to-video` body). `LEONARDO_VIDEO_MODELS` (src/providers/leonardo/models.ts) includes v1 `KLING2_1` and `Kling2_5`. Leonardo documents both as supporting **5 or 10 seconds**, with no documented default (https://docs.leonardo.ai/docs/kling-2-1-pro.md, https://docs.leonardo.ai/docs/kling-2-5-turbo.md). `--model` is also free-form: the policy does not limit it, so any unlisted v1 id reaches the provider.
- If Leonardo's v1 default for those Kling models is 10 s, then an operator cap of 8 or 9 lets a 10 s render through. The default cap of 10 is not affected.
- Neither the policy comment nor the docs cite a source for "a v1 model picks its own length … so 8 s is what a run can reach".
- Fix options: (a) verify the v1 Kling default against the API and cite it in the comment, or (b) set `fixedSeconds: 10`, which is the documented maximum of any model the CLI lists. Option (b) refuses when the cap is below 10 and is the conservative choice.

### 2. (optional, low) Docs overstate the v2 rule
EN/VI: "a Kling, Hailuo, LTX or Seedance model always renders 8 seconds".
- "Kling" also covers the v1 `KLING2_1` / `Kling2_5` ids, which go to the v1 endpoint and do not get `duration: 8`. Say "a v2 model (kling-2.6, kling-3.0, kling-video-o-*, hailuo-2_3, ltxv-*, seedance-*)" instead.
- Leonardo lists Hailuo 2.3 recipes only at 6 s and 10 s (docs.leonardo.ai recipes index), so "always renders 8 seconds" may be false for hailuo-2_3. The provider may reject or coerce `duration: 8`. This is a pre-existing CLI issue, not caused by this commit, but the docs now assert it as fact.

### 3. (optional, follow-up issue) Same gap: `topview url-to-video` and `topview materials-to-video`
Both commands render a fixed-range length with no seconds option. `--video-length-type` takes 1 = 30-50 s (the default), 2 = 15-30 s, 3 = 30-45 s or 4 = 45-60 s (src/providers/topview/models.ts:98, commands/m2v.ts:148). Their policies (worker/src/jobs/cli-command-policy.ts, the `topview url-to-video` / `topview materials-to-video` entries) have no `caps` and no `uncappedSpend`. A comment under `topview product-anyshoot` says TopView commands are deliberately not capped.
- Every run is at least 15 s and usually 30-60 s, which is always at or above the 15 s ceiling of `MULTIX_MCP_MAX_VIDEO_SECONDS`.
- The commands are also missing from the docs' "Runs the caps cannot bound" list (mcp-server.md around lines 146-160).
- `fixedSeconds` would always refuse them, because the ceiling is 15. The cause-aligned fix is to mark them `uncappedSpend` ("the length type sets a 15-60 s video") so `MULTIX_MCP_UNCAPPED_SPEND` covers them. Per AGENTS.md this belongs in a new issue, not this PR.

Other video commands checked against the catalog, none with the same gap:
- Covered by duration caps: the gemini, minimax, openrouter, byteplus, cloudflare, fal, atlas, replicate, runway and heygen model-video commands, plus leonardo image-to-video.
- Marked `uncappedSpend`: heygen video/translate/lipsync/video-agent/template, sume video, topview video-avatar/product-avatar.
- Documented exception: gemini edit-video (bounded by the source length).
- Audio, not video: elevenlabs sfx/music.

### 4. (optional, low) Test adequacy
- The test covers v2 (`kling-2.6`), v1 (`MOTION2`) and an omitted model at cap 7, and v2 at cap 8. It does not cover the omitted or v1 model at cap 8, or a cap above 8. One extra `not.toThrow` with `{}` options at cap 8 would close the boundary on the default path.
- The model loop does not exercise model-specific behaviour, because the rule ignores `--model`. It is harmless, but it reads as if the cap depended on the model.
- There is no direct `applyCaps` unit test for `fixedSeconds` on a policy that also has `duration`. Not needed today.

### 5. (informational, pre-existing, not from this diff) Stale Sume docs
docs-site guides/mcp-server.md (around lines 199-202) says "`sume video --duration` and `--resolution` [are capped] by the video limits … without one the server sends its own default length". The `sume video` policy has no duration cap: "No duration cap: …", `caps: { resolution }` only, `uncappedSpend` set. This came from #446 and is worth a separate docs fix.

### 6. (informational) Design note
`fixedSeconds` is a plain number in `CapRules`. That fits the existing pattern, and a duration-capable command that also had `fixedSeconds` would be checked twice. No issue today. The error text "renders up to N seconds" reads well.

## Commit / workflow
- The conventional commit `fix(mcp)` publishes a patch release on merge to main. That is acceptable.
- No plan IDs in code or comments.
- Branch name `claude/relaxed-clarke-b2cs9e` does not follow the `fix/<scope>-<slug>` convention in AGENTS.md. This is cosmetic and the lead can decide.

## Unresolved questions
- What is Leonardo's v1 `/generations-text-to-video` default duration for KLING2_1 / Kling2_5 when none is sent? It decides between `fixedSeconds: 8` and `fixedSeconds: 10`.
- Does Leonardo accept `duration: 8` for hailuo-2_3, which is documented at 6 s and 10 s?
