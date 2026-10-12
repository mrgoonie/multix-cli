# Code review: PR #69 feat(heygen): add HeyGen v3 provider (closes #56)

- Branch: `feat/heygen-provider` (commits `eaef4bc`, `bc23204`), reviewed from `origin/main...HEAD`
- Worktree: `D:\www\oss\multix-cli\.claude\worktrees\agent-a845c1cb7d77a7a37` (not modified; checks ran on a `git archive` copy in the session scratchpad)
- Scope: 50 files, about 5,400 added lines. 19 files are in `src/providers/heygen/**` and 9 are tests. The rest are docs and shared registration files.

## Verification run

| Check | Result |
|---|---|
| `npm run lint` (biome) | clean, 233 files |
| `npm run typecheck` | clean |
| `npm run build` | ok |
| `npx vitest run` | 47 files passed, 1 skipped (the live smoke test); 476 tests passed, 6 skipped |
| Probes (temporary test, since deleted) | `client.getVideo(" ")` and `getVideo(undefined)` throw **synchronously**. `summarizeState` redacts `output_url` to `https://cdn/x.mp4?[redacted]`. The webhook verifier accepts upper-case hex and rejects a `sha256=` prefix. |

I checked these against developers.heygen.com using WebFetch:
- The webhook `signature` header is the hex HMAC-SHA256 of the raw body.
- `POST /v3/templates/{id}` returns `data.id`, not `video_id`, so the code is correct here.
- `POST /v3/assets`: multipart field `file`, 32 MB limit, Idempotency-Key supported.
- `POST /v3/video-agents`: no Idempotency-Key, and `video_id` is nullable at creation.
- `POST /v3/videos` (avatar): the body fields match the docs. The response is `data.video_id`.
- `GET /v3/videos/{id}`: statuses are `pending|processing|completed|failed`. `captioned_video_url` is "the video file with captions burned in".
- Translation: the create, get and languages paths and fields match. Statuses are `pending|running|completed|failed`.
- Lipsync get: matches, including `caption_url`.
- Speech: matches, with no Idempotency-Key. 502 and 504 are documented as safe to retry.
- Model video: matches. Statuses include `cancelled`, and there is a **combined reference cap of 12**.

## Critical

None found.

## High

### H1. `--burn-captions` downloads the video without captions
- **Where:** `src/providers/heygen/jobs.ts:445` (`outputUrl: str(video.video_url) ?? str(video.captioned_video_url)`). The flag is wired at `request-builders.ts:246-251` and `commands/video.ts:102`.
- **Failure scenario:** `multix heygen video "..." --avatar L --burn-captions` sends `caption.style: "default"`. HeyGen documents `captioned_video_url` as "the video file with captions burned in" and `video_url` as the plain file. The CLI always prefers `video_url`, so the user pays for burned captions and gets a file with no captions. No test covers this; the mock fixtures only return `video_url`.
- **Fix:** Carry the caption intent into the state. When `--burn-captions` was requested, prefer `captioned_video_url` over `video_url`, at least in `video` (pass a flag to `completeJobs`/`videoState`). The `--json` output should report both URLs. Add a command test whose fixture returns both URLs.

### H2. A failed download deletes the user's existing file at `--output`
- **Where:** `src/providers/heygen/node-helpers.ts:188-191`. It calls `downloadFile(url, dest)`, and on any error runs `fs.rmSync(dest, { force: true })`.
- **Failure scenario:** `final.mp4` was downloaded successfully earlier. Later the user runs `multix heygen status v1 --download --output ./final.mp4`. The signed URL has expired, so the CDN returns 403. `downloadFile` throws before it opens the write stream (`core/http-client.ts:51-52`), yet `rmSync` still deletes the good `final.mp4`. Network errors cause the same data loss. Docs line 195-196 tells users to re-run `status ... --download` exactly in this situation, which makes the scenario likely.
- **Fix:** Download to `${dest}.part` (or a temp file in the same directory), `fs.renameSync` it to `dest` on success, and on failure remove only the `.part` file. Add a test that creates an existing file, makes the download return 403, and asserts the file is still there.

## Medium

### M1. The ID getters throw synchronously, and the test hides it
- **Where:** `src/providers/heygen/client.ts:81-85` (`seg`). It is used in the non-`async` methods `getVideoAgentSession` (220), `getVideo` (239), `generateFromTemplate` (248), `getModelVideo` (265), `getVideoTranslation` (299) and `getLipsync` (318). The masking test is `tests/unit/providers/heygen/client.test.ts:53` (`expect(async () => c.getVideo(" ")).rejects`).
- **Failure scenario:**
  - The methods are typed `Promise<T>`, but an empty or whitespace ID throws a `ValidationError` synchronously, and `undefined` throws a raw `TypeError` from `id.trim()`.
  - A Worker caller that writes `client.getVideo(id).catch(handle)` or `Promise.allSettled(ids.map(id => client.getVideo(id)))` gets an uncaught exception. That breaks the "runtime-neutral client" contract the module header promises.
  - Inside the CLI, the async reader wrapper in `jobs.ts:584` hides the problem, so no test fails.
  - The test wraps the call in an `async` arrow, so it would pass whether or not the method throws synchronously.
- **Fix:**
  - Mark these methods `async`, or move `seg` inside `request`, so every failure becomes a rejection.
  - Accept `unknown` and reject non-strings with a `ValidationError`.
  - Change the test to `await expect(c.getVideo(" ")).rejects.toThrow(ValidationError)`. That form fails if the method throws synchronously.

### M2. Create responses are not validated before polling paid jobs
- **Where:** `commands/translate.ts:102` (`created.video_translation_ids`), `video.ts:131`, `lipsync.ts:83`, `model-video.ts:89`, `video-agent.ts:76`, `template.ts:53`. `node-helpers.ts:334` checks only `ids.length === 0`.
- **Failure scenario:** If HeyGen returns a 2xx `data` without the expected ID field (a schema drift, or a 202 that carries `status` only), the paid job has already been created. Then either:
  - `completeJobs(..., undefined)` crashes on `ids.length` with a `TypeError`, or
  - `[undefined]` is polled and fails with `video undefined: Cannot read properties of undefined (reading 'trim')`.

  Either way the user gets no job ID to resume or cancel. `heygen run` already does this correctly through `extractJobIds` (`run.ts:29-38`).
- **Fix:** Validate in the client, which should throw a `ProviderError` that includes the redacted response keys when the documented ID field is missing or not a string. Alternatively, route every command through the `extractJobIds`-style check. `completeJobs` should also reject any falsy ID.

### M3. The Video Agent session is never re-read once a `video_id` is seen, so the session-failure branches never run in practice
- **Where:** `src/providers/heygen/jobs.ts:595` (`if (!agentSession?.video_id) agentSession = await client.getVideoAgentSession(id)`), together with the branches at `jobs.ts:516` and `jobs.ts:528`. The phantom test is `tests/unit/providers/heygen/jobs.test.ts:132`.
- **Failure scenario:** After the first poll that returns a `video_id`, the session object is frozen. Suppose the session later becomes `failed` (for example `paid_tier_quota_exceeded`), but its video stays `pending`/`processing`. The CLI then polls `GET /v3/videos/{id}` until the 30-minute timeout instead of failing fast with the session error. The `waiting_for_input` hint at line 528 depends on the stale cached status, so it almost never fires either. The test at `jobs.test.ts:132` calls `agentState()` directly with a failed session, so it passes even though the reader never produces that input.
- **Fix:** Keep re-reading the session while the video is not done, at a lower frequency if you want to save requests (for example every third poll). Alternatively, remove the unreachable branches and document that the video status is authoritative. Add a reader-level test: the session flips to `failed` after the video is assigned, and the wait must end with that failure.

### M4. The webhook verifier is documented as an export, but npm consumers cannot reach it
- **Where:** `src/providers/heygen/webhook.ts`. `tsup.config.ts` builds only `entry: ["src/cli.ts"]`, and nothing in `src/` imports `webhook.ts`, so it is not in `dist/`. `package.json` `exports["."]` points at `./dist/index.js`, which the build never produces (that part predates this PR). The claims are in `docs-site/src/content/docs/commands/heygen.md:203-205` and VI `vi/commands/heygen.md:197`.
- **Failure scenario:** A user follows the docs and runs `import { verifyHeygenWebhookSignature } from "@mrgoonie/multix"`. It fails because the module is not shipped, so the HMAC code (which is correct) is dead in the published package.
- **Fix:** Either add a real library entry (`src/index.ts` that re-exports the runtime-neutral HeyGen client, jobs and webhook, plus a tsup entry and `.d.ts`), or reword both doc pages to say it is source-level only. Note that the review of the verifier itself found it correct: it uses Web Crypto HMAC, a constant-time XOR compare after a length check, the raw-body `string | Uint8Array | ArrayBuffer` input, case-insensitive hex, and `false` for an empty secret or empty signature.

### M5. `--no-download --json` prints only a redacted, unusable output URL
- **Where:** `src/providers/heygen/node-helpers.ts:255-259` (the URL is printed only when `!opts.json`), and `summarizeState` at `node-helpers.ts:235`, which redacts `output_url`.
- **Failure scenario:** An agent runs `multix heygen video ... --no-download --json`, which the docs describe at `heygen.md:182`: "prints the output URL instead of downloading it". It receives `"output_url": "https://...mp4?[redacted]"` and cannot fetch the file. `heygen tts --no-download --json` does print the full URL (`tts.ts:63-64`), so the behaviour is inconsistent. The URL is only recoverable through `status --raw`.
- **Fix:** When `download === false` and the user asked for JSON, emit the unredacted `output_url` (and `caption_url`), as `tts` does. Printing the URL is the explicit purpose of that flag. Keep redaction for logs and errors.

### M6. One failed download stops the remaining deliveries and drops the collected job failures
- **Where:** `src/providers/heygen/node-helpers.ts:253-264` (sequential `await downloadOutput` with no catch) and `379-383`.
- **Failure scenario:** `translate` runs into 5 languages. Language 1's download fails (for example a transient CDN 5xx or an expired URL). This causes three problems:
  - Languages 2 to 5 completed but are never downloaded.
  - `printFinished` is skipped, so the `--json` summary is lost.
  - Any per-language job failures in `failures[]` are discarded, because the download `ValidationError` propagates first.

  The user sees one download error and none of the other results.
- **Fix:** Catch each state's download error and push it into `failures`. Continue with the other states, always print the summary, then throw the aggregate `HeygenJobFailedError`. Extend the test at `commands.test.ts:286` to cover a download failure.

### M7. Documentation contradicts the polling cadence
- **Where:** `heygen.md:224-225` ("HeyGen recommends polling every 10-30 s, which the default backoff respects"), VI `vi/commands/heygen.md:218-219`, and the code defaults at `node-helpers.ts:144` and `340` (`5000`).
- **Failure scenario:** The first poll comes after about 4-6 s (5 s with jitter) for every job. Translation into N languages starts N parallel pollers (`node-helpers.ts:345`). With 20 languages that is roughly 4 requests per second at the start, which goes against the pay-as-you-go limit of about 10 concurrent workflows that the same docs quote. The 429 retry exists, but the doc statement is false.
- **Fix:** Raise the default `--poll-interval` to 10000 (and update `addWaitOptions`, the `status` default and both doc pages), or correct the sentence in EN and VI. Consider staggering the parallel pollers.

## Low

- **L1. `HEYGEN_BASE_URL` does not have to be HTTPS.** At `node-helpers.ts:45`, a value such as `http://...` (for example from a stale or legacy `.env`, now that #70 loads `.claude` env files) sends `X-Api-Key` in cleartext. Fix: require `https://` unless the host is loopback.
- **L2. `downloadOutput` accepts `http://` output URLs.** At `node-helpers.ts:185`, a downgraded or MITM'd URL is fetched and written to disk without complaint. HeyGen output URLs are presigned HTTPS. Fix: require `https:`. The SSRF surface is otherwise acceptable: URLs come only from the authenticated API response, and `X-Api-Key` is not sent to the CDN (`core/http-client.ts:42` sends no headers).
- **L3. `seg()` does not reject the dot segments `.` and `..`.** At `client.ts:81-85`, `encodeURIComponent("..")` returns `..`, and WHATWG URL normalisation turns `/v3/videos/..` into `/v3/`. The result is `GET` requests with the key to unintended paths on the same origin. The impact is low because the origin is the same. Fix: reject IDs equal to `.` or `..` or containing `/`, or match them against `^[A-Za-z0-9_.:-]+$`.
- **L4. The combined model-video reference cap of 12 is not enforced.** In `request-builders.ts:382-392`, 9 images + 3 videos + 3 audio files pass local validation. The CLI uploads all 15 files before HeyGen rejects the request. Fix: add `refImages + refVideos + refAudio <= 12`.
- **L5. A non-JSON 2xx upload response throws a raw `SyntaxError`.** At `client.ts:360`, `uploadAsset` calls `await response.json()` with no try/catch, so the error is unbranded. Fix: wrap it in a `ProviderError`.
- **L6. One request can overrun `--wait-timeout` by up to 120 s.** In `jobs.ts:621-627` and `client.ts:101`, `pollUntil` passes `remainingMs`, but the reader ignores it and uses the fixed 120 s client timeout. Fix: thread `remainingMs` into the per-request timeout.
- **L7. With several outputs, `--output` is silently turned into a directory.** At `node-helpers.ts:215-218`, `--output out.mp4` with 3 translation languages creates a directory named `out.mp4/`. Fix: reject an `--output` that has a media extension when `count > 1`, or warn.
- **L8. Job IDs in `resumeCommand` are printed unquoted.** At `jobs.ts:644-646`, the IDs come from the API and are interpolated into a command line meant for copy-paste. Fix: shell-quote any ID that is not `[A-Za-z0-9_-]`.

## Verified as acceptable

- **Webhook HMAC:** the compare is timing-safe, the raw body is used, there is no re-serialisation, and malformed or missing signatures return `false`. HeyGen does not document a timestamp or replay protection, so its absence here is not a defect.
- **Upload limits:** the size is checked with `fs.statSync` before the file is read (`node-helpers.ts:72`) and checked again on the blob (`client.ts:331`). The extension allowlist matches the documented types.
- **Retries:**
  - GETs are not retried inside `send` (polling handles them).
  - POST 5xx and network errors are retried only when an Idempotency-Key is sent. The key is reused across attempts, and `request_in_progress` 409 is retried.
  - 429 with `Retry-After` is retried for every operation, `quota_exceeded` excluded, and the wait is capped at 60 s. HeyGen rejects a 429 before processing, so the retry is safe.
- **Key leakage:** the key appears only in the `X-Api-Key` header. `HttpError` redacts URL query strings, and `HeygenApiError` builds its message from the code, message and param only. No logger call prints the key, a signed URL or a prompt. `status --raw` deliberately prints signed URLs and is labelled as such.
- **Output paths:** API-derived names go through `safeSlug` or a `[^\w.-]` replace, and extensions come from an allowlist (`OUTPUT_EXTS`). I found no path traversal from API data. `--output` is under the user's control by design.
- **Exit codes:** every thrown error reaches `src/cli.ts:22-25`, which exits with code 1. Failed, cancelled, `waiting_for_input` and timed-out jobs all throw. A pending `status` without `--wait` exits 0, as documented.
- **Live test gating:** the live smoke test requires `MULTIX_LIVE_TESTS=1` plus the key, and it calls only read-only endpoints.

## Test quality

- **Strengths:**
  - The unit tests drive the real command registration against a fake fetch (`fake-heygen.ts`).
  - Failure paths are covered: 402, a failed render, a partial translation failure, and an expired-URL download.
  - There is a runtime-neutral import check.
- **Phantom or masking tests:**
  - `client.test.ts:53` (see M1).
  - `jobs.test.ts:132` exercises a state the reader can never produce (see M3).
- **Missing tests:** burned-caption URL selection (H1), keeping an existing `--output` file when a download fails (H2), `--no-download --json` (M5), create responses without IDs (M2), a download failure in a multi-job delivery (M6), the 12-reference cap (L4).

## Documentation (EN and VI)

- The EN and VI pages have the same headings and code blocks. The diff shows only translated headings, so they are in sync.
- Both languages share the inaccuracies described in M4 (webhook export), M5 (`--no-download` "prints the output URL" under `--json`) and M7 (polling cadence).
- `heygen.md:81-83` says "A subtitle file is always produced when captions are requested". HeyGen documents that the SRT sidecar is always returned. The difference is minor, but `--captions` on `video` also adds a `caption` object to the request (`video.ts:62`), and the docs do not mention that.

## Likely merge conflicts with the other open PRs

| File | Conflicting PRs | Why |
|---|---|---|
| `src/cli.ts:16` (description string) | #67, #68 | The same single line is edited by each PR. Conflict is certain. |
| `src/commands/check.ts:70` (`PROVIDERS` tail after fal.ai) | #67, #68 (#65, #70 also edit this file) | Each PR adds an entry at the same anchor. |
| `src/commands/check-helpers/setup-hints.ts` (after the fal.ai line) | #67, #68 | Same anchor. |
| `src/commands/index.ts` (the `@@ -30` register block after `registerFalCommands`) | #67, #68 | The registration lines are inserted at the same anchor. The import lines are at different positions and will probably merge cleanly. |
| `.env.example` (after `FAL_KEY`, and at the end of the file) | #65, #67, #68, #70 | Every PR edits the key block or appends at the end of the file. |
| `docs-site/astro.config.mjs` (sidebar after fal.ai) | #67, #68 | Same anchor. |
| `docs-site/src/content/docs/{,vi/}commands.md`, `{,vi/}commands/providers.md` (table row after fal.ai) | #67, #68 | Same anchor. |
| `docs-site/src/content/docs/{,vi/}reference/environment.md` (key table and the override paragraph) | #65, #67, #68, #70 | The paragraph is one reflowed block, so this is the conflict most likely to be resolved badly. |
| `docs-site/src/content/docs/{,vi/}reference/for-ai-agents.md` | #67, #68 | Same anchor. |
| `docs-site/src/pages/llms.txt.ts` | none of #65/#67/#68/#70 | The whole file is one string literal, so any later provider PR will conflict on the entire line. fal.ai is missing from this list on `main` already; that predates this PR. |
| `docs-site/tests/site-output.test.mjs` | #67 | Same area. |
| `tests/smoke/cli.test.ts`, `tests/smoke/parse-args.test.ts` | #67, #68 | Each PR appends cases. |
| `package.json` (description and keywords), `README.md`, `skill/SKILL.md` (single-line `description:` frontmatter) | #67, #68 (README and SKILL also #65, #70) | Single-line descriptions guarantee conflicts. |

Note: #67 adds `.enablePositionalOptions()` to the root program. HeyGen subcommands define no option that this would shadow, so the change does not affect them.

## Recommended actions (in order)

1. H2: download to a temp file and rename, so a failed download never deletes an existing `--output` file.
2. H1: select `captioned_video_url` when `--burn-captions` is set, and add a test.
3. M2 and M1: validate the job IDs returned by create calls, make the ID getters reject asynchronously, and fix the masking test.
4. M6: aggregate download failures and always print the summary.
5. M3: re-read the agent session while the video is pending, or remove the dead branches and the phantom test.
6. M5: print the full URL for `--no-download --json`.
7. M4 and M7: fix the EN and VI docs, or ship a library entry for the webhook verifier.
8. Merge order: land one provider PR first (for example #67), then rebase #68 and #69 against it. The shared anchor rows will need manual resolution.

## Unresolved questions

- Does HeyGen change `video_url` itself when `caption.style` is set? The public docs describe only `captioned_video_url` as burned, so H1 assumes `video_url` stays clean. A single live run would settle it.
- Can a Video Agent session fail after its `video_id` has been assigned while that video stays non-terminal? The docs describe a reserved video that becomes `failed` for `waiting_for_input`, which would end the wait. Other session errors are not described, so M3 could not be confirmed against the live API.
- Is a library export of the runtime-neutral client and webhook verifier in scope for #56, or only the CLI? This decides whether M4 is fixed in code or in the docs.

Status: DONE_WITH_CONCERNS
Summary: Lint, typecheck, build and tests all pass, and the endpoint paths and fields match the HeyGen v3 docs. However, two High defects should block merge. `--burn-captions` downloads the video without captions, and a failed download deletes an existing `--output` file. Seven Medium issues need fixes before merge: synchronous ID-getter throws hidden by a test, unvalidated create IDs, a stale agent session, an unshipped webhook export, the `--no-download --json` URL, aborted multi-job delivery, and docs that contradict the polling cadence.
