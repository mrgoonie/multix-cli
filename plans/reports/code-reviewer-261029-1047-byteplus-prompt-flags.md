# Code review: BytePlus Seedance prompt-flag injection (issue #454)

Date: 2026-10-29 (UTC). Base: origin/dev (HEAD f96162b), uncommitted diff, 7 files, +70/-1.
Reviewer: isolated code-reviewer (did not write the change). No source files modified.

## Scope
- worker/src/jobs/cli-command-policy.ts (new `promptFlagOptions`, `SEEDANCE_PROMPT_FLAGS`, applied to 3 commands)
- worker/src/jobs/run-argv-builder.ts (`PROMPT_FLAG_RE = /--[a-z]/i`, refusal in `prepareRun`)
- worker/src/jobs/catalog-view.ts (format hint)
- worker/test/run-argv-builder.test.ts, worker/test/cli-catalog.test.ts
- docs-site/src/content/docs/guides/mcp-server.md, docs-site/src/content/docs/vi/guides/mcp-server.md

## Verification run
- `npx vitest run test/run-argv-builder.test.ts test/cli-catalog.test.ts` (worker): 81/81 pass.
- `npx biome check` on touched worker files: clean.
- `npx tsc --noEmit -p worker`: clean.
- Full `npm test` / `check:mcp` / `verify:docs` not run by the reviewer.

## Path trace: every text that reaches content[0].text
`buildVideoTaskBody` (src/providers/byteplus/generators/video.ts:40-57) in flags mode builds
`${prompt} --rs R --dur D --rt A --cf C --seed S --wm W negative: "N"`.

| Field | Remote control | Safe? |
|---|---|---|
| prompt | `promptFlagOptions` | Covered by the diff |
| negative | `promptFlagOptions` | Covered by the diff |
| aspect-ratio | `promptFlagOptions` | Covered by the diff (previously free text, no allowlist) |
| resolution | `applyCaps` allowlist, run-option-caps.ts:93-97; `normaliseResolution` regex is anchored, JS `$` without `m` does not match before a newline | Safe: only allowed values pass |
| duration | `PLAIN_NUMBER_RE` on trimmed value, run-option-caps.ts:39-46,64-73; CLI `parseInt` | Safe: numeric only |
| seed | CLI `Number.parseInt` (video.ts command line ~71) yields a number | Safe |
| camera-fixed / audio | boolean flags (`optionValue` rejects non-boolean) | Safe |
| model | goes to `body.model`, not text | Safe for text injection |
| ref-image/video/audio, image positional | file targets from `inputs`; server writes local paths; roles not caller-controlled and not in text | Safe |

Bypass attempts checked:
- Option aliases / short flags: `options` map is keyed by long name (`optionName`, cli-catalog.ts:39), so `-m` or `m` is "Unknown option". Leading dashes on the key are stripped before lookup, so `"--prompt"` maps to `prompt` and is checked. `aspectRatio` (camelCase) is unknown. No bypass.
- Command aliases `i2v` / `r2v`: `CatalogIndex.find` indexes only canonical names (cli-catalog.ts:21-31), so aliases are "Unknown command". No bypass to the empty default policy.
- Array values: `prompt`, `negative`, `aspect-ratio` are not repeatable, `optionValue` rejects arrays (run-argv-builder.ts:120-121); the check uses `.some` anyway.
- Number values: converted to string by `scalar`, no `--` possible.
- Positionals: `byteplus video` / `reference-to-video` have none; `image-to-video`'s `image` is a file positional (inputs only, no asset refs).
- `BYTEPLUS_VIDEO_PARAMS_MODE`: the container env is built from PATH/HOME/MULTIX_* plus `spec.env`, and `spec.env` keys must match `KEY_NAME_RE` (worker/container/job-runner.mjs:26-27,45,141-151). The mode env cannot reach the CLI, so remote runs are always in flags mode, which is the case the fix targets. HOME is the throwaway job dir and `MULTIX_DISABLE_HOME_ENV=1`.
- Other worker paths that build Seedance bodies: none. `buildVideoTaskBody` is imported only by the three byteplus commands; worker/src has no native BytePlus video tool.

## Findings

### High

H1. Sibling bypass: `byteplus generate-3d` can submit a Seedance video task with uncapped duration/resolution, and `byteplus status --download` can fetch it.
- worker/src/jobs/cli-command-policy.ts:235 — `"byteplus generate-3d": { fileOptions: { "input-image": "file" } }`: no caps, no `uncappedSpend`, no model restriction.
- src/providers/byteplus/commands/generate-3d.ts:74-79 passes `opts.model` unchecked; src/providers/byteplus/generators/three-d.ts:36-55 builds `{ model, content: [{ type: "text", text: "<prompt> <flags>" }] }` and posts to the same `/contents/generations/tasks` endpoint (three-d.ts:62) as Seedance video. `--flags` is a documented raw pass-through appended to the text.
- Path: `multix_run { command: "byteplus generate-3d", options: { model: "<seedance video model id>", prompt: "a cat", flags: "--dur 15 --rs 1080p", async: true } }` -> task id; then `multix_run { command: "byteplus status", args: [id], options: { download: true } }`; status.ts:54-56 accepts `content.video_url` and downloads it into the job output.
- The request body is the same shape the CLI already sends for `byteplus video` in flags mode, so the provider-side acceptance is very likely, but not live-verified by this review (no paid call made).
- Impact: the operator caps that #454 restores (MULTIX_MCP_MAX_VIDEO_SECONDS, MULTIX_MCP_ALLOWED_RESOLUTIONS) are still bypassable for BytePlus with one extra step. Pre-existing, not introduced by this diff, but it defeats the stated goal of the fix.
- Fix options (pick one): (a) on the server, restrict `generate-3d --model` to the ids in `BYTEPLUS_3D_MODELS` (src/providers/byteplus/models.ts:40-43), e.g. a new allowed-values policy field or a check in prepareRun; (b) mark `byteplus generate-3d` `uncappedSpend` so MULTIX_MCP_UNCAPPED_SPEND applies; (c) in the CLI, refuse a model outside the 3D family (weaker: blocks legitimate new 3D model ids unless the list is maintained). Per AGENTS.md this can be a separate issue, but #454 should not be described as closing the BytePlus cap bypass until it is handled or explicitly tracked.

### Medium

None.

### Low

L1. False positives on natural text. `/--[a-z]/i` (run-argv-builder.ts:59) refuses ASCII double-hyphen used as a dash before a word, e.g. `"slow--then fast"`, `"well--lit"`, or prompts quoting CLI text. Acceptable trade-off for remote runs (error message is explicit and names the fix), and `-- then` (with a space) still passes per the new test. No change needed; consider mentioning "use a space or an em dash" in the error text.

L2. Catalog hint untested. worker/src/jobs/catalog-view.ts:71 adds `format: 'no "--" followed by a letter'`, but no test asserts it. It also silently overwrites a `nameOptions` format if an option is ever in both lists (not the case today). Optional: one assertion in an existing catalog-view test.

L3. Test coverage gaps (minor). Tests cover prompt (`byteplus video`), negative with uppercase `--DUR` (`image-to-video`), aspect-ratio (`reference-to-video`), plus one allowed-dash case. Missing: a prompt given under the key `"--prompt"` (dash-stripped path) and a prompt that starts with the flag (`"--rs 1080p cat"`). Low value; current tests do prove the behavior, they are not phantom.

L4. Docs omit seed/camera-fixed/audio from the list of values sent as tokens (docs-site/.../guides/mcp-server.md:182-189 and the VI mirror). Harmless for the cap story because those are numeric/boolean; wording is otherwise accurate and EN/VI match.

### Informational (out of scope, open a separate issue if confirmed)

I1. src/providers/byteplus/generators/video.ts:46 maps `audio` to `--wm` (the Seedance watermark flag name in BytePlus's text-parameter convention), not to an audio parameter. Not verified against current BytePlus docs here; worth a check since `--audio/--no-audio` may not do what the help text says.

## Edge cases considered (scout)
- Leading/trailing whitespace in resolution/duration: trimmed for validation; CLI parseInt / allowlist values cannot carry `--` tokens.
- Newline before `--dur` in prompt: still matched by the unanchored regex.
- Unicode dash look-alikes (U+2014, U+2212, full-width hyphen): not refused. No evidence BytePlus parses them as flags; not reported as a finding.

## Plan / issue follow-up
- #454 core fix (prompt, negative, aspect-ratio for the three Seedance commands): complete and correct.
- Remaining before claiming the BytePlus cap bypass closed: H1 (fix in this PR or open a linked issue).

Status: DONE_WITH_CONCERNS
Summary: The diff correctly closes every caller-controlled text path into the Seedance prompt for the three video commands (resolution, duration, seed, model and booleans are already safe; aliases, arrays, positionals and the params-mode env cannot bypass it). A concrete sibling bypass remains through `byteplus generate-3d` (unrestricted model + raw `--flags`) followed by `byteplus status --download`.

Findings ranked by severity:
1. High H1 worker/src/jobs/cli-command-policy.ts:235, src/providers/byteplus/commands/generate-3d.ts:74-79, src/providers/byteplus/generators/three-d.ts:36-62, src/providers/byteplus/commands/status.ts:54-56 — generate-3d submits Seedance tasks with uncapped flags.
2. Low L1 worker/src/jobs/run-argv-builder.ts:59 — `--word` false positives in natural text (acceptable).
3. Low L2 worker/src/jobs/catalog-view.ts:71 — hint untested, can overwrite nameOptions format.
4. Low L3 worker/test/run-argv-builder.test.ts:494-515 — small coverage gaps.
5. Low L4 docs-site/src/content/docs/guides/mcp-server.md:182-189 (+ VI) — token list incomplete, accurate otherwise.
6. Info I1 src/providers/byteplus/generators/video.ts:46 — `audio` mapped to `--wm`.
