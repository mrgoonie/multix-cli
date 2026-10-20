# Code review: Gemini Omni Flash video (#254) + files.get fix (#255)

Diff: `git diff 93f328e..HEAD` (d703dcf, 747afb8, 39322da). 31 files, +4026/-212.
Reviewer did not write this code. No live API calls were made.

## Verification run
- `npm run typecheck`: clean
- `npm run lint`: clean (456 files)
- `npm run build`: ok
- `npm test`: 81 files passed, 4 skipped; 1415 tests passed, 12 skipped
- `worker: vitest run test/run-argv-builder.test.ts`: 47 passed

## Overall
The CLI side holds up: the API key only goes to `generativelanguage.googleapis.com` (`geminiFileNameFromUri` checks protocol and host, `fetchJson`/`downloadToFile` refuse or strip credentials on cross-origin redirects); interaction ids and `files/<id>` names are regex-checked before they reach a URL; `fetchJson` never retries, so the submit is sent once; key rotation wraps only upload+submit and only on 429/RESOURCE_EXHAUSTED; the session record stores `key_alias`, never the key; `--no-wait`, `video-status` and `video-cancel` send logs to stderr. The blocking problems are in the Worker policy overlay, which was not adapted to Veo or to follow-up turns.

## Blocking

### B1. Worker: `gemini generate-video` / `image-to-video` with any `veo-*` model now always fails
- `worker/src/jobs/cli-command-policy.ts:76-84` adds `VIDEO_CAPS` (duration) to both commands. `--duration` has no catalog default, so `applyCaps` (`worker/src/jobs/run-option-caps.ts:66-71`) always injects `--duration=<defaultVideoSeconds>`. The new worker test checks this (`expect(generate.argv).toContain("--duration=5")`).
- `src/providers/gemini/commands/video-shared.ts:143-144` (`veoFormat`) throws `--duration is supported for Gemini Omni models only` whenever `opts.duration !== undefined`.
- Failure: a remote `multix_run {command:"gemini generate-video", options:{model:"veo-3.0-generate-001", prompt:"..."}}` (or with `VIDEO_GEN_MODEL=veo-*`) worked before this diff and now fails validation every time. The Veo previews shut down on 2026-10-22, but `isVeoVideoModel` still accepts GA `veo-*` models, and the CLI docs still advertise them.
- Fix (pick one): (a) in the Worker, mark `model` `forced`/`unsupported` for these two commands so remote runs are Omni-only, and say so in the catalog view; (b) let `veoFormat` accept `--duration` and map it to Veo `durationSeconds` (allowed values 4/6/8) instead of rejecting it; (c) give `CapRules` a model-aware rule so the duration is injected only for `gemini-omni-*`. Add a worker test for the Veo path either way.

### B2. Worker: follow-up commands bypass `MULTIX_MCP_MAX_VIDEO_SECONDS` and `MULTIX_MCP_ALLOWED_RESOLUTIONS`
- `worker/src/jobs/cli-command-policy.ts:84-94`. `extend-video` caps only `--duration`, which is the length of the continuation. You have confirmed live that the extend output holds source + continuation, so the output (and the billed video tokens) is longer than the cap. `--interaction-id` lets a caller chain extends with no limit (10 s, 15 s, 20 s, ...), and `edit-video` of such an interaction "keeps the source length" with no duration cap at all.
- Resolution: edit/extend register `--resolution` with no default (`video-shared.ts:56-59`, `omniFormat(opts, false)` at `edit-video.ts:327`). The catalog therefore has no default, and `applyCaps` (`run-option-caps.ts:73-79`) skips the check when the option is omitted. The output then inherits the source format. A caller who uploads a 4K clip through `inputs.video`, or points `--interaction-id` at a 4K interaction made outside the Worker, gets a 4K edit/extend even though the operator allows only 480p-1080p. The test "Gemini 4k edit" covers only the explicit flag.
- Fix: in the Worker policy, (1) when `--resolution` is omitted on edit/extend, inject an allowed server default the same way `applyCaps` injects a duration (e.g. the highest of `allowedResolutions` that Omni supports); (2) for `extend-video`, either reject `interaction-id` remotely or limit `--duration` to `maxVideoSeconds - 10` (10 s is the documented upper bound for an uploaded source). Reject the command when that is below 3. Treat `edit-video --interaction-id` the same way, or document it as an operator-accepted gap. Fix the policy comment "an edit keeps the source length, so only the resolution is capped": with no flag, the resolution is not capped either.

## Optional (non-blocking, recommended)

### O1. Interaction id can be lost after a billed submit if the session record cannot be written (Medium)
- `src/providers/gemini/omni-flow.ts:288-306`: `writeRecord(recordPath, record)` runs before the id is logged or returned. If `getOutputDir()` cannot be written (ENOSPC, EACCES, read-only mount), it throws after the interaction was accepted. The user never sees the id, and a retry bills a second video.
- Fix: log `Interaction ID: <id>` (stderr in `--no-wait`) before writing the record, and wrap `writeRecord` in try/catch so a failure warns and the run continues.

### O2. `submitError` messages invite a double submit on 5xx (Medium)
- `omni-flow.ts:187-206`: every non-zero `HttpError`, including 500/502/503/504 from the submit, becomes "Gemini Omni request rejected (HTTP 5xx)". A gateway 502/504 can arrive after Google accepted the background interaction. The status-0 wording ("may already be generating and billed") fits these cases better. The status-0 branch also catches network failures from `buildMediaParts` uploads, where nothing was billed, so that message is wrong there. The doc comment "quota errors stay HttpErrors" does not match the code: a 429 is wrapped into a `ProviderError` too.
- Fix: use the "may already be running, check AI Studio before resubmitting" text for 500/502/503/504. Upload separately from `createInteraction` (or tag the stage) so an upload failure is reported as such. Make the comment and the 429 handling agree.

### O3. `findInteractionKey` stops early or reports the wrong reason (Low-Medium)
- `omni-flow.ts:169-183`: only 403/404/429 move on to the next key. An invalid or expired `GEMINI_API_KEY` returns 400 `API_KEY_INVALID`, which throws at once, so an interaction owned by `GEMINI_API_KEY_2` cannot be found by `video-status`, `video-cancel`, edit or extend. A 429 on the owning key is reported as "not found ... may have expired", which sends the user toward re-generating.
- Fix: also skip 400 bodies that contain `API_KEY_INVALID` and 401. When any key returned 429, say "rate-limited, retry later" instead of "not found".

### O4. Session record shows `in_progress` when the download fails after completion (Low)
- `omni-flow.ts:324-338`: `record.status`/`usage` change in memory, but `writeRecord` runs only after `saveOmniVideo` succeeds. A download failure (file `FAILED`, size cap, network) leaves the stale status on disk.
- Fix: write the record before `saveOmniVideo`, and write it again with `error` in a catch.

### O5. `--no-wait` JSON always reports `status: "in_progress"` (Low)
- `src/providers/gemini/commands/generate-video.ts:119-125`: the status is hard-coded. The submit response may say `queued` (or already be terminal). Pass `interaction.status` through `runOmniVideo`'s result. `--output` is also ignored without a warning when `--no-wait` is set (`omni-flow.ts:309-312`).

### O6. Worker: Omni resolution default not visible to the cap (Low)
- `generate-video`/`image-to-video` dropped the catalog default (`1080p` before; now the CLI default lives inside `omniFormat`). An operator with `MULTIX_MCP_ALLOWED_RESOLUTIONS=480p` gets 720p Omni videos (and 1080p Veo), because `applyCaps` finds no default to check. Fix: inject a server-chosen allowed resolution when it is omitted, as for B2.

### O7. `unwrapFile` throws a TypeError on an empty body (Low)
- `src/providers/gemini/client.ts:225-226`: `fetchJson` returns `undefined` for an empty 2xx body, and `"file" in undefined` throws a TypeError instead of the intended `ProviderError`. Guard with `resp && typeof resp === "object"`.

### O8. `mediaFileName` ignores the host (Low, display only)
- `src/providers/gemini/omni.ts:288-291` matches `/v1beta/files/...` on any host, so a foreign URI shows up as a Gemini `media_file` in `video-status` JSON. Reuse `geminiFileNameFromUri` from `client.ts`.

## Checked, no issue found
- Key leakage: `saveOmniVideo` sends `x-goog-api-key` only to `fileDownloadUrl(fileName)`, which is built from a regex-checked name. A foreign https URI is fetched without headers, and a non-https one is refused.
- Path traversal: `INTERACTION_ID_RE` / `FILE_NAME_RE` are applied in `getInteraction`, `cancelInteraction`, `getFile` and `fileDownloadUrl`. URL normalisation removes `..` before the pathname regex runs.
- Billing: `fetchJson` has no retry. `withGeminiKey` rotates only on quota errors. Follow-ups run on the parent's key with no rotation. A poll timeout keeps the id, writes the record and prints a resume hint.
- Live-verified API facts (task dropped with `previous_interaction_id`, `store:false` means inline delivery with no id) are implemented as described and were not re-litigated.
- TTS/speech: not touched. Veo request building (`veo.ts`) is not changed. The CLI-side Veo regression is limited to stricter aspect-ratio validation (16:9 and 9:16, which matches Veo).
- Runtime neutrality: `omni.ts` and `client.ts` have no `node:*` imports.

## Unresolved questions
- Does Google bill the full extend output (source + continuation) or only the continuation? B2's billing impact depends on it; the length cap bypass applies either way.
- Is Veo still meant to be reachable through the Worker after 2026-10-22? This decides between fix options (a) and (b)/(c) for B1.

## Resolution (author, commit a296eae)

- **B1, fixed:** `gemini generate-video` and `gemini image-to-video` force `--model gemini-omni-1.1-flash` on the remote runner. Veo leaves the Gemini API on 2026-10-22.
- **B2, resolution, fixed:** a new `fillResolution` cap sends an allowed resolution (720p when permitted) whenever the caller leaves it out. This applies to generate, image-to-video, edit and extend.
- **B2, length, not changed. The evidence was a live run on 2026-10-20 at 360p:**
  - A 3 s clip extended by 3 s came back 6 s long. It reported `total_output_tokens` 5793, the same as a fresh 3 s generation, and the source was counted as input tokens (5046).
  - Each job is therefore billed only for the seconds it generates, and `--duration` caps those seconds.
  - Chaining extends means separate jobs, each capped. That spend bound is the same as running generate repeatedly.
  - An edit has no `--duration`, so its length is the source's. Google caps an uploaded source at 10 s and a chain at 40 s.
- **O1, fixed:** the id is logged before the session record is written, and a failed write only warns.
- **O2, fixed:** a 5xx response now carries the "may already be billed" warning, the wording reads "request failed", and the comment is corrected.
- **O7, fixed:** `unwrapFile` guards against an empty or non-object body.
- **O3–O6 and O8, not changed:** each is a minor message or display difference with no wrong output or extra spend.
  - The O3 400 `API_KEY_INVALID` case shows up in `multix check`.
  - For O5, the status after `--no-wait` really is `in_progress`.
