# Code review: output-file-tracker tests on Windows (#519)

Isolated review of `tests/unit/agent/output-file-tracker.test.ts` (stub `TEMP`/`TMP` and `USERPROFILE` next to `TMPDIR`/`HOME`). The reviewer returned its findings in chat; this file records them.

## Verdict
The fix addresses the root cause. No Critical, High or Medium findings.

## Evidence
- Node docs (`os.tmpdir()`, `os.homedir()`): on Windows `os.tmpdir()` reads `TEMP` then `TMP` and never `TMPDIR`; `os.homedir()` reads `USERPROFILE` and never `HOME`. Setting `process.env` on Windows updates the process environment, so libuv's `uv_os_homedir` sees the stub.
- CI run 40871584524, windows-latest: the four failures match exactly. `tmp` stayed `C:\Users\RUNNER~1\AppData\Local\Temp`, so scratch files under `base` were counted; `state` stayed under the real home, so `base\.multix\...` was not dropped.
- Other Windows risks checked and ruled out:
  - 8.3 short paths: the test and the source both use `fs.realpathSync`, and the five unstubbed tests already pass on Windows.
  - Path case: `path.win32.relative` compares without regard to case.
  - Trailing separators.
  - Env-name case on Windows.
  - `vi.unstubAllEnvs()` restore.
  - `resolveOutputDir()` does not read `HOME`.
- Linux: 9/9 pass; biome clean.

## Low
1. There is no Windows run on the branch yet. Treat a green Windows job on `dev` after merge as the evidence.
2. The branch name was reused by earlier, squash-merged PRs, so `git log origin/dev..HEAD` lists commits already merged. The content diff is clean; squash-merge.
3. Other tests already stub `TEMP`/`TMP`/`USERPROFILE` inline (`tests/unit/core/stdin-file.test.ts`, `tests/unit/commands/doc-convert.test.ts`, `tests/unit/providers/fal/commands.test.ts`). A shared helper would be a separate change.

## Out of scope (separate issue)
`track()` in `src/agent/output-file-tracker.ts:18` records `URL.pathname` for a `file:` URL:
- On Windows this is `/C:/...` (and percent-encoded on every OS), so it is compared wrongly against the temp and state dirs.
- `fileURLToPath` is the fix.
- `untrack()` also ignores URLs.
