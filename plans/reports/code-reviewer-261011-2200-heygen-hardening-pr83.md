# Code review: PR #83 `fix/heygen-hardening` (closes #77)

- Head: `041e03e` (single commit). Base: `103e00f` (origin/main with HeyGen provider).
- Reviewed from the PR worktree `D:\www\oss\multix-cli\.claude\worktrees\agent-ab652d1eecc5dc954` (HEAD verified = PR head). Base code compared against an untouched base worktree copy, and the hunk list was taken from the GitHub `.diff`.
- Bash tool was non-functional in this session (no output from any command), so lint, typecheck, and tests were **not run locally**. GitHub check-runs for `041e03e` all show success: CI on Node 20/22 for ubuntu and windows, plus the Documentation site.

## Scope

| File | Change |
|---|---|
| `src/providers/heygen/request-builders.ts` | +`isHttpsUrl`, `LOOPBACK_HOSTS`, `checkBaseUrl` |
| `src/providers/heygen/node-helpers.ts` | base URL check, https-only `downloadOutput`, thumbnail skip, `outputPathFor` template, stagger wiring |
| `src/providers/heygen/jobs.ts` | `startDelayMs`, `staggerOffsetMs`, async `waitForJob` |
| tests: `commands.test.ts`, `jobs.test.ts`, `request-builders.test.ts` | +182 lines, fake fetch only |
| docs: README, `skill/SKILL.md`, EN/VI `commands/heygen.md`, EN/VI `reference/environment.md` | behaviour docs |

## Verdict

**Approve with minor follow-ups.** All five items in #77 are implemented, and the acceptance criteria are met: unit tests use a fake fetch for items 1 to 3, and the EN and VI docs are updated. I found no Critical or High defects. The findings below are hardening gaps and edge cases. None of them makes the change unsafe to merge.

## Requirement check vs #77

| # | Requirement | Status |
|---|---|---|
| 1 | `HEYGEN_BASE_URL` https-only except loopback, `ConfigError` naming the variable, no key | Done. `request-builders.ts:85-100`, `node-helpers.ts:53-60`. Runs before any request (test `commands.test.ts:535`). |
| 2 | Refuse non-https output URLs, redacted error | Done for video, caption, tts, and `run` audio. All of them go through `downloadOutput` (`node-helpers.ts:209-213`). A non-https thumbnail is skipped with a warning instead of refused, which is reasonable because a thumbnail is optional. `captioned_video_url` is covered because it becomes `outputUrl` (`jobs.ts:73`). |
| 3 | `--output dub.mp4` for multi-output | Done as a name template (`node-helpers.ts:241-258`) and documented in the EN and VI docs, README, and SKILL.md. |
| 4 | Stagger pollers (optional) | Done: 500 ms per job, capped at 5 s and at half the timeout (`jobs.ts:273-300`, `node-helpers.ts:432`). |
| 5 | `--captions` docs (optional) | Done in EN and VI. Verified against `request-builders.ts:280`, which adds the `caption` object when `captions \|\| burnCaptions`. |

## URL validation probe (by reading WHATWG URL semantics against `checkBaseUrl`)

| Input | Result | Note |
|---|---|---|
| `http://localhost.evil.com` | rejected | hostname is not in the set (tested at `request-builders.test.ts:81`) |
| `HTTP://LOCALHOST:8787` | accepted | the parser lowercases the scheme and host; correct |
| `http://[::1]:9000`, `http://[0:0:0:0:0:0:0:1]` | accepted | `URL.hostname` keeps the brackets and is normalised to `[::1]` |
| `http://127.1`, `http://2130706433` | accepted | normalised to `127.0.0.1`. This is still loopback, so it is acceptable |
| `http://[::ffff:127.0.0.1]`, `http://127.0.0.2`, `http://localhost.` | rejected | conservative; fine |
| `http://user:pass@evil.com` | rejected; the message uses `redactUrl`, whose `origin` drops the userinfo, so no credential is echoed | OK |
| `https://user:pass@host` | accepted. Node fetch then throws, and the resulting `HttpError` message is redacted | harmless |
| `ftp:`, `file:`, `javascript:` | rejected | `file:` is echoed as `file:[redacted]` |

The provider client stays free of `node:*` imports. `checkBaseUrl` and `isHttpsUrl` live in the runtime-neutral `request-builders.ts`, and `jobs.ts` uses only the global `setTimeout`. This complies with AGENTS.md.

## Critical

None.

## High

None.

## Medium

### M1. A redirect can bypass the https-only download guarantee
- Location: `node-helpers.ts:209-216` and `core/http-client.ts:44`. `downloadFile` calls `fetch` with the default `redirect: "follow"`.
- Failure scenario: HeyGen, or a compromised or misconfigured CDN behind it, returns `https://cdn/x.mp4`, which answers `302 Location: http://…`. Node's undici follows https to http redirects because there is no mixed-content blocking. The video is then fetched in cleartext and written to disk, although the docs now say "Outputs, caption files, and thumbnails are only downloaded from `https://` URLs" (EN `heygen.md:213`, VI `:205`). The thumbnail path (`video-thumb.ts:86`) has the same gap.
- Impact: integrity (MITM content substitution) more than confidentiality, because the signed query string is not re-sent unless the `Location` copies it. The probability is low, but the documented guarantee is overstated.
- Fix: after `fetch`, reject when the final URL is not https before streaming the body. For example, add an optional `requireHttps` flag to `downloadFile`:
  ```ts
  if (opts?.requireHttps && response.url && new URL(response.url).protocol !== "https:") {
    await response.body?.cancel();
    throw new HttpError(0, "redirected to a non-https URL", url);
  }
  ```
  Alternatively, soften the docs to "the URL returned by HeyGen must be https". Add one fake-fetch test that returns a `Response` whose `url` is http.

### M2. The name template can silently overwrite one output with another
- Location: `node-helpers.ts:251-254`. The suffix is `safeSlug(state.outputLanguage ?? state.id)` alone.
- Failure scenario: two jobs produce the same slug. Examples:
  - The language names differ only in punctuation or non-ASCII characters, which `safeSlug` collapses to `-`.
  - The names are longer than 40 characters and share a prefix.
  - The names differ only by case on a case-insensitive filesystem (Windows or macOS). `splitLanguages` deduplicates exactly, so `Spanish,spanish` survives, and HeyGen may echo both back as `Spanish`.

  The second `renameSync` then replaces the first file. Both jobs log `Saved …/dub-Spanish.mp4` and exit 0, so a paid output is lost without any signal. The default naming does not have this problem because it always includes the job ID (`defaultOutputPath`, `node-helpers.ts:230-233`).
- Fix: track the destinations already used in `deliverOutputs`. Pass a `Set<string>` (compared case-insensitively on win32 and darwin) into `deliverOne` or `outputPathFor`, and on a collision append `-${safeSlug(state.id)}`. Add a test with two translations that both report `output_language: "Spanish"`.

## Low

### L1. Caption file can overwrite the video when `--output` uses a subtitle extension
- Location: `node-helpers.ts:175` (`OUTPUT_EXTS` includes `srt` and `vtt`), the template at `:251`, and the caption path at `:322-325`.
- Failure scenario: `translate --languages A,B --output subs.srt --captions`. The video is saved as `subs-A.srt`, and the caption path becomes `subs-A.srt` as well, so it replaces the video. The single-output case `--output x.srt --captions` already had this problem; the PR now documents `.srt` and `.vtt` as valid template extensions (EN `heygen.md:127`, VI `:122`).
- Fix: if `capDest === dest`, use `${base}.captions.${capExt}`. Or restrict the template extensions to video and audio, and drop `srt` and `vtt` from the docs list.

### L2. A trailing separator or an existing directory with a media-like name is now treated as a file template
- Location: `node-helpers.ts:248-251`. `path.resolve` strips the trailing `/` or `\`, so `--output renders.mp4/` or an existing directory `D:\out\final.mov` is treated as a template.
- In the same function, one language with `--output outdir` (no extension) writes a file called `outdir` with no extension. The same flag value therefore means "directory" for N > 1 jobs and "file" for N = 1. This is a pre-existing inconsistency, but the new help text ("any other path is a directory", `node-helpers.ts:167`) makes it more visible to scripts that pass a variable `--languages`.
- Fix: before the extension check, if `output` ends with a path separator or `fs.statSync(target).isDirectory()`, use directory semantics regardless of `count`. Optionally do the same for `count <= 1`.

### L3. The timeout message reports the reduced budget, not the user's `--wait-timeout`
- Location: `jobs.ts:296` passes `timeoutMs: poll.timeoutMs - delay`, and `pollUntil` prints `Timed out after ${opts.timeoutMs}ms`.
- Scenario: `--wait-timeout 60000` on job #4 prints "Timed out after 58000ms". This is cosmetic and could confuse the user.
- Fix: pass the remaining budget through a deadline, or keep the original value for the message (for example, add an optional `reportedTimeoutMs`). Alternatively, accept it as is.

### L4. A template extension that does not match the actual media is kept as given
- Location: `node-helpers.ts:251-254`. `--audio-only` translations return `audio_url` (mp3) at `jobs.ts:100`, but `--output dub.mp4` names the file `dub-Spanish.mp4`. Single-output already behaves this way, so this is consistent but surprising.
- Fix (optional): a warning when `givenExt` differs from the inferred `ext`.

### L5. Test gaps (non-blocking)
- No test proves that `completeJobs` actually passes `staggerOffsetMs(index, …)` into `waitForJob`. The tests cover the pure function and `startDelayMs` only. Item 4 is optional, so this is acceptable.
- There is no test for the template with `--captions` (sibling `.srt` naming), for the uppercase scheme `HTTP://evil`, or for userinfo in the base URL.
- The new tests are real behavioural tests, not phantom tests. They assert that the fetch call count is zero, that no file was written, that `TOPSECRETSIG` is absent from errors and output, and the exact output file names. None of them makes a paid call.

## Informational (pre-existing, out of scope; consider separate issues per AGENTS.md)

- **Custom auth header on redirect.** `HeygenClient` sends `X-Api-Key` (`client.ts:162`) through `fetchJson` with the default redirect handling. The fetch spec strips only `Authorization` on a cross-origin redirect, so a 30x from the API or an https proxy to an `http://` or third-party origin would forward the key. This undercuts item 1 for the redirect case. Suggested fix: `redirect: "error"` (or manual handling) for authenticated provider API calls.
- **Repo `.env` can repoint the key.** `cwd/.env` is loaded without filtering (`env-loader.ts:4-11`). A cloned repository's `.env` can therefore set `HEYGEN_BASE_URL=https://attacker.example` and receive a key that came from `~/.multix/.env`. The https rule does not help here. This affects every `*_BASE_URL` override across providers; the legacy `.claude` loader already blocks it (`env-loader.ts:61-68`), but `cwd/.env` does not.

## Edge cases checked and OK

- Stagger:
  - Index 0 gets no delay.
  - `--poll-interval 1` gives a 1 ms step, so tests do not slow down.
  - `--wait-timeout 1` gives `floor(0.5) = 0` delay, and polling still runs.
  - The delay is capped so that polling always keeps at least half of the budget.
  - `Promise.allSettled` isolates per-job failures.
- Error text and logs: `downloadOutput` and thumbnail messages use `redactUrl`, and `HttpError.message` is already redacted. `--no-download` still prints the raw URL by design, because its purpose is to hand the caller a fetchable URL.
- Windows paths: `path.resolve`, `path.join`, `path.extname`, and `path.basename` are used throughout. The test uses `path.join(tmp, "out", "dub.mp4")`, and Windows CI is green.
- Docs: the EN and VI content match each other and the code, including the extension list and the `--captions` create-request note.

## Recommended actions

1. (M1) Check `response.url` after the redirect, or soften the "only downloaded from https" wording.
2. (M2) De-duplicate template destinations within a batch, and add a collision test.
3. (L1, L2) Handle caption/video path equality and directory detection for existing or trailing-slash paths.
4. Open separate issues for the two informational items (API-key redirect forwarding, and `*_BASE_URL` taken from `cwd/.env`).

## Unresolved questions

- Should a thumbnail with a non-https URL be skipped, as implemented, or refused, as the #77 text suggests ("refuse any output URL that is not https:")? Skipping looks like the better UX. Confirm with the issue owner.
- Lint, typecheck, and the test suite were not run locally (the Bash tool was unavailable). This review relies on the green GitHub CI for `041e03e`.

Status: DONE_WITH_CONCERNS
Summary: Approve with minor follow-ups. Critical 0, High 0, Medium 2, Low 5 (plus 2 pre-existing informational items). Local verification could not run; CI is green.
