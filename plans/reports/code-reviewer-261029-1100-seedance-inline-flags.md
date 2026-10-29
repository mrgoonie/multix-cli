# Code review: 49cc4b9 fix(mcp): refuse Seedance model flags in multix_run prompt text

- Branch: `claude/relaxed-clarke-lunwg6` (base `origin/dev`), issue #454
- Files: worker/src/jobs/{run-argv-builder,cli-command-policy,catalog-view}.ts, worker/test/{run-argv-builder,cli-catalog}.test.ts, docs-site guides/mcp-server.md (EN + VI). +81/-4.
- Verification run: `npx vitest run test/run-argv-builder.test.ts test/cli-catalog.test.ts` 85/85 pass; `biome check` on changed files clean; `tsc --noEmit -p worker` clean.

## Verdict

The code is correct and closes the reported path. **It should not be merged as-is, for a process reason (B1), not a code one.** Every finding below is optional except B1.

## Blocking

### B1. Duplicate of an earlier claim on #454 (AGENTS.md issue workflow, step 3)
The comments on #454 (REST, `gh api repos/mrgoonie/multix-cli/issues/454/comments`):
- 10:47:29Z `workspace-a6` (session_01FL32rv3Ar...), branch `claude/relaxed-clarke-lksvml`
- 10:47:32Z `workspace-c8`, branch `claude/relaxed-clarke-lunwg6` (**this commit**)
- 10:47:35Z `workspace-51`, branch `claude/relaxed-clarke-f06f73`

AGENTS.md: "The claim listed first on the issue wins. If an earlier claim exists, stop and support it." The earlier branch is pushed (`89d0a28 fix(mcp): refuse model-flag tokens in BytePlus Seedance prompt text`, 10:50:05Z, also `Closes #454`). Its approach is the same (a policy option list `promptFlagOptions` = prompt/negative/aspect-ratio and a `--`-then-letter refusal). If both PRs are opened, they conflict on the same lines in four files.
Failure path: two PRs close #454; whichever merges second conflicts. Or both land, with two names for one policy field.
Fix: do not open a PR from this branch. Post a `Released` comment on #454 that links 89d0a28. Carry over any evidence it lacks: this branch has six rejection cases (a space after `--`, upper case `--DURATION`, `--frames`, a negative closing a quote, aspect-ratio, each of the three commands) plus a test that ordinary dashes are kept, against 26 test lines there. Offer those as review input on the a6 PR.
Also, AGENTS.md says to branch from `main`, using `fix/<scope>-<slug>`. This branch is `claude/...` off `dev`. That is probably the routine's convention, so I am noting it rather than blocking on it.

## Coverage of caller text that reaches Seedance `content[0].text` (check 1)

In flags mode, `buildVideoTaskBody` (src/providers/byteplus/generators/video.ts) builds:
`${prompt} --rs ${resolution} --dur ${duration} --rt ${aspectRatio} --cf ${cameraFixed} --seed ${seed} --wm ${audio} negative: "${negative}"`

| Input | Path to the text | Covered? |
|---|---|---|
| `--prompt` | raw | yes, by the new check |
| `--negative` | raw, inside quotes | yes, by the new check (a quote break is tested) |
| `--aspect-ratio` | raw after `--rt` | yes, by the new check (the worker has no allow-list for it) |
| `--resolution` | raw after `--rs` | yes, already: `applyCaps` uses `normaliseResolution`, which is anchored (`/^(?:resolution_)?(\d{3,4})p?$/`). `"720p --dur 12"` stays as-is and is not in `allowedResolutions`, so it is refused. |
| `--duration` | `Number.parseInt` | yes, already: `PLAIN_NUMBER_RE` |
| `--seed` | `Number.parseInt` in the CLI | safe: `"5 --dur 12"` becomes 5, and `"--dur"` gives `NaN`. Neither can inject text. The worker does not validate seed, so `--seed NaN` can reach the provider. That is harmless for the caps. |
| `--model` | `body.model` only | not in the text |
| `--camera-fixed`, `--audio` | booleans | not free text |
| positionals | `image` is a file positional, and the other two commands have none (extra args give "Too many args") | not in the text |
| ref-image/video/audio, last-frame | `image_url`/`video_url`/`audio_url` items, not text | not in the text |
| `BYTEPLUS_VIDEO_PARAMS_MODE` | env | the caller cannot set it: `jobEnv` passes only `GROUP_KEYS.byteplus` (`BYTEPLUS_API_KEY`, `ARK_API_KEY`), and the container env is a fixed list plus `spec.env`. The container always uses flags mode. |
| duplicate keys (`prompt` and `--prompt`) | both become `prompt` | each entry is checked before `values.set`, so both are checked |

Conclusion: no uncovered path to the text.

## Optional

### O1. Unicode look-alikes and invisible characters get past the regex (check 2). Low, not shown to work.
I tested these with node. `/--\s*[A-Za-z]/` does NOT match:
- `--​dur 12`: a zero-width space is Cf, not `\s`
- `-­-dur 12`: a soft hyphen
- `−−dur`, `––dur`, `－－dur`, and an em dash `—dur`
- `--ｄur`: a full-width letter

These only matter if BytePlus normalises the text (NFKC, or stripping Cf characters) before it parses flags. Nothing in the repo or the issue shows that it does, so I am not blocking on it. A cheap hardening step: run the check on `v.normalize("NFKC").replace(/[\p{Cf}]/gu, "")`, and add `‐-―−﹘﹣－` to the dash class. The check would then refuse anything Seedance could plausibly fold back to `--`. A U+00A0 between the dashes and the name is already caught, because `\s` covers it.

### O2. False positives on ordinary prose (check 3). Medium usability cost.
These are refused (tested):
- `"the city at night--neon lights"`: ASCII `--` used as an em dash, which is common in typed and LLM-written prose
- `"a cat -- then it jumps"`
- markdown rules such as `"---\nScene 2"`

The error says "must not contain model flags such as --dur or --rs; set them with their own options". An agent that wrote `night--neon` will not understand that message, and may retry the same text.
Fix: change the message to name the rule, for example: `--prompt must not contain "--" followed by a letter (Seedance reads it as a model flag); use an em dash or a single "-"`. The competing branch's catalog hint `'no "--" followed by a letter'` is more precise than `"no model flags such as --dur"`. Keep the broad regex. Narrowing it to a leading space would rely on undocumented BytePlus parsing.

### O3. Test gaps (check 4)
The tests do prove the refusal. Each of the three commands is covered, each of the three options too, the spaced and upper-case variants, and one passing case with ordinary dashes and an em dash. The `cli-catalog` test now also checks that the `inlineFlagOptions` names exist in the catalog, so a renamed CLI option would be caught. Gaps:
- No `--`+newline case (`"a\n--\ndur 12"`). The `\s` handles it, but a test would keep it handled.
- No catalog-view assertion for the new `format` hint.
- No test that `--resolution "720p --dur 12"` and `--seed "5 --dur 12"` stay safe. The fix's claim to cover the whole text rests on these existing guards.

### O4. Docs (check 5)
EN and VI say the same thing, and the Vietnamese is accurate. Two problems:
- Both say a value "that carries its own model flag" is refused. The rule is broader: any `--` followed by a letter. Readers will hit O2 without warning. Suggest: "refuse a `--prompt`, `--negative` or `--aspect-ratio` that contains `--` followed by a letter (Seedance reads such text as a model flag, such as `--dur 12`)".
- In the VI file, the edited line was not re-wrapped (`...và giá trị \`@file\` bị từ chối. Lệnh thay đổi chính tài khoản provider của bạn (ví`, about 110 characters). This is cosmetic.
The README "Remote MCP server" section and skill/SKILL.md do not list per-command restrictions, so leaving them unchanged is consistent. `multix_catalog` shows the hint to agents through `view.format`.

### O5. Pre-existing bug seen while reviewing: `--audio` is sent as `--wm` (watermark)
In `buildFlagSuffix`, `if (opts.audio !== undefined) parts.push(\`--wm ${opts.audio}\`)`. In Seedance's text commands, `--wm` is the watermark flag, so in flags mode `--audio`/`--no-audio` toggles the watermark instead of the audio. This is outside the scope of #454. Per AGENTS.md, open a separate issue; do not widen this PR.

## Checklist
- Concurrency: none. This is pure synchronous validation.
- Error boundaries: a `ValidationError` is thrown before the job starts, consistent with the existing checks.
- API contract and backward compatibility: Seedance prompts that contain `--letter` are now refused on the remote server. That is an intended tightening; the local CLI is unchanged.
- Auth, data leaks, N+1: not affected.
- Conventions: Biome and tsc are clean. Commit type `fix(mcp)` publishes a release, which is appropriate. `Closes #454` is present. AGENTS.md lists `npm run check:mcp` for worker changes; I ran only the focused tests.

## Recommended actions
1. (Blocking) Release this branch's claim in favour of workspace-a6's `claude/relaxed-clarke-lksvml`, and offer the extra test cases there.
2. Wherever the fix lands: make the error message and docs state the actual `--`+letter rule (O2, O4).
3. Optional: normalise the text before matching, and widen the dash class (O1).
4. File a separate issue for `--audio` being sent as `--wm` (O5).
