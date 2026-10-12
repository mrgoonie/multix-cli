# Code review: PR #67, feat(replicate): add direct Replicate API provider (closes #54)

- Head: `40388cd` on `feat/replicate-provider` (matches `gh pr view 67`), rebased on `origin/main`
- Scope: 45 files, +2813/-11. About 1.3k LOC of source under `src/providers/replicate/**`, plus `src/cli.ts` and `src/commands/{check,index}.ts`, tests, README, SKILL and EN/VI docs
- Method: read-only. I exported `git archive HEAD` to a scratch directory, then ran the gates and an end-to-end CLI pass against a local mock HTTP server. The PR worktree was not modified.

## Verification evidence

| Gate | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` (biome, 226 files) | pass, 0 issues |
| `npm run build` | pass |
| `npm test` | 45 files passed, 1 skipped (live). 452 tests passed, 5 skipped |

End-to-end runs of the built `dist/cli.js` against a mock server (`REPLICATE_BASE_URL=http://127.0.0.1:<port>`):

- `replicate run owner/name --version abc --input {} --async` sends `POST /predictions {"version":"abc","input":{}}`. The flag works both before and after the other options.
- `multix --version` prints `0.7.3`.
- `multix replicate image "a cat" -V` now fails with `error: unknown option '-V'`, exit 1. This is a behaviour change; see L1.
- `status <failed id>` exits 1 with `Replicate prediction abc123 failed: NSFW`.
- `status --wait --wait-timeout 1500` on a running job exits 1 and prints the resume command.
- `status abc/../x` is rejected before any request.
- With 2 outputs where 1 download fails (404), the command exits 0. See M1.
- When the server returns prediction id `/../../../pwned`, the file is written one directory above `MULTIX_OUTPUT_DIR`. See M2.

## Overall assessment

The work is solid. Request shapes match the Replicate HTTP API: the official endpoint `POST /models/{o}/{n}/predictions {input}`, the versioned endpoint `POST /predictions {version,input}`, a `Prefer: wait=N` value clamped to 1–60, cancel, and multipart `/files` with a `content` field. The defaults match current model schemas: flux-schnell, and p-video with `image`, `duration`, `aspect_ratio`, `resolution` and `draft`.

Other things that hold up:
- Only `succeeded` counts as success.
- Polling is bounded, and network, 429 and 5xx errors are classified correctly.
- Create is retried only on 429, so a non-idempotent create is never replayed after a 5xx.
- Prediction ids supplied by the user are validated before they reach a URL path.
- The token never appears in errors. `HttpError` redacts query strings, and the 401 message is fixed text.
- The HTTP client is runtime-neutral, as AGENTS.md requires.

There are no Critical or High findings. Two Medium issues are worth fixing before merge because the fixes are cheap and they affect exit-code honesty and the trust boundary.

## Critical

None.

## High

None.

## Medium

### M1. A partial download failure exits 0
- **Where:** `src/providers/replicate/node-outputs.ts:142-152`; `src/providers/replicate/commands/prediction-flow.ts:96-104`.
- **Failure scenario:** `replicate image -n 4` or a multi-output model succeeds, but one or more downloads fail (expired URL, timeout, disk error). The failures are only logged with `warn`, the command prints `Saved 1 file(s)` and exits 0. Agents and scripts that rely on the exit code treat the run as complete and lose the remaining outputs once the signed URLs expire (about an hour). Reproduced end to end: 2 outputs, 1 failed with 404, exit 0.
- **Context:** fal does the same (`src/providers/fal/run-helpers.ts:193-215`), so this matches existing behaviour. However, this PR's docs say "Every media URL is downloaded" and "Only `succeeded` exits 0", which suggests stronger guarantees.
- **Fix:** In `saveMediaOutputs`, throw a `ProviderError` whenever `saved.length < media.length`. Name the failed items and include `resumeCommand(id)` so the user can retry with `status <id> --download` while the URLs are still live. Alternatively, set `process.exitCode = 1` after listing the saved files. Add a node-flow test for the partial-failure case.

### M2. A server-supplied prediction id is used in output file names without validation (path traversal)
- **Where:** `src/providers/replicate/client.ts:107-117` (`validatePrediction` only checks `typeof id === "string"`); `src/providers/replicate/output.ts:189-191` (`outputFilename` uses `predictionId.slice(0, 8)`); `src/providers/replicate/node-outputs.ts:49` (`path.join(outDir, …)`).
- **Failure scenario:** Suppose `REPLICATE_BASE_URL` points to an untrusted or compromised proxy. This is a documented "mocks/proxies" knob that can be set from a project `.env`. The proxy returns `{"id":"/../../../pwned","status":"succeeded",…}` on create. `waitForPrediction` returns terminal predictions immediately and skips `assertPredictionId` (`client.ts:263`), so the id is never checked. `path.join` then normalises `replicate-/../../-01.png` to a path outside `MULTIX_OUTPUT_DIR`. Reproduced: the file landed one level above the output directory. The same unvalidated id is also echoed into the printed resume commands.
- **Fix:** Apply the `PREDICTION_ID_RE` check inside `validatePrediction`, so every prediction-shaped response must have an `[a-z0-9]+` id. Belt and braces: build the file name from `id.replace(/[^a-z0-9]/gi, "")`. Add a client test for a malformed id in the create response.

### M3. `check` and the provider disagree on whitespace-only tokens
- **Where:** `src/commands/check.ts:82-90` (`resolveProviderKey` does not trim) versus `src/providers/replicate/node-client.ts:20-26` (trims, then falls back).
- **Failure scenario 1:** `REPLICATE_API_TOKEN="  "` with a real `REPLICATE_API_KEY`. `multix check` reports "REPLICATE_API_TOKEN found — ***", but the provider actually uses `REPLICATE_API_KEY`.
- **Failure scenario 2:** `REPLICATE_API_TOKEN="  "` alone. `check` says found and counts it toward `anyKey`, which skips the Codex check and the "No Provider Keys" exit. `multix replicate …` then fails with "not set".
- The repo already guards whitespace-only Cloudflare credentials (`check.test.ts`, "does not count whitespace-only Cloudflare credentials"), so this is an inconsistency, not a new policy. It affects BytePlus/ARK too, but Replicate is the new entry that adds trimming on the provider side only.
- **Fix:** Trim in `resolveProviderKey`, or reuse `resolveReplicateToken()` for the Replicate row. Add a check test: whitespace-only `REPLICATE_API_TOKEN` plus a set `REPLICATE_API_KEY` should report `REPLICATE_API_KEY`.

## Low

### L1. `.enablePositionalOptions()` changes root `-V`/`--version` handling
- **Where:** `src/cli.ts:18-21`.
- **Analysis:** I dumped the full command tree from the built CLI. The only command that has subcommands and its own options is the root, whose only option is `-V, --version`. No provider group or intermediate command defines options. In commander 12.1, the setting is inherited by all subcommands (they are registered after it). For leaf commands it has no effect, because the positional short-circuit only fires when `_findCommand(arg)` matches a subcommand. Existing leaf option parsing is therefore unchanged. The full smoke suite, including the `parse-args` and per-subcommand `--help` tests, passes.
- **Observable change:** `multix <group> <sub> … -V` (or `--version`) used to print the CLI version. Now it fails with `unknown option '-V'`, exit 1. Unknown-option suggestions also no longer include root flags. The risk is negligible, but the change is user-visible.
- **Fix:** No code change needed. Mention it in the PR body or changelog as "`--version`/`-V` must precede the subcommand". Optionally add a smoke test asserting `multix --version` still prints the version.

### L2. Downloads accept any http(s) host, follow redirects and have no size cap
- **Where:** `src/providers/replicate/node-outputs.ts:99-105`; `output.ts:24-29` (`HTTP_RE` accepts `http://`).
- **Failure scenario:** A community model, or a proxy behind `REPLICATE_BASE_URL`, returns output URLs such as `http://169.254.169.254/...` or `http://localhost:…`. The CLI then makes a GET from the user's machine or CI runner and writes the response to disk (a local SSRF read into an artifact). A very large response fills the disk until the 5-minute timeout. The token is not sent with downloads, which is good. The posture matches fal and the core `downloadFile`, so this is not a regression.
- **Fix:** Open a hardening issue rather than widening this PR, per AGENTS.md. Possible measures: download only `https:`; warn (or require a flag) when the host is not `replicate.delivery` / `*.replicate.delivery` / `api.replicate.com`; cap bytes, e.g. with a `MULTIX_MAX_DOWNLOAD_MB`.

### L3. `--prefer-wait [seconds]` swallows the prompt when placed before it
- **Where:** `src/providers/replicate/commands/prediction-flow.ts:33-36`.
- **Failure scenario:** `multix replicate image --prefer-wait "a cat"` makes commander take `"a cat"` as the option value, which produces `error: missing required argument 'prompt'`. Reproduced.
- **Fix:** Document "put `--prefer-wait` after the prompt", or make it a required-value option (`--prefer-wait <seconds>`) with a separate boolean.

### L4. A poll request can overrun `--wait-timeout` by up to 60 s
- **Where:** `src/providers/replicate/client.ts:266-268`.
- **Problem:** `pollUntil` passes `remainingMs`, but `fetchStatus` ignores it and uses the fixed 60 s `REQUEST_TIMEOUT_MS`.
- **Fix:** Use `fetchStatus: ({ remainingMs }) => this.raw(..., "GET", undefined, undefined, Math.min(REQUEST_TIMEOUT_MS, remainingMs))`.

### L5. A create request that times out can leave a billed prediction with no id
- **Where:** `src/providers/replicate/client.ts:211-231`.
- **Problem:** With `--prefer-wait 60` the create timeout is 120 s. If the client aborts after Replicate has already created the prediction, the user gets "Network error" and no id to cancel or resume.
- **Fix:** Mention it in the error text ("check https://replicate.com/predictions before retrying"). A full fix would need an idempotency key, which Replicate does not offer, so a docs note is enough.

### L6. Download streaming duplicates core `downloadFile`
- **Where:** `src/providers/replicate/node-outputs.ts:58-71` versus `src/core/http-client.ts:32-70`.
- **Problem:** The duplication is justified, because the destination depends on the response `content-type`. Still, the Windows close-handle workaround is now copied in two places.
- **Fix:** Optional. Let core `downloadFile` accept a `resolveDest(response)` callback.

### L7. Docs accuracy (EN and VI are in parity; all claims below were checked against code)
- `docs-site/.../commands/replicate.md:79` (VI `:80`), README and SKILL say files are named `replicate-<id>-NN.<ext>`. The code uses the first 8 characters of the id (`output.ts:190`), so it should read `replicate-<id8>-NN`.
- `replicate.md:50-52` (VI `:51-52`) says "Images are converted to WebP by default". It omits that an explicit `--output-format`, or an `--output` ending in `.png`/`.jpg`, keeps the original format (`image-webp-finalize.ts:62-64`).
- `replicate.md:68-69` says "Only `succeeded` exits 0". This is true for status, but see M1 for partial downloads. Also, `status <id>` on a running job exits 0 by design, which is worth one clause.
- `.env.example:14` says "Fallback for REPLICATE_API_TOKEN" without the "(direct `multix replicate` only)" qualifier that README and SKILL include. Cloudflare video reads only `REPLICATE_API_TOKEN` (`cloudflare/models.ts:63`). The EN/VI environment reference already says this correctly.
- `--image`/`--file` are documented as accepting an `https://` URL. `http://` URLs and data URIs are also passed through. This is harmless.

### L8. Test gaps (the existing tests are behavioural, not phantom; these are what is missing)
- No test for a partial download failure (M1), or for a malformed id in a create response (M2).
- No test that `REPLICATE_API_KEY` alone leaves `cloudflareReadiness().video` false. This pins the documented "Cloudflare reads only `REPLICATE_API_TOKEN`" contract.
- The `status` and `cancel` command actions are not tested directly; only `completePrediction` is. The branch where `status` exits non-zero for a failed prediction with no `--wait` (`status.ts:56-61`) is covered only by my e2e run.
- The smoke test for `--version` asserts only "token not set". It would also pass if `--version` were silently ignored. Use a mock `REPLICATE_BASE_URL` (or a unit test on the parsed opts) to assert that `version` reaches `parseModelRef`.
- `check.test.ts` stubs env and calls `vi.unstubAllEnvs()` inline, not in `afterEach`, so a failing assertion leaks the stubs into later tests. This follows the existing pattern in that file, but it is fragile.

## Scout findings (edge cases checked)
- **Commander positional options:** inherited by every subcommand; there are no group-level options, so leaf parsing is unchanged (L1).
- **Prediction id flow:** user ids are validated (`assertPredictionId`); ids from the server are not (M2).
- **Prefer-wait:** clamped, adds to the request timeout, and polling continues when the job is not terminal (tested).
- **Create retries:** 429 only, capped at 30 s and 2 retries; 5xx and network errors are not retried, which is correct for a non-idempotent call.
- **Terminal statuses:** `aborted` is included; a non-terminal prediction that already has output is not treated as success (tested).
- **Output extraction:** handles strings, URL lists, nested objects, LLM token arrays and data URIs. A URL string that a text model returns as its answer is downloaded instead of printed. This is a minor surprise, not a bug.
- **Uploads:** data URIs up to 256 KB and `/files` multipart under 100 MB, matching Replicate guidance. `urls.get` is passed as the input value.
- **Secrets:** the token appears only in the `Authorization` header; summaries omit `input` and `logs`; output query strings are redacted in status JSON and debug logs. `--no-download` prints raw URLs on purpose, and the docs say so.

## Recommended actions
1. M2: validate the `id` format inside `validatePrediction` and sanitise the file-name prefix, and add a test. This is the cheapest fix and it closes the trust-boundary gap.
2. M1: exit non-zero (with a resume hint) when any media download fails, and add a test.
3. M3: trim in `check.ts` `resolveProviderKey` (or reuse `resolveReplicateToken`), and add a test.
4. L7: fix the `<id>` naming and the WebP-default wording in EN and VI, and the `.env.example` comment.
5. L1: note the `-V` placement change in the PR body.
6. L2: open a separate hardening issue for download host, scheme and size limits across providers.

## Metrics
- Type coverage: `tsc --noEmit` is clean. There is no new `any` in the provider code; the only `biome-ignore` is the existing one in `cli.ts`.
- Tests: 452 passing. The new Replicate unit tests cover the client, flow, models/output and wrappers. A live smoke test is gated behind `MULTIX_LIVE_TESTS=1` plus a token and does not print the key.
- Lint issues: 0.

## Unresolved questions
- Is `REPLICATE_BASE_URL` meant to be a trusted-only knob? If yes, M2 and L2 drop to Low, but the id check is still worth adding because it costs nothing.
- Should multix-wide behaviour exit non-zero on partial downloads? If yes, fal should change too, in a separate issue.

Status: DONE_WITH_CONCERNS
Summary: There are no Critical or High findings, and all gates pass (typecheck, lint, build, 452 tests). `.enablePositionalOptions()` is safe for every existing command; the only visible change is that root `-V`/`--version` must come before the subcommand. Before merge, fix three Medium issues: exit 0 on partial download failure, server-supplied prediction ids used unvalidated in output file names (path traversal, reproduced), and whitespace-only token handling in `check`. There are also small EN/VI doc inaccuracies.
