# Code review: c49f712, cap ElevenLabs sfx/music length (MULTIX_MCP_MAX_AUDIO_SECONDS, #449)

Scope: `git show c49f712` only (parent 3252a21 not reviewed). 10 files, +127/-16.
Checks run: `npx vitest run test/run-argv-builder.test.ts test/spend-option-coverage.test.ts` (72 passed); `biome check` on the changed TS files (clean).

## Blocking

### B1. Music with no --music-length-ms is NOT bounded: ElevenLabs has no 30 s default
`worker/src/jobs/cli-command-policy.ts` sets `omittedSeconds: 30` for `music-length-ms`. Because 30 is not greater than the default cap (30), `applyCaps` does not fill a value, and `uncappedReason` no longer flags the run (`music-length-ms` was removed from `uncappedOptions`).
The 30 s figure comes from the CLI help text ("default 30000"), but the CLI never sends that default: `music.ts` sets `music_length_ms` only when the option is given.
The ElevenLabs Compose API reference (https://elevenlabs.io/docs/api-reference/music/compose) says `music_length_ms` is "Optional - if not provided, the model will choose a length based on the prompt", with a range of 3000 to 600000 ms.
Impact: with the default config, `elevenlabs music --prompt ...` with no length is now treated as capped. It runs without `max_cost_usd` in `budget` mode, and the model can bill up to 10 minutes. Before this commit that case was also unguarded, but the commit and the docs now claim it is capped.
Fix: for music, always send the cap when the option is omitted and `--plan` is absent. Either use an "unknown" omitted length (e.g. `omittedSeconds: Infinity`) or add a rule flag such as `fillWhenOmitted: true`. Correct the comment in `config.ts` ("a song left without a length at 30 s").

### B2. The server fills --music-length-ms alongside --plan, which the API rejects
`applyCaps` ignores `--plan`. With `MULTIX_MCP_MAX_AUDIO_SECONDS` < 30 (and for every plan run once B1 is fixed), a `--plan` run gets `--music-length-ms=<cap>` appended. The CLI then sends both `composition_plan` and `music_length_ms`.
The API says `music_length_ms` is "Used only in conjunction with `prompt`", so the request fails. A paid-for budget-mode `--plan` run, or a run under `allow`, errors instead of running.
Fix: skip the fill when `plan` is present. A generic way is a rule field like `unlessOptions: ["plan"]`. Add a test with a tight cap plus `inputs.plan` that asserts no `--music-length-ms` appears in the argv.

### B3. Docs and the tool description repeat the wrong 30 s premise
The new text in README.md and in docs-site EN/VI `mcp-server.md` (both the prose and the vars table) says the server sends the cap "when the provider's own length (30 s) is longer". The removed bullet "`elevenlabs music` with `--music-length-ms` ... (30 s otherwise)" is replaced by a claim that only `--plan` is uncapped.
For music this is false until B1 is fixed. Update the text to match the fixed behaviour: music without a length gets the cap, and sfx is auto-sized up to 30 s.

## Optional

- O1. Cap below 3 s breaks every filled music run. `MULTIX_MCP_MAX_AUDIO_SECONDS=1` or `2` fills `--music-length-ms=1000`/`2000`, which is below the API minimum of 3000 ms. Either document a floor or set the music fill to `max(3000, cap)` only when that is still within the cap (otherwise refuse music). sfx's minimum of 0.5 s is fine.
- O2. The `AUDIO_SECONDS_CEILING` comment ("ElevenLabs Music's longest song is 5 minutes") is out of date: the API allows 600000 ms (10 min). 300 is fine as a policy ceiling; fix the comment or state that it is a policy choice.
- O3. Tests do not cover `music` with the prompt only at the default cap (this would have exposed B1), `--plan` with a tight cap (B2), or that `uncappedReason` is undefined for capped music. The case `"elevenlabs music" ... "music-length-ms": 20000` passes `options` without `prompt`. That is acceptable for argv building, but add `prompt` so the case reads as a valid run.
- O4. Unrelated CLI bug: `music.ts` help says "(default 30000)" and the CLI does not send it. The fix belongs in a separate issue (send 30000 or drop the claim), per AGENTS.md. If the CLI starts sending 30000 by default, B1 resolves on its own, but `--plan` still needs B2.
- O5. In `run-option-caps.ts`, the header comment line added in this commit is over 100 columns (Biome does not wrap comments). Cosmetic.

## Verified non-issues

- Parsing mismatch (Number in the worker vs parseFloat/parseInt in the CLI): no accepted string makes the CLI send more than the cap. The worker check uses `Number(raw)` (finite and > 0). For any decimal literal `Number` accepts, `parseFloat` returns the same value and `parseInt(…,10)` returns less or the same. Hex, binary and octal (`0x7530`, `0b11110`, `0o36`) pass `Number` but parse to 0 in the CLI, so the request is a provider 4xx and not an overspend. Exponent forms parse lower under `parseInt` (`"3e4"` gives 3). Trailing junk makes `Number` return NaN, which is rejected. Option arrays are refused for non-repeatable options (`optionValue`), so `single()` sees the only value. Checked empirically with node.
- Unit conversion: `maxUnits = maxAudioSeconds * unitsPerSecond` is correct for seconds (1) and milliseconds (1000). The error message gives both units.
- Config: `boundedInt` gives the default for invalid input and clamps to the ceiling, and the tests cover both. `serverSettings` passes the new var through, and `wrangler.jsonc` sets it to `"30"`.
- sfx: omitted with the default cap sends no value. The provider auto-sizes within 0.5..30 s, so this is correct. A tight cap fills `--duration-seconds=<cap>`, and the test asserts it.
- The coverage test change (audioLength counts as "duration" coverage) is sound, and removing the sfx exemption is correct.
- Container compatibility: the change only affects argv building in the Worker. There is no job-spec or container contract change.

Status: DONE_WITH_CONCERNS
Summary: The sfx cap, unit conversion and parsing are correct. Music is not actually bounded when its length is omitted, because ElevenLabs lets the model choose up to 10 min and there is no 30 s default. The server-side fill also conflicts with `--plan`, which the API rejects alongside `music_length_ms`.
Findings:
- B1 blocking: music with no length is treated as capped but is unbounded (provider picks up to 600 s)
- B2 blocking: filled --music-length-ms combined with --plan is rejected by the API
- B3 blocking: README and docs-site EN/VI state the false 30 s provider default for music
- O1 optional: a cap below 3 s produces invalid music lengths
- O2 optional: the ceiling comment says 5 min; the API allows 10 min
- O3 optional: missing tests for music at the default cap, plan with a tight cap, and the uncapped-reason path
- O4 optional (separate issue): CLI help claims a 30000 default that is never sent
- O5 optional: long comment line

## Re-review: 73aa962

Checked `git show 73aa962` in a temporary detached worktree at that commit, because the main working tree is mid-merge with conflict markers in `worker/src/jobs/cli-command-policy.ts`. The worktree was removed afterwards. Results at 73aa962: full worker vitest passed (28 files, 504 tests), and `biome check` on worker/src, worker/test and src/providers/elevenlabs is clean.

- B1 resolved. Music now has `omittedSeconds: 600` (the API maximum), which is above any cap (ceiling 300), so an omitted `--music-length-ms` always gets the cap when no plan is given. The new test asserts `--music-length-ms=30000` at the default cap and checks that the run is not marked uncapped.
- B2 resolved. `notWith: ["plan"]` skips the fill when `plan` is in `values`. File-input paths are written into `values` before `applyCaps` (run-argv-builder.ts, the `resolved.paths` loop), so a plan passed through `inputs` is seen. The test with a tight cap plus `inputs.plan` asserts there is no length argument and the plan uncapped reason. A caller who passes both `--plan` and `--music-length-ms` gets an API 4xx, not overspend, so that is acceptable.
- B3 resolved. README, docs-site EN/VI prose and the vars table now state the model-picked length of up to 10 minutes, the `--plan` exception, and when sfx is filled (only when the cap is below 30 s). This matches the code. The CLI help and the regenerated `cli-catalog.json` no longer claim a 30000 default.
- O2 and O5 fixed. O1 (cap below 3 s) is left as an operator choice. Accepted, but the vars table could mention the 3 s API minimum for music. Non-blocking.
- New nit (optional): in the EN and VI `mcp-server.md` prose, the edited line ending "...up to 10 minutes). The server chooses the output directory," is not re-wrapped. Cosmetic.
- Process note: the working tree has an unfinished merge (unmerged paths, conflict markers in `cli-command-policy.ts`). Resolve it before pushing. This is outside the reviewed commits.

Status: DONE
Summary: 73aa962 resolves B1–B3, and tests and lint pass at that commit. No blocking finding remains.
