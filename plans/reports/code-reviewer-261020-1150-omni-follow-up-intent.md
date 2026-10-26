# Code review: Omni follow-up intent prefix and extend --video aspect-ratio guard (#257)

Commit: 8498717 on claude/gracious-heisenberg-vkzzvb (base origin/main). 9 files, +122/-7.
REVIEW.md: not present. No paid API calls made.

## Verification run
- `npm run lint`: clean (456 files)
- `npm run typecheck`: clean
- `npm run build`: ok
- `npx vitest run tests/unit/providers/gemini tests/smoke/cli.test.ts`: 13 files, 244 tests passed
- Probed `followUpPrompt` directly (esbuild bundle of src/providers/gemini/omni.ts):

| input | task | output |
|---|---|---|
| `""` | edit | `"Edit this video: "` |
| `"   "` | extend | `"Extend this video: "` |
| `"Extend this video: x"` | edit | `"Edit this video: Extend this video: x"` |
| `"Edit this videogame style"` | edit | unchanged (false "already prefixed") |
| `"\n Edit this video: x  "` | edit | unchanged, including whitespace |
| `"Extend the video: x"` | extend | `"Extend this video: Extend the video: x"` |

## Blocking
None.

## Non-blocking

1. **A blank prompt now becomes a paid request.** `src/providers/gemini/omni.ts:172-179`, `src/providers/gemini/commands/edit-video.ts:44`.
   `--prompt ""` (or whitespace) passes commander's `requiredOption`. Before this change the API received an empty input. Now it receives `"Edit this video: "`, a valid instruction with no content, so a billed edit/extend with no direction can run (about $0.10/s). Scenario: an agent or remote MCP caller templates an empty variable into `--prompt`. Fix: in `registerFollowUp`, reject `!opts.prompt.trim()` with a ValidationError (for extend, decide on purpose whether a bare "Extend this video:" is allowed).

2. **The other task's prefix is not detected, so the sent prompt contradicts itself.** `omni.ts:174-176`.
   `edit-video --interaction-id X --prompt "Extend this video: ..."` sends `"Edit this video: Extend this video: ..."`. That brings back the guessing the fix was meant to remove, and the user is not told. Fix: detect either prefix and throw (or warn) when it does not match `spec.task`.

3. **The session record does not hold the prompt that was sent.** `src/providers/gemini/omni-flow.ts:227` stores `r.prompt` (the raw user text), while the API received the prefixed text. `task` is still recorded, so this is only a debugging and reproducibility gap: re-running from the record gives the same request, but someone comparing it with Google-side logs will see different input. Either record `sent_prompt` when it differs or note the prefix in a comment. Low.

4. **The prefix match is loose.** `omni.ts:175`. `startsWith("edit this video")` with no word boundary also matches "Edit this videogame…", which is then left without a prefix. This is harmless in practice. Matching `/^(edit|extend) this video\b/i` would be stricter. Low.

5. **One claim in a code comment and the commit message is not backed by the evidence supplied.** `omni.ts:159-165` and the commit body say an unprefixed edit-video "the ball falls off the table" came back as a 10 s extension. The evidence I was given shows only the extend-as-edit case and "Edit this video: the ball falls off the table" staying 3 s (prefixed). If the unprefixed edit run happened, it is fine. If not, keep only the extend example in the comment. The docs (EN/VI) cite only the extend case, which is supported.

6. **Test gaps.** These are not wrong, just thin.
   - Nothing pins that `edit-video --video ... --aspect-ratio` and `extend-video --interaction-id ... --aspect-ratio` are still accepted. A later change that widens the guard would go unnoticed. One smoke or unit assertion each would cover it.
   - The smoke test at `tests/smoke/cli.test.ts:195` asserts the message on a missing file. That proves the guard runs before file checks and uploads, which is good.
   - There is no unit test for whitespace or blank prompts (see 1).

7. **Docs paragraph structure differs between EN and VI.** `docs-site/src/content/docs/commands/gemini.md:101-109`. In EN, "Only a completed interaction can be continued…" now sits on the line right after the new intent paragraph, so the two run together as one paragraph. In VI that sentence stays in the first paragraph and the intent paragraph comes after the expiry note. The content of the two languages matches. Add a blank line in EN before "Only a completed…" so both have the same structure. Cosmetic.

8. **Unknown: extend via `--interaction-id` plus `--aspect-ratio`.** No `task` field is sent there, so the API's 400 for task extend may not fire, but a changed aspect ratio on a continuation may be ignored or rejected. The guard correctly does not cover it, since it was not observed. Consider checking it in the next live session and documenting the result.

## Compatibility (worker / container)
- `worker/src/jobs/cli-command-policy.ts:99-106`: the job spec shape is unchanged and no CLI options were added or renamed, so the generated catalog is unaffected. A new container accepts every argv the live Worker sends.
- The only behaviour change for remote callers: `extend-video` with `--video` and `--aspect-ratio` now fails locally with a ValidationError instead of failing at the API with HTTP 400. It fails earlier, after the input download and before the Files API upload and any billing. The Worker never adds `--aspect-ratio` itself (`fillResolution` only fills resolution), so no server-built argv hits the guard.
- Rolling back the Worker or the container in either direction is safe.

## Correctness checks that passed
- The prefix is applied only when `previousInteractionId` is set (`omni.ts:195`). Uploaded `--video` turns still send `generation_config.video_config.task` with the raw prompt, and first turns are unchanged (covered by a unit test).
- Prefixing works with reference images: the media parts come first and the prefixed text part last (unit test).
- `--aspect-ratio` has no default in follow-up mode (`video-shared.ts:56-59`, `omniFormat(opts, false)`), so the guard fires only on an explicit flag.
- The i2v doc claim matches the code: `image-to-video.ts:67` sends `[imagePath, lastFrame]` in that order.
- README, SKILL.md and both docs-site pages describe the prefix and the aspect-ratio refusal accurately.

## Recommended actions
1. Reject blank `--prompt` in edit-video/extend-video (item 1).
2. Detect a mismatched intent prefix and warn or fail (item 2).
3. Optional: record the sent prompt, tighten the prefix regex, add the two "still allowed" tests, fix the EN paragraph break, and confirm the claim in the code comment.

Status: DONE_WITH_CONCERNS
Summary: The fix is correct, minimal and well covered for the main path. Lint, typecheck, build and 244 Gemini/smoke tests pass, and the Worker/container are compatible in both directions. Nothing blocks.
Concerns/Blockers: A blank or whitespace prompt now produces a billable "Edit this video: " request. A prompt that starts with the other task's phrase gets two contradictory prefixes. The comment's claim about an unprefixed edit coming back as an extension is not in the supplied live evidence.

## Resolution (author)

- 1, 2, 4, 6, 7: fixed in d3b0d74 (empty prompt refused; either "Edit/Extend this video" phrase with a word boundary is left as is; tests for blank prompt and for `edit-video --video --aspect-ratio`; EN paragraph break).
- 3: kept. The session record stores the user's prompt plus the task, which is enough to reconstruct what was sent.
- 5: backed by a live run the reviewer did not see: the unprefixed prompt "The ball falls off the edge of the table." sent with `previous_interaction_id` and no task (what edit-video sent before the fix) returned 13 s, i.e. a 10 s extension. The code comment now quotes that exact prompt.
- 8: checked live after the review: `extend-video --interaction-id <16:9 source> --aspect-ratio 9:16 --resolution 360p` succeeded and returned a 13 s 360x640 video, so the aspect-ratio guard stays limited to `--video`.
