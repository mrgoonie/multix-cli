# Code review: extend-video cap docs (#258)

Commit: 2856122 on `claude/gracious-heisenberg-yrmq6j` ("docs(worker): state that the video cap bounds each Gemini extend, not a chain").
Files: `worker/src/jobs/cli-command-policy.ts` (comment only), `docs-site/src/content/docs/guides/mcp-server.md`, `docs-site/src/content/docs/vi/guides/mcp-server.md`, `README.md`. About 30 lines added, no code changed.
The reviewer did not write this change. No live API calls were made.

## Checks run
- `npx biome check worker/src/jobs/cli-command-policy.ts`: clean
- `worker: vitest run test/run-argv-builder.test.ts`: 47/47 passed. Covers "Gemini extension too long" (duration 30 rejected) and the `--duration=5` injection.
- `verify:docs` was not run. The change is prose in an existing section, with no links and no frontmatter changes.

## Fact check

| Claim | Verdict | Evidence |
|---|---|---|
| `extend-video --duration` is capped like any other duration | True | `cli-command-policy.ts` applies `OMNI_VIDEO_CAPS` (`duration: ["duration"]`) to extend. `run-option-caps.ts` `applyCaps` rejects a value above `maxVideoSeconds`. When the option is omitted, it sends `defaultVideoSeconds`, because `--duration` has no catalog default (`video-shared.ts` `addVideoFormatOptions`). |
| `--duration` is the length of the new continuation | True (live evidence, not provable from code) | The code only sends `response_format.duration = "<n>s"` (`omni.ts` `buildOmniRequest`). The author's live run is recorded in `plans/reports/code-reviewer-261020-1041-gemini-omni-video.md`, Resolution: 3 s + 3 s extend gave 6 s output, and output tokens equalled a fresh 3 s generation. This agrees with `docs-site/.../commands/gemini.md` ("3 s clip extended by 3 s"). |
| The returned video also contains the source | True | Same live evidence. README line 217 and gemini.md say the same. |
| `edit-video` has no `--duration` and keeps the source length | True | `edit-video.ts`: `addVideoFormatOptions(cmd, { duration: spec.task === "extend", ... })`. `omniFormat(opts, false)` leaves the format unset, so the server keeps the source's format and length. |
| Chaining via `--interaction-id` grows the clip | True | `previous_interaction_id` is passed through (`buildOmniRequest`). The worker places no limit on `interaction-id`: it is not in `fileOptions`, `urlOptions` or `caps`. |
| The server cannot see a stored interaction's length | Mostly true, slightly overstated | The Worker/runner never calls Google before the job runs. The container CLI *could* `GET` the interaction with the caller's key, but the resource has no duration field (see the `Interaction` type in `omni.ts`). The length would have to be inferred from usage tokens or by probing the file. "Does not know" is fair; "cannot see" is a little strong. Acceptable as written. |
| Every call is billed to your own Gemini key | True | `worker/src/api/api-router.ts:247` and `worker/src/index.ts:89` call `accounts.providerKeys(account.id)`, which returns per-account decrypted secrets (`account-store.ts:186`). `job-runner.ts` `jobEnv` passes only `GROUP_KEYS[group]`, and for Gemini that is `GEMINI_API_KEY`. No operator key or fallback exists. `findInteractionKey` iterates only the keys in the job env, i.e. the caller's own. |
| Policy comment: "an extend is billed for the new continuation only" | Pre-existing; supported by the live run | The source is counted as input tokens (5046 in that run). Input is still billed, at the lower rate (`OMNI_PRICE_PER_M_TOKENS.input` = 1.5/M). "Only" is slightly loose but this line is not in this diff. |

No false claims were found.

## Vietnamese text
The text is accurate and follows the English closely. Its terminology matches the rest of the page ("bị giới hạn", "interaction đã lưu", "clip nguồn"). Two small fluency issues:
- "mỗi lần extend tiếp một interaction đã lưu (`--interaction-id`) clip lại dài thêm": a comma is missing between the condition and the result, so it reads as a run-on. Suggested: "mỗi lần extend tiếp một interaction đã lưu (`--interaction-id`), clip lại dài thêm".
- "mọi lần gọi đều tính phí vào key Gemini của chính bạn": understandable but a bit colloquial. Smoother: "mọi lần gọi đều được tính phí trên key Gemini của chính bạn".
- Optional: "Server không biết độ dài" could be "Server không xem được độ dài", which is closer to "cannot see". "Không biết" also works.

## Decision: is document-only (option 1) sound?
Yes, given the threat model in the code:
- **Who pays:** the caller pays on their own key (verified above). The operator carries no provider cost, so the cap protects the caller from per-call blast radius. It is not an operator budget.
- **The gap is bounded:** Google caps an uploaded source at 10 s and an extend chain at 40 s total (gemini.md: "up to 40 seconds in total"; author's Resolution note). The worst single call is an `edit-video` of a 40 s chain: up to 40 s of output, about 4x the default cap of 10. Each extend generates at most `cap` new seconds. Repeating calls is already bounded by the per-account job quota and the rate limiter, the same as repeating `generate-video`.
- **Excluding extend-video** removes a working feature to close a gap the caller can reach anyway by running calls one after another.
- **Capping chains** needs either state in a stateless runner, or a pre-flight Google lookup that cannot read a length directly. That is a lot of complexity for a cost the caller pays.
- **No real bypass that needs code:** no path spends operator credentials or goes past Google's 40 s ceiling. Resolution is already enforced on edit/extend through `fillResolution`. The remaining gap is a documented policy limitation, not a security defect.

## Findings

### Critical / High
None.

### Medium
- **M1. The docs do not give the ceiling, so the gap reads as unbounded.** EN and VI say the server "does not bound a chain" but omit Google's 40 s limit, which is the real bound and the main reason option 1 is acceptable. Suggested addition to the EN paragraph: "Google limits a chain to 40 s in total, so an edit of a stored interaction can return up to 40 s." Add the VI equivalent, for example: "Google giới hạn cả chuỗi ở 40 giây, nên một lần edit interaction đã lưu có thể trả về tới 40 giây." Mirror it in the policy comment if wanted.

### Low
- **L1. The env table is not qualified.** `mcp-server.md:416` (and VI :411) still describe `MULTIX_MCP_MAX_VIDEO_SECONDS` as "Maximum video duration" with no qualification. Consider "Maximum video duration per call (see Gemini edit and extend)".
- **L2. README covers extend only.** README:787-789 mentions only extend chains. `edit-video` of a chained clip is the larger single-call case. Optional: add "or an edit of one".
- **L3. Help text pre-dates this diff and is not in scope.** The `--duration` help for `extend-video` says "video length" (`video-shared.ts` `addVideoFormatOptions`), but for extend it is the continuation length. Consider a separate small fix so the CLI help matches the new docs.
- **L4. Model claim pre-dates this diff and is not in scope.** The guide says "the Gemini video commands always use Gemini Omni Flash", but `edit-video` and `extend-video` have no `forced: OMNI_MODEL`. A caller can pass any `gemini-omni-*` model (`isOmniVideoModel` is a prefix match). This is harmless today with one Omni model. Open an issue if a pricier Omni tier ships.

## Scope and commit hygiene
- The diff matches the stated scope (comment plus EN/VI guide plus README). There is no scope drift and no plan IDs in the code comments.
- Commit type `docs(worker)` publishes a release according to the release-please config. That is acceptable for user-facing docs.
- `Closes #258` is present. The issue claim comment by this session exists and is the only claim seen.

## Recommended actions
1. (Optional, Medium) Add the 40 s Google ceiling to the EN and VI paragraphs.
2. (Low) Apply the two Vietnamese fluency fixes.
3. (Low) Qualify the env-table row as "per call".
4. Track L3 and L4 separately if wanted; they should not widen this PR.

## Unresolved questions
- Is the 40 s chain ceiling from Google's docs or the live run? gemini.md states it without a source link.

Status: DONE_WITH_CONCERNS
Summary: Every factual claim checks out against source or the recorded live evidence, the Vietnamese is accurate with minor fluency nits, and document-only is the right call given caller-owned keys and Google's 40 s ceiling; no code-level bypass remains.
Concerns/Blockers: Non-blocking. The docs omit the 40 s ceiling that bounds the gap; there are two VI phrasing nits; the env table still says "Maximum video duration" with no qualification.
