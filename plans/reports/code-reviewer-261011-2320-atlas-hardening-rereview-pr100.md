# Re-review: PR #100 `fix/atlascloud-hardening` (closes #78), head `a5ba559`

Isolated re-review; I did not write this code. The local worktree `agent-a2cb2b708e7784d1e` is at `a5ba559` (confirmed from `.git/worktrees/.../logs/HEAD`). Bash was dead, so nothing ran locally. CI on `a5ba559` is green: Node 20/22 on ubuntu and windows, MCP Worker, and the docs site.

New commit under review: `668ebac fix(atlascloud): make output downloads idempotent and reserve names`. The other new commits are merges from main.

## Verdict

**Merge (approve with follow-ups).** No Critical or High findings. The previous M1 is fixed properly. One new Medium is a UX regression introduced by the lock design: it has a manual recovery path and is documented, so it is not a blocker. The Lows are hardening.

## Previous findings

| ID | Status | Evidence |
|---|---|---|
| M1: non-idempotent retry, stale docs line | **Fixed** | Names use the full sanitized id (`prediction-output.ts:241-244`). The `reuse` policy skips outputs that are already saved (`prediction-runner.ts:299-307`). The test at `prediction-runner.test.ts:520-541` covers a partial failure, a retry and a third no-op run. The docs line (EN `atlascloud.md:157-159`, VI `:158-160`) is now true. |
| L1: cross-process TOCTOU, `.part` not reserving | **Fixed** (a small residual is in L5 below) | An exclusive `<dest>.part` lock (`:460-480`). `PART_SUFFIX` covers both the lock and #101's `<dest>.<pid>-<time>-<rand>.part` (`:403`). Tests at `:552-563`, `:598-611` and `:646-653`. |
| L2: case-sensitive stems | **Fixed** | `foldCase` on win32/darwin (`:400`, `:409`, `:445`). Test `:637-644` (runIf). The residual risk on other case-insensitive filesystems is in L2 below. |
| L3: thumbnails outside the no-overwrite rule | **Fixed** | Thumbnails use the same `policy`, `savedOutput` and `downloadClaimed` (`:354-362`). Tests `:687-702` (rerun) and `:720-732` (orphan thumbnail). |
| L4: MIME gaps, SVG sent to WebP | **Fixed** (optional part not done) | Added `avif`, `bmp`, `svg+xml`, `x-matroska`, `matroska` and `audio/webm` (`prediction-output.ts:130-154`). `svg` is deliberately left out of `EXT_CATEGORY`, so it never reaches the finalizer (`:95-96`). Test `:655-672`. Still open: a URL extension is trusted as-is (see L6). |
| L5: test gaps | **Fixed** | Thumbnail private-IP over https (`:707-708`), explicit `--output` overwrite (`:565-577`), Content-Type-named collision (`:579-596`), `.part` and case collisions. |
| L6: SKILL.md missing Atlas download policy | **Fixed** | `skill/SKILL.md:141` covers https-only, the private-IP refusal, "already saved", `-N` suffixes and the `.part` error. |
| L7: commit hygiene | **Open** | See L7 below. |

## Critical
None.

## High
None.

## Medium

**M1. After an interrupted run, the resume command fails until the user deletes a file by hand, and a large partial file is orphaned.**
- Code:
  - `prediction-runner.ts:466` creates the lock.
  - `:470-474` raises an error on EEXIST under `reuse`.
  - `:506-514` releases the lock only in `finally`.
  - `http-client.ts:174-193` handles the temp file.
- Scenario: a user starts a multi-minute video download and presses Ctrl+C, or the agent's shell is killed. No SIGINT handler exists for this path; `src/core/stdin-file.ts:155` is the only signal handling in `src/`. So `finally` never runs, and two files are left behind:
  - `atlas-<id>-01.mp4.part`: the empty lock.
  - `atlas-<id>-01.mp4.<pid>-<time>-<rand>.part`: up to `MULTIX_MAX_DOWNLOAD_MB` (2 GB) of partial data.
- What then happens:
  - The documented `multix atlas status <id> --wait --download` fails for that output with "another download ... is in progress".
  - The final error prints the same retry command again (`:371`), which fails the same way.
  - Even after the user deletes the lock as told, the multi-GB temp file stays forever. Nothing mentions or removes it, and `savedOutput` ignores it.
- This is a regression: before the lock existed, a retry after Ctrl+C just worked.
- The guidance is adequate as text: the error names the path (`:472`), and the EN/VI docs (`:164` / `:164-165`) and SKILL.md say to delete it. But the most common interruption should not need manual cleanup.
- Fix, smallest first:
  1. Write `process.pid` (and the hostname) into the lock. On EEXIST, read it back and treat the lock as stale if `process.kill(pid, 0)` throws `ESRCH` on the same host; then take the lock over. This is a few lines, and the existing error message stays as the fallback.
  2. Optionally, register a one-shot SIGINT/SIGTERM cleanup for the active lock and temp file, reusing the `stdin-file.ts` pattern.
  3. Mention the orphaned `<name>.<pid>-…part` temp file in the docs and the error text, so users know it can be deleted too.

## Low

**L1. The printed retry hint drops `--output`, so a retry after a directory `--output` downloads everything again somewhere else.**
- Code: `resumeCommand(prediction.id)` at `prediction-runner.ts:330` and `:371`, defined at `:174-176`.
- Scenario: `multix atlas image ... --output ./renders/` gets 3 of 4 outputs. The hint says `multix atlas status <id> --wait --download`. An agent copies it verbatim, so all 4 outputs download again into `./multix-output/`, and the "already saved" logic never applies.
- The docs promise of idempotent retry holds only if the user re-adds `--output` by hand.
- Fix: let `deliverPrediction` build the hint with ` --output <quoted path>` when `opts.output` was given. Optionally carry `--image-format`/`--no-webp` as well.

**L2. The `unique` claim loop is unbounded and assumes `readdir` matches how the filesystem compares names.**
- Code: `prediction-runner.ts:463-479`, and `:440-451`.
- Scenario: Linux on a case-insensitive mount (WSL `/mnt/c`, exFAT/vfat, SMB), where `foldCase` is false, or macOS with non-ASCII names that differ only in Unicode normalization (NFC vs NFD).
  - If a stale `Shot-01.mp4.part` exists, `availableOutputPath("shot-01.mp4")` keeps reporting the name as free while `openSync(..., "wx")` keeps throwing EEXIST. The `for (;;)` loop then spins forever on `readdirSync`.
  - Without a stale lock, the same mismatch lets `replaceFile` rename over an unrelated `Shot-01.mp4`, which is the overwrite the policy promises never happens.
- Fix:
  - On EEXIST in `unique` mode, move to the next candidate locally (`n++`) instead of re-deriving from the listing.
  - Cap the attempts, for example at 1000, and then throw.
  - Optionally, use `fs.openSync(dest, "wx")` on the final name itself as the reservation, so the OS decides what counts as a collision.

**L3. Deriving the name from the prediction id can merge different predictions, and `reuse` then returns the wrong file.**
- Code: `prediction-output.ts:242`, `client.ts:49` and `client.ts:194`.
- Issues:
  - Ids may be up to 128 characters (`PREDICTION_ID_RE`), but the name keeps only 64. Two ids with a common 64-character prefix share names.
  - An id that is empty after sanitizing becomes `"output"`, so every such prediction shares `atlas-output-NN`.
  - On win32/darwin, ids that differ only in case collide (`foldCase`).
  - The id used is the API response's `data.id || id` (`client.ts:194`), which is not validated.
- In each case `savedOutput` reports another prediction's file as "(already saved)" and the real output is never downloaded. The command exits 0.
- Real Atlas ids appear to be lowercase hex, around 32 characters (fixtures `47e7acf05d7449c1874f`), so the likelihood is low.
- Fix: validate `prediction.id` with `PREDICTION_ID_RE` before naming. If it fails, either throw, or fall back to the `unique` policy rather than `"output"` plus `reuse`. Raise the slice to 128; the name stays under 255 characters. The case question is in the unresolved questions below.

**L4. `savedOutput` treats any directory entry with the stem as a complete output.**
- Code: `prediction-runner.ts:425-432`.
- Problems:
  - A 0-byte file is accepted as saved and never fetched again. A 200 response with an empty body produces one, as does a `touch` or a copy that was cancelled part-way.
  - So is a directory named `atlas-<id>-01.png`.
- Downloads by this code are atomic (temp file plus rename), and the WebP temp `…webp.tmp-<pid>.webp` has a different stem, so this code itself never leaves a partial file under the final name. The gap is only externally created or empty files.
- Fix: in the filter, require `fs.statSync(p).isFile() && size > 0`.

**L5. A small TOCTOU remains between the "already saved" check and the claim.**
- Code: the check at `:301` runs before the fetch; the claim at `:500` runs after the headers arrive, and the check is not repeated.
- Scenario: run B starts while run A is downloading. B's headers arrive after A has renamed its file and released the lock, so B claims successfully, downloads again, and replaces the same bytes.
- If A's finalizer has meanwhile converted `.png` to `.webp` and deleted the `.png`, B writes the `.png` again and converts it over A's `.webp`. If B instead reused the `.png` just before A deleted it, B reports a path that no longer exists.
- Impact: wasted bandwidth only, with identical content, and the docs' "nothing is duplicated" still holds.
- Fix: in the `dest` callback, after a successful `reuse` claim, re-run `savedOutput(dest)`. If a file is found, release the lock and abort with a sentinel error that the caller treats as "already saved".

**L6. Optional part of the earlier L4: URL extensions are still trusted verbatim.**
- Code: `prediction-output.ts:175-178`.
- A hostile payload can still drop `atlas-<id>-01.bat`, `.hta` or `.lnk`. Nothing executes it.
- An output URL ending in `.part` produces `atlas-<id>-01.part`. `PART_SUFFIX` then hides it, so it is re-downloaded on every run.
- `audio/webm` maps to `webm`, which `EXT_CATEGORY` classifies as video. An audio-only WebM therefore triggers the thumbnail lookup and is treated as the "first video". Harmless.
- Fix: map extensions not in `EXT_CATEGORY` (plus `txt` and `svg`) to `bin`.

**L7. Commit hygiene.**
- The branch now has 9 commits: `wip(atlascloud): …` (`e77deba`), two `fix(atlascloud)` commits and six merge commits.
- `e77deba` and `23132b0` carry `Co-Authored-By` trailers.
- Squash-merge with a single `fix(atlascloud): …` message, so release-please and the user's "no AI references" rule both hold.

## Focus questions answered

- **Can a partial, corrupt or unrelated file be treated as saved?**
  - Partial: no. Both `.part` forms are filtered (`:428`), the finalizer temp has a different stem, and all writes are atomic renames.
  - Unrelated: only via id collisions (L3) or external empty files and directories (L4).
  - `_thumb` files have a different stem, so they never shadow outputs.
- **Is the prediction id sanitized safely?**
  - `[^a-zA-Z0-9_-]` is stripped, so `../`, `:`, `\` and `*` cannot appear.
  - The fixed `atlas-` prefix rules out reserved names such as `CON`, `NUL` or `COM1`.
  - The name is at most 64 + about 15 characters, so its length is fine.
- **How does the lock interact with #101's temp files?** They are distinct names (`<dest>.part` vs `<dest>.<pid>-<time>-<rand>.part`).
  - Both are excluded from `savedOutput`, and both count as taken stems in `availableOutputPath`.
  - The lock is released on success and on failure (`:506-514`), and the test at `:613-635` checks this.
  - If the claim throws, `lock` is never set, so another run's lock is never deleted. That is correct.
  - A crash leaves both files behind (M1).
- **Is `-N` limited to multi-output `--output <file>`?** Yes. `namingPolicy` (`:393-396`) gives:
  - no `--output` or a directory: `reuse`;
  - a single-output file: `overwrite`, with no lock, as the docs state;
  - a multi-output file: `unique`.
- **Are thumbnails under the same rules?** Yes. They use the same policy and URL validator (`checkOutputUrl`), take their URL from the outputs only (`thumbnailSource`), and `detectThumbUrl` requires http(s), after which `checkOutputUrl` refuses http.
- **Is SVG ever sent to WebP?** Never. `outputCategory(".svg")` is `"unknown"`, and only `downloaded` images are finalized (`:336`).
- **URL safety, logs and the worker-safe core:**
  - `checkOutputUrl` runs on every hop, and `data:` skips it only after a trimmed `/^data:/i` match.
  - Logs contain only `redactUrl(url)` and local paths; the lock error names a local path only.
  - `prediction-output.ts` still imports only `url-safety.js` and `models.js` (no `node:*`). The `fs` logic stays in the command layer.
- **Are the docs accurate?**
  - EN and VI match each other: the naming, the reuse, the overwrite and `-N` rules, the `.part` reservation, and the "delete the leftover `.part`" guidance.
  - README `:529-530` and SKILL `:141` agree with them.
  - Gaps: the orphaned temp file (M1) and that a retry must repeat `--output` (L1).

## Metrics
- Type coverage: no `any` added. The `NodeJS.ErrnoException` casts are fine.
- Lint and typecheck: CI green, not run locally.
- Tests: about 15 new or changed cases in `prediction-runner.test.ts:520-732` plus `cli-commands.test.ts`. All use stubbed fetch, assert on disk state, fetched URLs and warnings, and contain no phantom assertions.

## Recommended actions
1. M1: treat a lock whose PID is dead as stale, and mention the orphaned temp file. This can go in this PR or a follow-up issue.
2. L1: include `--output` in the retry hint.
3. L2: bound the `unique` loop and advance `n` on EEXIST.
4. L3 and L4: validate the id before naming, and require a non-empty regular file in `savedOutput`.
5. Squash-merge.

## Unresolved questions
1. Are Atlas prediction ids guaranteed lowercase and at most 64 characters? This decides whether L3 needs code or only a comment.
2. Does the id returned by `getPrediction` always equal the id returned at submit? If not, `run` and `status --download` would name the same output differently and break reuse.

Status: DONE_WITH_CONCERNS
Summary: Merge, with follow-ups. M1 and L1 to L6 from the previous review are fixed, and L7 (commit hygiene) is still open. New findings: Critical 0, High 0, Medium 1 (a stale lock after Ctrl+C breaks resume and orphans a multi-GB temp file), Low 7.
