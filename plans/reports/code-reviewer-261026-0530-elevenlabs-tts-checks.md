# Code review: elevenlabs tts checks (#314)

Commit 8162ebc on `claude/gracious-heisenberg-1j3nv7`. 11 files, +322/-36.

## Verification run
- `npx vitest run tests/unit/providers/elevenlabs`: 50 passed, 6 skipped (live)
- `npm run lint`: clean. `npm run typecheck`: clean.
- `worker`: `vitest run test/cli-catalog.test.ts`: 6 passed (catalog matches CLI)
- `tts-request.ts` / `models.ts`: no `node:*` imports (only `core/errors.js`, `./models.js`).
- ElevenLabs controls guide re-read: "Eleven v4 and Eleven v3 do not support SSML break tags";
  "Phoneme tags are only compatible with the eleven_flash_v2 model"; v4 reads IPA in slashes. Caps table matches.

## Assessment
Scope matches the issue; no blockers. Clone-strength gating, the voice-ID check (which also stops a `--voice ..`
from normalizing the URL to `/v1/`), code-point counting, and both SSML warnings behave as the issue and live facts say.
Docs (README, EN/VI docs-site, SKILL.md) and worker catalog are updated. The findings below are low/medium.

## Findings
1. Medium - tests/unit/providers/elevenlabs/live.test.ts:83-89. The loop sends clone_strength to every model without the
   cap, but only eleven_v3, eleven_multilingual_v2 and eleven_flash_v2_5 were verified. If eleven_v3_conversational,
   eleven_flash_v2, eleven_turbo_v2(_5) accept the field, the call synthesizes and bills, which contradicts the "Unbilled" comment (line 80).
   An unrelated 4xx (for example, v3_conversational not served on this endpoint) also fails it. Fix: limit the loop to the three verified ids,
   or assert the status before audio is produced and change the comment.
2. Low - tests/unit/providers/elevenlabs/tts-request.test.ts:159. The describe name "checks carried over from the duplicate v4 implementation"
   refers to process history, not behavior (stable-artifact rule). Rename it, for example "buildTtsRequest: clone strength, length, SSML and language checks".
3. Low - src/providers/elevenlabs/commands/tts.ts:120-125. A JSON body of `null` makes `timings.audio_base64` throw inside the try block.
   The command then reports "was not JSON" and saves it as `.bin`. Fix: `if (!timings || typeof timings !== "object" || !timings.audio_base64)`.
   Also, if `saveBytes` itself throws (disk full or permissions), its error replaces the provider error. Optional: wrap it and keep the original message.
4. Low - tts.ts:140. `timings?.audio_base64 ?? ""` is dead defensive code: the problem branch always throws. A narrowed local
   (`const audio = timings.audio_base64`) would keep the type guarantee instead.
5. Low - tts-request.ts:69 comment, README.md:41, both docs-site pages. "An emoji is one character" is true only for single-code-point
   emoji. Skin-tone and ZWJ sequences count 2 to 7 code points (verified: "👍🏽👨‍👩‍👧" = 7 code points). The billing probe covered simple emoji only.
   Fix: say "counted in Unicode code points" and drop the emoji claim, or qualify it.
6. Low - tts-request.ts:164. The IPA hint is gated on `model.startsWith("eleven_v4")`, so it also shows on eleven_v4_turbo. The guide
   documents slash-IPA for `eleven_v4` only. Fix: `model === "eleven_v4"`, or verify Turbo first.
7. Info - tts-request.ts:112-118. `--clone-strength 0` is rejected on non-v4 models although the probe used 0.5. Rejecting is consistent
   with "never silently drop" and the error is value-independent in all likelihood; no change needed.
8. Info - docs-site/src/content/docs/vi/commands/elevenlabs.md:94. Unwrapped long line, unlike the surrounding prose. Cosmetic.

## Edge cases checked (no issue)
- Default voice `kdmDKE6EkgrWrrykO9Qt` passes VOICE_ID. The check runs before the key lookup and the request (test asserts 0 requests).
- Over-limit "higher" model list uses code points consistently.
- Unknown `--model`: clone_strength and SSML pass through unchecked, as the existing unknown-model warning promises.
- The character-cost header is printed on both the success path and the failure path. `--json` usage still comes from usage-extract headers.

Status: DONE_WITH_CONCERNS
