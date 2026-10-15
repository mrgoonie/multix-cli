# Code review: image-format preflight (issue #234)

## Scope
- Files: `src/core/image-webp-finalize.ts` (+12), `src/commands/index.ts` (+2), `tests/unit/commands/image-format-preflight.test.ts` (new, 106 lines)
- Focus: uncommitted diff on branch `claude/gracious-heisenberg-s8d5rw`
- Scout: all 20 commands that add `imageFormatOption()`, every `finalizeGeneratedImages` call site, commander 12.1.0 hook dispatch, other `registerCommands` consumers (`worker/test/cli-program.ts`, `worker/scripts/build-cli-catalog.ts`)

## Verdict
The fix is correct and small. No blocking issues. The tests prove the fix: with the hook line removed, 21 of 23 cases fail; with it, all 23 pass.

## Answers to the review questions
1. **Root preAction for nested subcommands.** It fires. In commander 12.1.0, `_parseCommand` calls `this._chainOrCallHooks(promiseChain, 'preAction')` on the leaf command (command.js:1500). `_chainOrCallHooks` walks `_getCommandAndAncestors().reverse()` (1397-1418) and calls each hook as `callback(hookedCommand, this)`, so the second argument is the leaf action command. The hook runs after `_processArguments` and the mandatory/unknown-option checks, and before `_actionHandler`. `--help` exits before any hook runs (verified: exit 0).
2. **Error propagation.** It works. With no prior promise, `_chainOrCall` runs the hook synchronously. Its throw happens inside the `async parseAsync` (command.js:1090), so it becomes a rejection. `cli.ts` catches it and prints `Error: Invalid --image-format: webpp. Valid: webp, original` with exit 1. Verified with `dist/cli.js` for `gemini generate --image-format webpp` and for `MULTIX_IMAGE_FORMAT=png runway image`.
3. **opts() vs what finalize sees.** No false rejection on any path that finalizes. Every caller passes the same commander opts: either `{ ...opts, logger }`, or explicit `imageFormat: opts.imageFormat, webp: opts.webp` (replicate, runway, atlas runner). The only fields that differ are `explicitProviderFormat` and `output`. `resolveImageFormatMode` reads both only after the validity check, so neither can change accept/reject. `--no-webp` behaves the same in both places: `webp === false && imageFormat === undefined` returns before the env value is read (verified with the CLI and a test). `finalizeGeneratedImages` also resolves the mode when `files` is empty, so every path that reaches finalize was already subject to the same check. The exceptions are the paths that never reach finalize. See L1.
4. **Tests.** They discriminate: a negative control in a scratch copy with the hook removed fails 21/23. They walk the real registry, stub `fetch` to throw, and cover the env value plus the `--no-webp` override. Gaps are listed in L2.
5. **Conventions.** Kebab-case test file. No issue or plan IDs in code or comments. Biome is clean, `tsc --noEmit` is clean, the full vitest suite passes (1290 passed / 12 skipped), and the worker tests that build the real program pass (360). No `node:*` or worker-bundle impact: the module already imported `node:child_process` and `commander`, and the worker does not import it. No docs change needed, because the documented values are unchanged and only the timing of the error changes. See L3 for the branch name.

## Critical
None.

## High
None.

## Medium
None.

## Low
- **L1. The preflight now rejects paths that never finalize.** The hook keys on "the command declares the flag", not on "this run will finalize images". With an invalid `MULTIX_IMAGE_FORMAT` (for example from a project `.env`), these runs failed late or not at all before. They now fail up front:
  - `atlas status <id>` without `--download`: a free GET that used to print JSON. Verified: now `Error: Invalid --image-format: png`, exit 1.
  - `atlas <cmd> --no-download`: previously paid and printed URLs, with no finalize.
  - `atlas <cmd> --async`: previously paid. The later `status --download` would then fail after downloading, so failing early here is an improvement.

  Rejecting an invalid global setting early is defensible and keeps the hook simple. Recommendation: accept it, and state it in the PR body as an intended behavior change. Do not add per-command conditions.
- **L2. Test gaps (not blocking):**
  - No positive case showing that valid values pass the preflight: `--image-format original`, `WEBP` (case-insensitive), or empty env. Only `--no-webp` is shown to pass. A regression that made the hook reject everything would still pass the 21 rejection cases. Suggest one case per valid value that asserts the error is the missing key, not `Invalid --image-format`, as the `--no-webp` case does.
  - No case showing that a command without the flag (for example `runway video`) ignores a bad `MULTIX_IMAGE_FORMAT`. Verified manually: it proceeds to the key check.
  - `targets.length >= 17` is loose (20 are found today). Three commands could lose the option unnoticed. Consider `toBe(20)` or an explicit list. The `arrayContaining` of 4 commands only partly covers this.
  - The tests go through `parseAsync`, not the `cli.ts` catch. Exit code and message were verified manually with `dist/cli.js`. The smoke tests could add one case, but this is optional.
- **L3. Branch name.** `claude/gracious-heisenberg-s8d5rw` does not follow the `fix/<scope>-<slug>` convention in AGENTS.md. This is likely imposed by the harness. The issue claim comment and the `in progress` label are in place. Move the issue to `in review` per the workflow.

## Informational
- The check stays inside `finalizeGeneratedImages` too. That is fine as a second guard for direct callers, and it is not dead code.
- The hook is registered once, on the root, before the subcommands. There is no other `.hook(` in `src/`, so there is no ordering conflict.
- Hook placement: putting the hook next to `imageFormatOption()`/`noWebpOption()` in core keeps the flag's definition and its preflight in one module. This is acceptable.

## Plan follow-ups
- The issue #234 acceptance (reject before the paid request, for both the flag and the env value) is met for all 20 commands. Next steps: optional test hardening (L2), a PR note on L1, then move the issue label to `in review` and on to `done` once the PR is opened.

## Commands run
- `npx vitest run tests/unit/commands/image-format-preflight.test.ts`: 23/23 pass
- Negative control (scratch copy, hook removed): 21/23 fail
- `npx vitest run`: 75 files pass, 1290 tests pass
- `npm test --prefix worker`: 360 pass
- `npx biome check` (changed files): clean. `npx tsc --noEmit`: clean
- `dist/cli.js` with no credentials and `HOME` isolated: exits and messages as described above

## Unresolved questions
- Should `atlas status` without `--download` (and `--no-download` runs) tolerate an invalid `MULTIX_IMAGE_FORMAT`? Recommendation: no. This is a product call for the lead.
