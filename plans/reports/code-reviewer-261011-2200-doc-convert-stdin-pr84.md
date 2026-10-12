# Code review: PR #84, `multix doc convert --input -` (closes #74)

- PR: https://github.com/mrgoonie/multix-cli/pull/84, head `989886a4`, branch `feat/doc-convert-stdin`
- Reviewed source: the PR diff (GitHub API) and the full files in worktree
  `D:\www\oss\multix-cli\.claude\worktrees\agent-a5b3f3257bc34e1d7` (its HEAD is `feat/doc-convert-stdin`; `convert.ts` matches the diff)
- CI on the head SHA: all 5 checks green (Node 20/22 on ubuntu and windows, docs site)
- I did not run anything locally. The Bash tool returned no output for any command, including `echo`. Lint, typecheck and test status comes from CI only.

## Scope

10 files, about +309/-30: `src/commands/doc/convert.ts`, `src/commands/doc/index.ts`, `src/core/stdin-file.ts`,
`tests/unit/commands/doc-convert.test.ts` (new), `tests/unit/core/stdin-file.test.ts`, `tests/smoke/cli.test.ts`,
`README.md`, the EN and VI `docs-site/.../commands/media-and-documents.md`, and `skill/SKILL.md`.

## Verdict

**Approve with minor follow-ups.** I found no Critical or High issues. Everything #74 asks for is delivered:
- `-` reads piped stdin.
- `--stdin-ext` is wired up.
- Results and errors use the `<stdin>` label.
- Failures print a line without `-v`.
- The heading is escaped.
- Default output stays `document-extraction.md`; `--auto-name` gives `stdin-extraction.md`. #74 suggested `stdin.md` or requiring `--output`. The PR's name matches the existing `<base>-extraction.md` scheme, which is acceptable.

The changes to the shared helper are additive. The optional `flag` and `example` fields default to the old `--files` text. The three gemini callers (`analyze.ts:47`, `extract.ts:45`, `transcribe.ts:48`) pass neither field, so their messages do not change.

### Temp-file cleanup, path by path (verified)

| Path | Cleaned? | Where |
|---|---|---|
| Success | yes | `convert.ts:94-96` `finally { cleanup() }` |
| Some files failed, then `process.exit(1)` | yes, cleanup runs before the exit call; the exit hook is a no-op second guard | `convert.ts:97`, `stdin-file.ts:174` |
| `writeFileSync` or another error thrown inside `convertResolved` | yes, `finally` runs and the error propagates | `convert.ts:92-96` |
| Empty stdin, over-size input, error during read | yes | `stdin-file.ts:253-256` |
| Type not detected | yes | `stdin-file.ts:301-302` |
| Ctrl+C or SIGTERM during read or upload | yes, signal handler then re-raise | `stdin-file.ts:162-176` |
| Real input missing | stdin never read and no temp dir created (tested) | `convert.ts:66-70` |
| stdin is a TTY | error before any temp dir is created | `stdin-file.ts:204-208` |
| More than one `-` | rejected before stdin is read | `stdin-file.ts:281` |

---

## Critical

None.

## High

None.

## Medium

### M1. The new smoke test can make a paid Gemini call and write into the user's real output directory
`tests/smoke/cli.test.ts:258-269`

- **Problem:** `execa` uses `extendEnv: true` by default. The test blanks only `GEMINI_API_KEY`. `listGeminiKeys` (`key-pool.ts:30-46`) also reads `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, and so on.
- **Failure scenario:** A maintainer with `GEMINI_API_KEY_2` exported in their shell runs `npm test`. The CLI sends "piped notes for conversion" to Gemini on their key, which is a paid call and breaks the AGENTS.md rule "Tests must not call paid APIs by default". The call succeeds, so the exit code is 0 and the test fails.
- **Second problem:** The command runs without `--output`. If `MULTIX_OUTPUT_DIR` is set in the parent environment, `document-extraction.md` is written there instead of into `tmp` (`output-dir.ts:19-21`).
- **Already present:** The gemini smoke test at lines 216-227 has the same pattern. This PR copies it rather than introducing it.
- **Fix:**
  - Build the child env without inherited Gemini keys and pin the output directory:
    ```ts
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GEMINI_API_KEY(_\d+)?$/.test(k)));
    await execa("node", [CLI, "doc", "convert", "--input", "-"], {
      extendEnv: false,
      env: { ...env, MULTIX_DISABLE_HOME_ENV: "1", MULTIX_OUTPUT_DIR: tmp, TMP: tmp, TEMP: tmp, TMPDIR: tmp },
      ...
    });
    ```
  - Apply the same change to the gemini smoke test, or open a separate hardening issue for it.

### M2. Smoke-test timing depends on retrying a configuration error, which is a likely source of the unnamed timeout
`convert.ts:148-157`, `tests/smoke/cli.test.ts:252-253`

- **Problem:** The test comment admits that the missing-key `ConfigError` is retried 3 times with 1 s and 2 s sleeps. So every doc-convert smoke run spends at least 3 s sleeping, plus a cold `node dist/cli.js` start, which is slow on Windows under parallel vitest workers. The 15 s per-test override covers this test.
- **Other smoke tests:** All except two use vitest's default 5 s limit, and `vitest.config.ts` sets no `testTimeout`. The unnamed timeout in a full run is most likely one of those 5 s spawn tests starving while this test and other workers hold the CPU. It cannot be pinned to this PR from the evidence, but this PR adds about 4 s of extra wall time in the same file.
- **User impact:** `multix doc convert` with no key now waits about 3 s before printing "GEMINI_API_KEY is not set". This behavior is older than the PR, but the PR's new "failure printed without -v" makes the delay more visible.
- **Fix:**
  - Out of scope here; open an issue. Do not retry non-transient errors: `ConfigError`, `ValidationError`, and 4xx `HttpError` other than 408 and 429. For example:
    ```ts
    if (isGeminiRateLimitError(e) || e instanceof ConfigError || e instanceof ValidationError) break;
    ```
    The smoke test then finishes in about 1 s and no longer needs the 15 s override.
  - Separately, consider setting `testTimeout: 15_000` for `tests/smoke/**` to remove Windows CI flakes.

## Low

### L1. The type-detection error suggests the wrong format for doc convert
`stdin-file.ts:303-305`

- **Failure scenario:** `cat report.docx | multix doc convert --input -` fails with "pass --stdin-ext (e.g. --stdin-ext mp3)". A DOCX is a ZIP whose header contains bytes under 0x20, so it is never detected.
- **Why it matters:** The PR made the flag and example configurable, but not this hint. The hint is audio-flavoured and points doc users the wrong way.
- **Fix:** Add `extHint?: string` to `StdinUsage` (default `"mp3"`) and pass `"docx"` from `convert.ts:84-89`, or make the message format-neutral: `(e.g. --stdin-ext pdf, docx, mp3)`.

### L2. The output directory is created before stdin is validated
`convert.ts:82` vs `convert.ts:84`

- **Failure scenarios:** An interactive TTY, `--input - -`, `--stdin-ext` without `-`, or empty stdin each leave an empty `./multix-output/` behind. The command fails before any output is written.
- **Fix:** Move `fs.mkdirSync(path.dirname(outputPath), …)` into `convertResolved`, just before `writeFileSync`. This is harmless but tidier.

### L3. `<stdin>` is checked twice and the two missing-file messages differ
`convert.ts:66-70` and `stdin-file.ts:286-288`

- **Problem:** The two checks give "Input file not found" and "File not found". The doc-specific check exists so that a missing file is reported before stdin is read, but `resolveFileInputs` already checks existence before reading stdin.
- **Fix:** Remove the loop in `convert.ts`. The unit test "rejects a missing real file before reading stdin" would then need its regex changed to `/File not found/`. Alternatively, keep the loop and accept the duplicated check; it is cosmetic.

### L4. Test gaps
`tests/unit/commands/doc-convert.test.ts`

- No test passes `stdinExt` through `convertDocuments`. The commander wiring in `index.ts:27-30,53` is covered only by typecheck.
- No test covers the Files API branch (stdin larger than 20 MB, `shouldUseFileApi`). In that branch `labelError` must scrub the temp path from upload errors, and the upload `displayName` becomes `stdin.<ext>` (`client.ts:93`). That display name is acceptable because it does not leak the temp path, but nothing asserts it.
- The "missing real file" test spies on `Symbol.asyncIterator` but the code path throws before `resolveFileInputs`. The assertion proves ordering only by accident of the duplicated check from L3. If L3 is applied, it still holds, because `resolveFileInputs` checks existence first.
- The tests avoid key-pool cooldown leaks by using a unique key per test, rather than calling `_resetGeminiKeyCooldowns()` in `afterEach`. This works but is fragile if someone reuses a key string. The fix is to call the reset in `afterEach`.
- On the positive side, `fetch` is stubbed everywhere, so there are no paid calls in unit tests. The tests use a private temp root, and the 429 case avoids the backoff.

### L5. The docs advertise piped PPTX and DOCX conversion that Gemini may reject
`docs-site/src/content/docs/commands/media-and-documents.md:79`, VI `:76`, `README.md`

- **Problem:** The examples `cat slides.pptx | … --stdin-ext pptx` send the OOXML MIME type through `inlinePart`. Gemini's document-understanding docs list PDF and text types. I found no official confirmation that OOXML MIME types are accepted inline. This is unverified against the live API, and it predates the PR, since the README already claimed DOCX/XLSX/PPTX support for real files.
- **Fix:** Use a PDF in the second example, or check the PPTX case once with a live key before promoting it in the docs. Open a separate issue if OOXML is actually rejected.

### L6. Docs omit the "only one `-`" rule and how to pass a file literally named `-`
EN and VI `media-and-documents.md`

- **Problem:** The gemini page documents that `-` may appear only once. The doc page does not.
- **Fix:** Add one sentence, and mention `./-` for a real file named `-`.

### L7. With a non-TTY stdin that is not piped, the command waits with no timeout
Git Bash/mintty on Windows; CI steps with an open stdin

- **Behavior:** `isTTY` is undefined there, so `multix doc convert --input -` waits forever. The "Waiting for data on stdin (`--input -`)… press Ctrl+C" hint appears after 2 s.
- **Status:** This is existing, accepted behavior shared with the gemini commands, and the hint now names the correct flag. Recorded for awareness only; no change needed.

---

## Edge cases checked

- **Mixed inputs** (`--input a.pdf - b.png`): each input gets its own retry loop and the label is preserved. `--auto-name` with more than one input falls back to `document-extraction.md`.
- **Windows paths:** `path.basename("<stdin>")` returns `<stdin>` unchanged. `labelError` does a literal split and join on the exact temp path that the code itself built. Error text from fs and HTTP uses that same raw string, so no backslash-normalization gap was found.
- **Heading escape:** `\<stdin\>` renders as the literal `<stdin>` in CommonMark. Real POSIX file names containing `<` or `>` are now escaped too, which is harmless.
- **Data exposure:** Content is never logged, and the smoke test asserts this. Temp paths are scrubbed from errors and from the output Markdown, and the tests assert this. `HttpError` snippets may include Gemini's response body, which predates this PR and contains no prompt.
- **Exports:** `StdinLike` is newly exported (additive). The `stdinToTempFile` and `resolveFileInputs` signatures are widened with optional fields only, so they stay backward compatible.
- **AGENTS.md:** The commit style is conventional, the PR has one issue and links it with `Closes #74`, and EN and VI docs plus `skill/SKILL.md` are updated. No `node:*` imports were added to the provider client. No key or prompt is logged.

## Recommended actions

1. M1: remove the inherited `GEMINI_API_KEY_N` variables and set `MULTIX_OUTPUT_DIR` in the new smoke test. This is cheap and worth doing before merge.
2. M2: open an issue to stop retrying `ConfigError`, `ValidationError` and non-transient 4xx errors in `doc convert`. Consider a smoke-test `testTimeout`.
3. L1: give doc convert a docx-flavoured `--stdin-ext` hint.
4. L2 to L6: optional polish, which can go in a follow-up.

## Unresolved questions

- Does Gemini accept OOXML (pptx, docx, xlsx) MIME types inline or through the Files API? This decides whether the L5 docs example is valid.
- Which test produced the unnamed timeout? A full `npm test` log from the failing run would be needed to confirm M2 as the cause.

Status: DONE_WITH_CONCERNS
Summary: Approve with minor follow-ups; the feature matches #74 and temp-file cleanup holds on every path. Critical 0, High 0, Medium 2 (smoke-test env leak, retry-driven timing), Low 7. Not run locally because the Bash tool gave no output; CI is green on all 5 checks.
