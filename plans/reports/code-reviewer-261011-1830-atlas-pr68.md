# Code review: PR #68 feat(atlascloud): add Atlas Cloud provider (closes #53)

Isolated, read-only review. Branch `feat/atlascloud-provider` (worktree `agent-a10e0cde5410fe83d`), commits `bafc4fc`, `fbd15c4`. The diff against `origin/main...HEAD` is 44 files, +3625/-4. All line references below are to files in that worktree.

## Scope
- Code: `src/providers/atlascloud/**` (client, model-input, prediction-output, models, types, upload-mime, and commands/*). Shared wiring: `src/cli.ts`, `src/commands/{index,check}.ts`, `setup-hints.ts`, `.env.example` and `package.json`.
- Tests: `tests/unit/providers/atlascloud/*` and the smoke tests.
- Docs: README, `skill/SKILL.md`, and the docs-site EN and VI pages (atlascloud, providers, commands, environment, for-ai-agents, sidebar).
- Verification: GitHub CI passes on Node 20/22 for ubuntu and windows, and the docs site job passes. I did not run local `npm ci` or the tests: the worktree has no `node_modules` and the review was read-only. Every finding below comes from reading the code and tracing the call paths.

## Overall assessment
The structure is solid. The client is genuinely free of `node:*` imports. Schema-driven field mapping runs before any upload or billable submit, and prediction ids are validated before they reach a URL path. Output filenames are sanitized, the URL query is redacted in warnings and HttpError, and catalog and schema fetches never send the key. The live test is gated correctly.

One documented contract is broken in production but hidden by the tests: "`--async` prints only the prediction id on stdout". I also found several medium robustness and safety gaps. None of them is a key leak.

## Critical
None.

## High

### H1. `--async` and `atlas upload` write progress lines to stdout, which breaks the documented capture and resume flow
- **Where:**
  - `src/providers/atlascloud/commands/prediction-runner.ts:153` calls `logger.info("Submitting to …")` before the `--async` branch at :157-160.
  - `src/providers/atlascloud/commands/env.ts:67` calls `logger.info("Uploading …")`.
  - `src/core/logger.ts` sends `info` to `console.log`, which is stdout.
- **Failure scenario:** `id=$(multix atlas video "waves" --async)` captures two lines: `  Submitting to bytedance/… (generateVideo)...` and then `<id>`. The next command, `multix atlas status "$id" --wait --download`, fails `PREDICTION_ID_RE` (`client.ts:47`) with "Invalid Atlas Cloud prediction id". Both documented examples break this way: `skill/SKILL.md:151` and `:396`. The docs claims are false in EN (`docs-site/.../commands/atlascloud.md:105`) and VI (`vi/commands/atlascloud.md:106`). With a local `--ref` an extra "Uploading …" line is added. `URL=$(multix atlas upload photo.png)` breaks the same way.
- **Why CI is green:** `tests/unit/providers/atlascloud/prediction-runner.test.ts:33-40` injects a stub logger. So the assertion `expect(stdout).toEqual(["async01"])` at :203 never sees the real logger. Other providers do not have this problem: byteplus `--async` logs only at debug level before printing the id.
- **Fix:**
  - When `opts.async` is set, send progress to stderr: `console.error` or a logger created with a stderr sink. Or demote the pre-submit and upload lines to `debug`.
  - Do the same in `atlas upload`.
  - Add a smoke or unit test that uses the real `createLogger` and asserts stdout is exactly `<id>\n` (fake fetch through `ATLASCLOUD_BASE_URL` or an injected client).

## Medium

### M1. Any HTTP ≥400 whose body contains `"status":"error"` is treated as a terminal prediction failure, which skips the 429/5xx retry
- **Where:** `src/providers/atlascloud/client.ts:80-96` (`error.status < 400` gate), used in `getPrediction` at :177-180, before `pollUntil` sees the error.
- **Failure scenario:** A 429 or 503 from Atlas or a gateway with a body like `{"status":"error","message":"rate limited"}` goes through `isFailureStatus("error")`, which returns true. Polling stops and the job is reported as "prediction failed" with exit 1. The job is actually still running and billed. A 401 or 403 with the same body shape is reported as a prediction failure instead of an auth error. This contradicts the docs, which say "Polling retries rate limits … 5xx".
- **Fix:**
  - Recover a terminal state only when `error.status >= 500` and not 429, which is the documented Atlas case.
  - Require the envelope shape `data.status`, not a top-level `status`.
  - Drop the regex fallback for non-`failed` values, or limit it to `failed`.
  - Add a test: a 429 with a `{"status":"error"}` body is retried.

### M2. Local uploads have no size cap, are read fully into memory, and accept any file type
- **Where:** `src/providers/atlascloud/commands/env.ts:55-69` (`fs.readFile` of the whole file) and `commands/upload.ts:23`. `upload-mime.ts:440-443` falls back to `application/octet-stream` and still uploads.
- **Failure scenarios:**
  1. A multi-GB `--audio` or `--ref` is buffered in RAM. Above 2 GiB it throws `ERR_FS_FILE_TOO_LARGE` only after the read.
  2. The CLI is driven by agents through `skill/SKILL.md`. A prompt-injected agent can run `multix atlas upload ~/.ssh/id_rsa` or `--ref .env` and get a third-party URL for the file. Nothing restricts uploads to media.
  3. Atlas documents no upload limit (only "depending on the model"), so the client is the only guard.
- **Fix:**
  - Check `stat.size` against a cap before reading. For example 200 MB, overridable through an env var.
  - Reject extensions that are not in `UPLOAD_MIME_TYPES` with a clear error.
  - Use `fs.openAsBlob(abs, { type: mime })` (Node ≥ 19.8) instead of `readFile`, so the body is streamed.

### M3. `--ref <pathOrUrl...>` is variadic and swallows the positional prompt (a real UX bug)
- **Where:** `commands/three-d.ts:32` (`3d [prompt]` plus a variadic `--ref`). The same variadic declaration is at `commands/image.ts:74` and `commands/video.ts:71`; those commands have no positional, so they are not affected today.
- **Failure scenario:** `multix atlas 3d --ref chest.png "a treasure chest"` gives `refs = ["chest.png", "a treasure chest"]` and leaves `prompt` undefined.
  - With a schema: "--ref: field "image" … accepts a single value, got 2".
  - Without a schema (or with `--no-validate`): "Reference file not found: a treasure chest".
  - Nothing is billed, but the error is misleading, and the order users naturally type is broken.
  - The rest of the repo uses a repeatable, non-variadic `--ref <path>` with `collect` (byteplus/openai/gemini `image-to-image`). The Atlas docs already show that syntax (`--ref photo.png [--ref https://...]`).
- **Fix:**
  - Use `.option("--ref <pathOrUrl>", "…; repeatable", collect, [])` in all three commands. Reuse a shared `collect` helper rather than adding a fourth copy.
  - Add a parse test asserting that `atlas 3d --ref a.png "prompt"` yields `prompt === "prompt"` and `ref === ["a.png"]`.

### M4. When some downloads fail, the command still exits 0
- **Where:** `commands/prediction-runner.ts:258-278`. Only `saved.length === 0` throws.
- **Failure scenario:** A 4-image job where one signed URL returns 403 or times out. The command logs a warning, prints "saved 3 file(s)" and exits 0. A script or agent treats the run as complete, even though the output was paid for and lost. Because the error is a ProviderError, the shell sees a plain success.
- **Fix:** After the loop, if `saved.length < urls.length`, throw a ProviderError (exit 1) that lists the saved files and gives `resumeCommand(id)`. Alternatively add an explicit `--allow-partial` flag.

### M5. The no-schema fallback sends raw CLI strings and wrong shapes, so a "billable but wrong" job is possible
- **Where:** `src/providers/atlascloud/model-input.ts:213-216`. This path runs when the catalog or schema is unreachable, when the model is not in the public catalog, or with `--no-validate`.
- **Failure scenario:**
  - `image-to-video --ref frame.png` sends `image: ["https://…"]` (an array, because refs is always an array) to a model that expects a string.
  - `--seed 42`, `--duration 5` and `-n 2` are sent as strings.
  - The module's own header comment says Atlas "accepts incomplete payloads and silently fills defaults". So the image can be ignored and a plain text-to-video job is billed.
- **Fix:**
  - In the no-spec path, unwrap single-element arrays for single-value candidates (`primaryImage`, `audioInput`).
  - Coerce numeric flags (`seed`, `duration`, `numImages`) with `Number()`.
  - Or refuse convenience commands without a schema unless `--no-validate` was explicit, and point to `atlas run`.

### M6. `uploadMedia` calls the injected fetch as a method, which fails in Cloudflare Workers
- **Where:** `src/providers/atlascloud/client.ts:135-137` (`this.fetchImpl(input, init)`), used by `uploadMedia` at :225.
- **Failure scenario:** In a Worker, `new AtlasCloudClient({ apiKey, fetch })` with the native `fetch` makes `uploadMedia` throw "Illegal invocation: function called with incorrect `this` reference". Workers' fetch rejects a non-global receiver. The JSON paths work because `fetchJson` calls `opts.fetch` as a bare function. So the runtime-neutral claim holds for imports but not at runtime for uploads. The neutrality test (`prediction-output.test.ts:107-128`) only regex-checks import specifiers.
- **Fix:** `const f = this.fetchImpl; return f ? f(input, init) : globalThis.fetch(input, init);`, or bind in the constructor (`opts.fetch?.bind(globalThis)`). Add a unit test with a fetch that asserts `this === undefined || this === globalThis`.

## Low

### L1. A failed download deletes a file the user already had
- **Where:** `prediction-runner.ts:267`.
- **Failure scenario:** `--output hero.png` names an existing file. The download returns 403, then `rmSync(dest)` deletes the user's original, which `downloadFile` never truncated because it failed before opening the stream.
- **Fix:** Download to `${dest}.part` and rename on success. Delete only the `.part` file.

### L2. `status --download` loses the output-type hint
- **Where:** `commands/status.ts:58` calls `deliverPrediction` without `hint`.
- **Failure scenario:** For extensionless output URLs the file is saved as `.bin`. This is the documented resume path, so `--async` users get a different filename than the synchronous run would give.
- **Fix:** Infer the hint from `prediction.model` through the catalog `type`, or from the download's `Content-Type`.

### L3. Two `--wait-timeout` gaps
- `status --wait` does not pass a `resumeHint`, so its timeout message has no resume command (`status.ts:48-51`).
- Each poll uses the fixed 120 s client timeout and ignores `remainingMs` (`client.ts:192`). A hung poll can overrun `--wait-timeout` by up to 120 s.

### L4. Output downloads accept any host, follow redirects and have no size cap
- **Where:** `prediction-runner.ts:263` calls `core/http-client.ts:32`.
- **Risk:** In a CLI threat model this is low: the URLs come from an authenticated HTTPS API, and the client used by a Worker does not download at all. A compromised response can still make the CLI fetch `http://169.254.169.254/...` or a LAN host into a local file, or fill the disk.
- **Fix:** Require `https:` for downloads (keep `data:`), and consider a max-bytes guard.

### L5. The thumbnail detector walks the whole prediction
- **Where:** `prediction-runner.ts:293`; the walker is `core/video-thumb.ts:227-249`, which matches the keys `image_url` and `imageUrl`.
- **Risk:** If Atlas echoes the input, an image-to-video run may "save a thumb" that is really the user's reference image or the temporary upload.
- **Fix:** Pass only the outputs subtree, or skip thumbnails for Atlas.

### L6. Default filenames can be silently overwritten
- **Where:** `prediction-output.ts:493-496` uses only the first 8 characters of the id.
- **Risk:** If two ids share that prefix, an earlier file is overwritten. The risk is low unless Atlas ids carry a common prefix.

### L7. Docs say `--type` is only needed for schemaless models, but `--no-validate` also requires it
- **Where:** `run.ts:76-83`.
- **Risk:** With `--no-validate`, `run` also needs `--type`, because the schema is never loaded.
- **Fix:** Document this in EN and VI, or still load the spec for endpoint discovery when `--no-validate` is set.

### L8. Catalog and schema fetches use the 120 s default timeout on every command
- **Where:** `client.ts:259-263` and :290-294.
- **Risk:** A slow catalog stalls each command for up to 2 minutes before the "sending without validation" warning.
- **Fix:** Use a short timeout (about 15 s) for the catalog and schema fetches.

## Security checklist results
- **Key leakage:** None found.
  - The key is sent only to `baseUrl`, which defaults to Atlas or comes from the user's `ATLASCLOUD_BASE_URL`.
  - Catalog and schema fetches send no auth.
  - `HttpError` redacts the URL query, download warnings use `redactUrl`, and the unit test checks the signed query is not leaked.
  - `status` (without `--download`) and `--no-download` print signed output URLs to stdout. Both are documented, and the docs say to treat those URLs as secrets.
- **Path traversal:**
  - Prediction ids are sanitized in filenames (`outputFileName`).
  - The extension is limited to `[a-z0-9]{2,5}`.
  - A user-supplied `status <id>` is validated by `PREDICTION_ID_RE` before it is put into the URL path.
  - `--output` is user-controlled by design.
- **SSRF:** See L4. Schema fetches require `https:`.
- **Upload limits:** See M2.

## Runtime neutrality
- `client.ts`, `types.ts`, `models.ts`, `model-input.ts`, `prediction-output.ts` and `upload-mime.ts` import only `core/{errors,fetch-json,async-poll,redact}`, and none of those import Node modules. `errors.ts` guards `Error.captureStackTrace`. `AbortSignal.timeout`, `FormData` and `Blob` all exist in workerd.
- The exception is the runtime `this` binding in M6.
- `commands/*` (fs, path, logger, env) is Node-only and is kept separate, which matches AGENTS.md.

## Test quality
- **Strong:** client contract tests (Retry-After, 401 not retried, terminal failure via 500, truncated-snippet recovery), the model-input mapping and enum/range/maxItems checks, the STT text path, redaction on download failure, and the endpoint guard.
- **Gaps:**
  - The stub logger hides H1. Add an end-to-end stdout assertion with the real logger.
  - No test for a 429 or 401 whose body contains a status string (M1).
  - No parse test for `--ref` combined with a positional (M3).
  - No partial-download exit-code test (M4).
  - No no-schema shape test for single-image fields: the current test at `model-input.test.ts:194` asserts the raw passthrough (M5).
  - The neutrality test is import-regex only (M6).
- **Live test:** `live.test.ts` is gated on `MULTIX_LIVE_TESTS=1` plus the key and prints nothing sensitive. That is correct.
- **Smoke test** "without ATLASCLOUD_API_KEY": safe. dotenv uses `override:false`, so the empty `ATLASCLOUD_API_KEY=""` blocks any `.env` value. This still holds with #70's new layers.

## Docs accuracy (EN and VI)
- The VI page matches the EN structure section for section.
- **Wrong in both languages:** "`--async` prints only the prediction id on stdout" (H1). SKILL.md:151 and :396 depend on that claim.
- **Partly wrong:** "Polling retries rate limits" (M1). "Pass `--type` only for a model that has no published schema" (L7).
- **Minor:** `--ref` also accepts `http://` and `data:` URIs, but the docs say `https://` only.
- **Accurate:** env var names match `env.ts` and `.env.example`, `check.ts` and `setup-hints.ts` include Atlas Cloud, and the defaults table matches `models.ts`.

## Conflicts with other open PRs
All four provider PRs append to the same anchor lines, so whichever PR merges second needs a manual rebase for each hunk below. Hunk headers come from `gh pr diff`.

| File | #68 hunk | Conflicts with | Expected result |
|---|---|---|---|
| `src/cli.ts` | @@ -13,7 (description string, line 16) | #67 (-13,9), #69 (-13,7) | Hard conflict on the same line: each PR appends a provider name. |
| `src/commands/index.ts` | @@ -30 (register call after `registerFalCommands`) | #67 (-30), #69 (-30) | Conflict. The import hunks are alphabetical and at different lines (#68 at 4, #69 at 9, #67 at 13), so they merge cleanly. |
| `src/commands/check.ts` | @@ -70,6 (new PROVIDERS entry after fal) | #67 (-70,6), #69 (-70,6) | Conflict. #65's hunks at -73 (after `];`) and #70's at -4 and -141 are probably clean but adjacent, so verify after rebase. |
| `src/commands/check-helpers/setup-hints.ts` | @@ -13,6 (line after fal.ai) | #67, #69 | Conflict. |
| `.env.example` | @@ -9 (after `FAL_KEY=`) and @@ -59,3 (end-of-file block) | #67 and #69 (both hunks), #70 (-59,3 EOF) | Conflict at both anchors. #65 (-1,5) is clean. |
| `README.md` | @@ -4,7 (provider list, line 7), @@ -70 (key list), @@ -470 (new section at EOF) | #67 (-4, -80, -470), #69 (-4, -69, -470) | The line-7 and EOF appends conflict. Line 69 vs 70 with #69 is adjacent and will likely conflict. #65 (-56, -95) and #70 (-95) are clean. |
| `docs-site/astro.config.mjs` | @@ -85 (sidebar entry) | #67, #69 | Conflict. |
| `docs-site/.../commands.md` (EN and VI) | @@ -17 | #67, #69 | Conflict. |
| `docs-site/.../commands/providers.md` (EN and VI) | @@ -16 | #67, #69 | Conflict. |
| `docs-site/.../reference/environment.md` (EN) | @@ -21 (key table), @@ -39 (overrides paragraph) | #67 (-21, -37,7), #69 (-21, -37,7), #65 and #70 (-28 insertions) | The -21 hunk conflicts with #67 and #69. #67 and #69 rewrite lines 37-43, which overlap #68's insertion at 42, so that conflicts too. #65 and #70 insert near line 30: probably clean against #68 but they conflict with each other. |
| `docs-site/.../vi/reference/environment.md` | @@ -20, @@ -38 | Same as EN (#67 and #69 at -20 and -36,7; #65 and #70 at -27) | Same as EN. |
| `docs-site/.../reference/for-ai-agents.md` (EN -38, VI -36) | single row insert | #67, #69 | Conflict. |
| `package.json` | @@ -1,7 (description), @@ -49 (keywords) | #67, #69 | Conflict on both. |
| `skill/SKILL.md` | @@ -1 (frontmatter description), -22, -43, -79, -128 (new section), -317, -363 | #67 (-1, -22, -43, -79, -128, -321, -363), #69 (-1, -22, -43, -128) | Conflicts on almost every hunk. #65 (-35) is clean. |
| `tests/smoke/cli.test.ts` | @@ -26 | #67, #69 | Conflict (same append point). |
| `tests/smoke/parse-args.test.ts` | @@ -19 (top-level list), @@ -30 (subcommands map) | #67, #69 | Conflict on both. |

**Recommendation:** Merge the provider PRs one at a time (#67, #68, #69 in any order), and rebase each remaining PR before review. Better still, land a small refactor first that moves the provider list (check.ts PROVIDERS, setup-hints, the cli.ts description) to a single registry, so later provider PRs stop touching the same lines. For docs, alphabetical insertion would reduce conflicts but not remove them.

## Recommended actions (priority order)
1. **H1:** Keep stdout to the id or URL only for `--async` and `upload`, and add a real-logger stdout test.
2. **M1:** Limit terminal-from-error recovery to 5xx (excluding 429) with the envelope shape, and add a 429-body test.
3. **M3:** Use a repeatable `--ref` with `collect`, and add a parse test for `3d --ref x "prompt"`.
4. **M4:** Exit non-zero on a partial download.
5. **M2:** Add an upload size cap, a media extension allowlist and `fs.openAsBlob`.
6. **M5:** Fix value shapes and number coercion in the no-schema path.
7. **M6:** Call the injected fetch without a receiver.
8. **Low items:** L1 (`.part` downloads) and L2 (resume hint) are cheap and worth doing in this PR. The rest can be follow-up issues per AGENTS.md.
9. Fix the EN and VI docs and SKILL.md for H1, M1 and L7.

## Metrics
- Type coverage: strict TS. One justified `biome-ignore` for `any` in `model-input.ts:16` (untyped OpenAPI JSON).
- Tests: about 60 new unit cases and 3 smoke cases. CI is green on 4 jobs plus docs. I did not measure coverage.
- Lint: the CI lint step passes, with no new suppressions beyond the one above.

## Unresolved questions
- What do real Atlas prediction ids look like? This decides whether the 8-character filename prefix (L6) can collide.
- Does Atlas echo `input` (including `image_url`) in prediction payloads? This decides whether L5 actually triggers.
- What upload size limit does Atlas enforce server-side? It sets the default for the M2 cap.

Status: DONE_WITH_CONCERNS
Summary: No critical or key-leak issues, but one High: `--async` and `upload` write progress lines to stdout, which breaks the documented `id=$(… --async)` resume flow, and a stub logger in the tests hides it. Six Medium issues should be fixed before merge: 429/401 bodies treated as terminal failures, uncapped uploads of any file type, variadic `--ref` swallowing the `3d` prompt, partial downloads exiting 0, no-schema payload shapes, and a Worker `this` binding in upload. Nearly every shared registration and docs hunk conflicts with #67 and #69.
