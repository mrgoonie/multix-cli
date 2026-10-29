# Code review: derive tooling group lists from TOOLING_GROUPS (#438)

- Branch: `claude/gracious-heisenberg-htvhke` (commit `0c5e49b`), compared with `origin/dev` (`b7dd761`)
- Scope: `src/agent/agent-runtime.ts` only (+10/-14). `git diff --stat origin/dev HEAD` shows no other files changed.
- Verdict: no blocking findings. The change does not alter behaviour, as claimed. Adding `update` to `NO_DRY_RUN_GROUPS` changes no output (explained below).

## Verification

| Check | Result |
|---|---|
| `UNRECORDED` regex | The new `RegExp` source equals the old literal byte for byte: `^(history\|models\|guide\|rerun\|check\|update\|catalog)\b`. The `\\b` in the template string becomes `\b`, so word-boundary matching is unchanged. I tested `update`, `updater`, `catalogs x`, `check-x`, `history list`, `openrouter generation` and `""`: old and new regexes match the same strings. |
| Regex escaping | The group names are plain lowercase words with no regex metacharacters, so nothing needs escaping. |
| `NON_PROVIDER_GROUPS` | Same set as before: `TOOLING_GROUPS` plus `media` and `help`, nine entries, checked programmatically. `setCommand` sets the same provider label (`run.group`) as before. |
| `NO_DRY_RUN_GROUPS` (+`update`) | `update` is a leaf command (`src/commands/update.ts:63-70`) that defines its own `--dry-run`. In `addGlobalFlags`, `ownDryRun.add(cmd)` (line 117) runs whenever the flag exists, whatever `sendsRequests` is. Before this change, `sendsRequests` was only used to decide whether to add the global `--dry-run` (which the existing flag already prevented) and in `billable`. `billable` was already false through `NON_PROVIDER_GROUPS`. So `update` still ends up in `ownDryRun`, gets no cost flags, and line 450 `run.dryRun = ... && !ownDryRun.has(action)` still keeps `update --dry-run` on its own code path. |
| Flags on the built CLI | In `node dist/cli.js <group> --help`, `update` shows its own `--dry-run` and `--json` and no cost flags. `check`, `catalog`, `history`, `guide` and `models` show only `--json`. `rerun` keeps its own `--dry-run`. |
| History recording (isolated HOME, `MULTIX_DISABLE_HOME_ENV=1`, temp `MULTIX_HISTORY_FILE`) | `guide`, `catalog providers` and `models` with `--json` wrote no history file. `gemini analyze --dry-run --json` (dummy key, nothing sent) was recorded as `gemini analyze`, with group `gemini` and `dry_run: true`. |
| Other uses of the old literals | None in `src/`, `tests/`, `worker/` or `skill/`. The only mentions are in earlier review reports under `plans/reports/`, which are historical records. |
| Build / tests / lint | `npm run build` passed. `npx vitest run tests/smoke/agent-mode.test.ts` passed 21/21. `tsc --noEmit` reported no errors. `biome check` on the file is clean. |

## Critical
None.

## High
None.

## Medium
None.

## Low

1. **No test checks the flag surface of the tooling groups** (`tests/smoke/agent-mode.test.ts`). This refactor exists because the lists had drifted apart (#430 / #433). Nothing stops a later edit from splitting them again, or from removing `update`'s own `--dry-run`. If that flag were removed, `update` would silently lose dry-run support, because it is now in `NO_DRY_RUN_GROUPS`; before this change it would have fallen back to the global flag. Suggested fix: a smoke test that every entry in `TOOLING_GROUPS` gets no `--estimate`/`--max-cost` and is not recorded in history, plus one test that `update --help` still lists `--dry-run`.
2. **`TOOLING_GROUPS` is a mutable `string[]`** (line 51). Marking it `as const` or `readonly string[]` would make its role as the single source of truth explicit and prevent accidental mutation at runtime. This is cosmetic.
3. **The regex is built from names without escaping** (line 53). This is safe for the current names. If a future group name contains a metacharacter, it would silently change what the regex matches. A one-line note in the comment, or escaping each name, removes this risk. Optional.

## Informational
- In `billable` (line 121), `!NON_PROVIDER_GROUPS.has(group)` now only matters for `help`. Every other non-provider group is already excluded by `sendsRequests` or `LOCAL_GROUPS`. This is harmless and was already true before this change.
- The commit type is `refactor(agent)`. Under `release-please-config.json`, `refactor` has a visible changelog section, so merging into `main` publishes an npm version even though behaviour does not change. Confirm that this is intended, or use `chore`/`refactor` according to repo practice.

## Unresolved questions
- None blocking.
