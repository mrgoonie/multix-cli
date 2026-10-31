# Code review: producedFiles() reports output dir under tmp (issue #496)

## Scope
- src/agent/output-file-tracker.ts, src/core/output-dir.ts, src/agent/agent-runtime.ts, tests/unit/agent/output-file-tracker.test.ts (new)
- Checks: `vitest run tests/unit/agent/` 59/59 pass; typecheck clean; biome clean on touched files.
- Scratch writers in src: stdin-file.ts:224 (`multix-stdin-*`, file kept until exit, tracked via renameSync), codex-image-driver.ts:88, topview/node-inputs.ts:138, media-rule.ts:84 (all `mkdtemp(os.tmpdir())`, removed before finalize), media-frames.ts:88 (`.frames-*` staging inside outDir, renamed out/removed). None writes into the output dir except media-frames staging, which is removed before finalize. No scratch files written directly in the tmp root.

## Assessment
The fix resolves #496 for the common cases (MULTIX_OUTPUT_DIR = subdir of tmp, = tmp root, cwd under tmp with default multix-output, macOS /var -> /private/var since both sides are realpath'd). One real regression: an output root that is an ancestor of os.tmpdir().

## High
1. Output root that contains the temp dir leaks CLI scratch files — src/agent/output-file-tracker.ts:86-87.
   `requested()` special-cases only `root === tmp`. If the root is an ancestor of tmp (TMPDIR=/tmp/user/1000 from pam_tmpdir/systemd, with MULTIX_OUTPUT_DIR=/tmp or `--output-dir /tmp`; or TMPDIR=$HOME/tmp with `--out-dir ~`), `isWithin(dir, root)` is true for every scratch dir, so e.g. the stdin temp file is reported in `outputs` and the history ledger. Before this change it was always excluded.
   Reproduced: TMPDIR=/tmp/rv-anc/user1, MULTIX_OUTPUT_DIR=/tmp/rv-anc -> producedFiles() returned `/tmp/rv-anc/user1/multix-stdin-XXXX/stdin.png`.
   Fix: treat any root that contains tmp like the tmp-root case, e.g.
   `roots.some((root) => isWithin(tmp, root) ? dir === tmp && root === tmp : isWithin(dir, root))`
   (or allow `dir === tmp` for any ancestor root only if desired). Add a test with a nested TMPDIR.

## Medium
2. `isWithin` prefix check — output-file-tracker.ts:70. `rel.startsWith("..")` rejects legitimate children whose name starts with `..` (e.g. `out/..cache/a.png`). Reproduced: returns []. Use `rel === ".." || rel.startsWith(".." + path.sep)`. Low real-world impact, but this is the exact prefix bug class the helper exists to avoid.
3. Test gaps — tests/unit/agent/output-file-tracker.test.ts:
   - No positive case for the tmp-root rule (a direct child of tmp with MULTIX_OUTPUT_DIR=os.tmpdir() must be reported); only the negative case is tested.
   - No ancestor-of-tmp case (finding 1).
   - No test for the agent-runtime.ts:265 wiring (`run.options.outputDir`/`outDir` -> producedFiles); a rename of either option would go unnoticed. finalize-run-cancel.test.ts exercises finalizeRun and could cover it.
   - No symlinked-root test (MULTIX_OUTPUT_DIR given via a symlink into tmp). Logic looks right (realDir on both sides) but is unproven.

## Low
4. output-dir.ts: `resolveOutputDir()` returns the cached value when set, else recomputes from env/cwd. If cwd or env changes after getOutputDir() ran, they can differ; that matches getOutputDir's own memoization, so fine.
5. realpathSync is the JS variant; on case-insensitive filesystems a differently cased MULTIX_OUTPUT_DIR will not match. Pre-existing class of issue, not worth fixing here.
6. Pre-existing, out of scope: `file.startsWith(state)` (line 90) also matches `~/.multix-foo`. Open a separate issue if wanted.

## Docs impact
None needed: restores documented behavior of `--json` outputs.

Status: DONE_WITH_CONCERNS
Summary: Fix is correct for the reported scenario and for the tmp-root and macOS symlink cases; an output root that is an ancestor of os.tmpdir() now leaks CLI scratch files into outputs (reproduced).
Concerns:
- src/agent/output-file-tracker.ts:86-87 ancestor-of-tmp root leaks scratch files (High)
- src/agent/output-file-tracker.ts:70 `..`-prefixed child names rejected (Medium)
- tests/unit/agent/output-file-tracker.test.ts missing positive tmp-root, ancestor, runtime wiring, symlink tests (Medium)
