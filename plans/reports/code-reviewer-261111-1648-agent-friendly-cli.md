# Code review: PR #594 feat(cli): agent-friendly `multix -V` and `multix skills`

Branch `feat/agent-friendly-cli` (a60d29f) vs `origin/main` (d421198). Read-only review.
Note: local `main` is stale; diff vs local `main` drags in #584/#587/#588. Use `origin/main...HEAD` (14 files, +281/-4).

## Verification run

- `npm run build`, `npm run lint` (clean), `npm run typecheck` (clean)
- `vitest run tests/unit/commands/agent/skills-command.test.ts tests/smoke/cli.test.ts`: 33 passed
- `npm run check:mcp`: passes, bundle clean
- `npm pack --dry-run`: 7 `skill/**` files included (`package.json` `files` has `skill`; `.npmignore` does not exclude it)
- Installed layout: `npm pack` → extracted to `<scratch>/inst/node_modules/@mrgoonie/multix`, bin symlink to `dist/cli.js`, run from `/tmp`: `skills --json` lists all 7, `skills multix --path` resolves to the package's own `skill/SKILL.md` (symlink resolved via `import.meta.url`)
- Manual: `node dist/cli.js -V | wc -c` = 1051 bytes (complete, no truncation); `-V --json`, `--json -V`, `skills`, `skills --json`, `skills nope --json` (exit 2, INVALID_INPUT)

## Findings (by severity)

### High

1. **Needs owner sign-off (design decision, not a defect): `--version` stdout now multi-line** — `src/cli.ts:27-32`.
   Original choice (stated in the PR/brief and code comment): line 1 = bare version, then the orientation block, on stdout.
   Concern: `multix --version` / `-V` used to print exactly `X.Y.Z\n`; now ~1 KB / 16 lines. `multix -V | head -1` still works, but `v=$(multix --version)`, semver comparisons, install checks, CI version gates and external tooling probing `<bin> --version` break. No in-repo consumer breaks (grep: `update.ts` uses `program.version()`; container/CI do not parse it). Shipped as `feat` (minor), no changelog note that the output changed.
   Options: (a) keep as is, but call it out in the changelog (or `feat!` if treated as breaking); (b) keep stdout = bare version and write `AGENT_INTRO` to stderr (agents read both streams; `$(...)` stays clean); (c) separate flag/command for the intro (`--help` already ends with it). TTY-gating is not a good option: agents are non-TTY like scripts. Whichever is chosen, the smoke test `tests/smoke/cli.test.ts:305-313` should pin it.

2. **`--json` one-line contract broken for `-V`** — `src/cli.ts:30` (`writeSync(1, …)` bypasses `captureStreams()` in `src/agent/agent-runtime.ts:191`).
   Observed: `multix -V --json` and `multix --json -V` print version + intro as raw text, **then** the `multix.result/v1` envelope (process.exit is wrapped → `finalizeRun`). With `MULTIX_OUTPUT=json` (documented global switch), a bare `multix -V` emits mixed text+JSON on stdout. `skill/SKILL.md:20` promises "stdout = ONE line". Baseline: commander's default handler (`node_modules/commander/lib/command.js:2078-2081`) writes via `_outputConfiguration.writeOut` = `process.stdout.write` (line 61), which the runtime captures in JSON mode, so on main stdout was the single envelope (verified by code reading; main build not executed).
   Fix: in JSON mode write through `process.stdout.write` (captured) or skip the custom write; ideally emit `{version, start_here:[...]}` as envelope `data`.

### Medium

3. **Bare `writeSync` raises EPIPE as a classified error** — `src/cli.ts:30`. Reproduced: `node dist/cli.js -V | true` 20/20 runs print `Error: EPIPE: broken pipe, write / code: UNKNOWN / hint: …` on stderr and exit 1 (main behavior with commander's async write not tested). `| head -1` is clean (head reads the whole 1 KB). The runtime already has `writeOut()` (`src/agent/agent-runtime.ts:222-233`) with an EAGAIN loop that swallows other write errors; reuse/export it instead of a parallel raw `writeSync`. No truncation observed (`-V | wc -c` = 1051, complete).

4. **`skillsDir()` candidates walk outside the package** — `src/commands/agent/skills-command.ts:28`.
   From `dist/cli.js` the correct hit is `../skill`. `../../skill` is dead for both layouts (source needs `../../../skill`), and from an install `node_modules/@mrgoonie/multix/dist`, the fallbacks resolve to `node_modules/@mrgoonie/skill` and `node_modules/skill`, i.e. another package's directory, if the package's own `skill/` were ever missing. `multix skills <name>` would then print an unrelated SKILL.md as authoritative agent instructions. Low likelihood, but cheap to close: resolve once relative to the package root (same approach as `pkg` via `createRequire` / `package.json` location) and verify `name: multix` in the entry front matter.

### Low

5. **Docs start list differs slightly from the intro** — `docs-site/src/content/docs/commands.md:11` (+ `vi/`) list `multix guide`, `multix models --ready`, `multix skills`; `AGENT_INTRO` (`src/commands/agent/agent-intro.ts:14-19`) also lists `multix check` and uses `--task <task> --ready`. `multix models --ready` is valid (the runtime emits it). Cosmetic; if #1 moves the intro to stderr, docs must say so.

6. `multix skills --path` without a name silently ignores `--path` and lists — `skills-command.ts:77-91`. Either reject (`ValidationError`) or print the skills dir.
7. `parseSkillFrontMatter` is a regex re-implementation alongside `worker/scripts/skill-catalog-builder.ts`; quoted/folded YAML (`description: "..."`, `>`) would surface raw quotes/`>`. Current files are all flat unquoted, so fine today; worth a test pinning the assumption (the worker test already enforces single-line valid YAML).
8. `AGENT_INTRO` is also appended to root `--help` (`src/cli.ts:34`). Not mentioned in the PR scope / docs; fine but undocumented.

## SKILL.md troubleshooting claims: verified against code

| Claim (skill/SKILL.md:32-48) | Verdict | Evidence |
|---|---|---|
| Exit 3 + `error.env` names key | OK | `EXIT_CODES.config=3`, `MISSING_KEY`→3, `ErrorInfo.env` (`src/core/error-classify.ts:48-74,107`); envelope `error` = `ErrorInfo` minus `exit_code` (`src/agent/agent-runtime.ts:449`) |
| BytePlus `BYTEPLUS_API_KEY` or `ARK_API_KEY` | OK | `src/providers/byteplus/models.ts:20` |
| Exit 6 = job may still run, follow status cmd | OK | `TIMEOUT`/`UNKNOWN_REMOTE_STATE`→6 |
| Exit 4 → `multix rerun <id>` only when `next[]` offers it | OK | `result-envelope.ts:140-143` (RATE_LIMITED/NETWORK/UNAVAILABLE→4, rerun only with historyId; suppressed with in-flight/partial, `agent-runtime.ts:385-396`) |
| `--max-cost`; unknown price refused `BUDGET_UNPROVEN` | OK | `src/budget/command-cost.ts:381-393` |
| `EMPTY_OUTPUT`, `CONTENT_MISMATCH`, `UNREADABLE_MEDIA` warnings | OK | `src/agent/output-file-inspect.ts:26` |
| `status: "missing"` for dropped verified model | OK | `src/capabilities/model-views.ts:25,93` |
| `multix update --check` | OK | `src/commands/update.ts:67` |
| OpenRouter `/api/v1/images` fallback since 1.26.1; `--strength` and `OPENROUTER_FALLBACK_MODELS` not applied there | OK | CHANGELOG 1.26.1; `ImagesEndpointRequest` has neither field (`src/providers/openrouter/images-endpoint.ts:29-37`) |
| `multix guide` matches installed version | OK | compiled into the CLI |
| `multix -V` "version and where to start" | OK but see #1/#2 |

No phantom claims found.

## Worker / MCP exclusion

- `skills` added to `EXCLUDED_COMMANDS` (`worker/src/jobs/cli-command-policy.ts:132`), `UTILITY_COMMANDS` (`src/capabilities/command-capabilities.ts:177`), `TOOLING_GROUPS` (not recorded in history, no global dry-run/cost flags). Correct.
- `worker/src/cli-catalog.json` regenerated with the `skills` group, consistent with `guide`/`models` also being present (catalog lists excluded commands too). `check:mcp` passes.
- Skill text changes ship to the Worker MCP skills catalogue; remote agents will now read `multix -V` / `multix skills` instructions that only apply to a local CLI. Acceptable (rest of SKILL.md is CLI-oriented too) but `AGENT_INTRO`'s "MCP server serves the same skills" line is accurate (`worker/src/mcp-server.ts:10`).

## Scope / AI-risk lens

- Scope tight; no unrelated files. Tests are real (spawn built CLI, assert exit codes, content), not phantom.
- Smoke test codifies the contract regression in #1 rather than catching it.

## Recommended actions

1. Owner decision on #1 (keep + changelog note / stderr / separate flag).
2. Make `-V` honor JSON mode: single envelope line (#2).
3. Replace bare `writeSync` with the runtime's `writeOut` (#3).
4. Anchor `skillsDir()` to the package root; drop out-of-package fallbacks (#4).
5. Align docs start list (#5); handle `--path` without a name (#6).

## Unresolved questions

- Is the multi-line `--version` stdout an accepted public contract change (#1)?
- Main-branch `-V --json` and `-V | true` behavior established from commander source, not executed on a main build.

Status: DONE_WITH_CONCERNS
