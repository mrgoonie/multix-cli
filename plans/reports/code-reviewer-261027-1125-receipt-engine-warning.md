# Code review: check-receipt reports the verify engine (#381)

Scope: README.md, skill/SKILL.md, docs-site EN/VI media-and-documents.md,
src/commands/media/media-receipt.ts, src/commands/media/media-quality-commands.ts,
tests/smoke/media-quality.test.ts, tests/unit/commands/media/media-quality-ffmpeg.test.ts
(+61/-9, uncommitted).

Verification run: `npm run build` OK; `npx vitest run tests/smoke/media-quality.test.ts tests/unit/commands/media`
7 files / 127 tests pass (ffmpeg present, nothing skipped); `npm run typecheck` clean; biome on touched
files clean; `npm run check:mcp` clean; `npm run verify:docs` 8/8 pass.

## Overall
Logic is correct for the decided behaviour: an older receipt keeps `ok: true`/exit 0, `engine` and
`warnings` are additive fields. Main gap: the warning is invisible where agents are told to look.

## Findings (by severity)

### Medium 1 - Warning does not reach the envelope's top-level `warnings[]` (agent contract)
- src/commands/media/media-quality-commands.ts:336-347, src/commands/media/media-receipt.ts:75-79
- Convention: `multix.result/v1` has its own `warnings` (src/agent/result-envelope.ts:27), filled from
  output inspection and from stderr lines starting with `⚠` (`logWarnings()`, src/agent/agent-runtime.ts:189-196),
  i.e. anything sent through `logger.warn()` (src/core/logger.ts:52). Commands with domain warnings do both:
  keep them in `data` and call `logger.warn` per warning (src/providers/fish/commands/tts.ts:309 + :368,
  src/providers/elevenlabs/commands/tts.ts:97).
- `multix guide` (src/commands/agent/guide-command.ts:22-25) tells agents: "Check the result yourself:
  ok=true AND outputs non-empty AND no warnings". 
- Failure scenario: an agent runs `multix media check-receipt old.receipt.json final.wav --json` on a
  receipt made by `multix-media-verify/1` for a truncated WAV. Envelope: `ok: true`, `exit_code: 0`, no
  top-level `warnings`. The stale-engine notice is only at `data.warnings`, which the guide never mentions, so
  the agent ships the truncated file - the exact defect that motivated the engine bump.
- Fix: in the action, `for (const w of result.warnings) logger.warn(w)` (stderr, becomes
  `{code:"LOG_WARNING"}` in the envelope), keep `data.warnings`, and drop the `  warning:` stdout lines
  to avoid printing twice in text mode. That also answers "should warnings go to stderr like NOT OK":
  yes - stdout in text mode is the verdict line scripts may parse/grep, and every other multix warning is
  on stderr. Update the smoke test to assert `stderr` (text) and `envelope.warnings[].code === "LOG_WARNING"` (json).

### Low 2 - "older engine" wording is wrong for a newer or foreign engine id
- media-receipt.ts:56-57 treats any id != VERIFY_ENGINE as stale; docs (README.md:905, docs-site EN/VI,
  skill/SKILL.md:554) and the interface comment say "older engine".
- Scenario: a receipt made by a newer CLI (`multix-media-verify/3`) checked with this build gets
  "rerun media verify ... to apply the current checks", i.e. downgrade advice. The message itself is neutral,
  so only docs/skill text mislead. Either word docs as "a different (usually older) engine" or compare
  versions and say "newer engine; update multix" for that case. Not blocking.

### Low 3 - Untrusted receipt `engine.id` is echoed raw into text output
- media-receipt.ts:56,78; media-quality-commands.ts:342.
- A crafted receipt can put newlines/ANSI escapes or a multi-MB string in `engine.id`; text mode prints it
  verbatim (forged "OK" line, terminal escapes). JSON mode escapes it. Same pre-existing exposure for
  `profile.id` at :340, and receipts are documented as untrusted local records, so low. Cheap hardening:
  require `/^[\w.\-\/]{1,64}$/` for the id, else treat as unknown (null).

### Low 4 - Test gaps
- No test for receipt without `engine`, `engine: null`, `engine` as a string, or a non-string `id`
  (all correctly map to `receipt: null`, "(unknown)" by reading the code - `receipt.engine?.id` never throws
  for primitives - but the stated edge case is unproven).
- No test for an envelope-wrapped (`--json` output) receipt with an old engine: `--receipt-out` writes a bare
  receipt, so the smoke test's `receipt.data ?? receipt` always takes the bare branch. readReceipt unwraps
  uniformly, so risk is low.
- Smoke test checks text stdout only; the JSON `engine`/`warnings` fields and the `ok:false` + old-engine
  combination (both reason and warning) are not asserted end to end.

### Low 5 - Docs formatting
- docs-site/src/content/docs/commands/media-and-documents.md and the VI file: the edited paragraph leaves one
  line at ~110 chars ("...missed. Receipts are not signed: ... only as far as") while the rest is wrapped
  at ~78. Cosmetic; re-wrap.

## Checked, no issue
- Edge cases: missing engine / null / string / numeric id -> `receipt: null`, warning says "(unknown)",
  no throw. Whitespace-variant ids are treated as mismatched (strict, fine).
- Backward compatibility: `ReceiptCheck` gains required `engine` and `warnings`; JSON output is additive;
  only in-repo caller is the action. `ok` and exit code unchanged for old receipts as decided.
- Hash mismatch + old engine: `reason` and warning both suggest rerunning verify; redundant but correct.
- Remote MCP: worker policy for `media check-receipt` (worker/src/jobs/cli-command-policy.ts:276) only maps
  file positionals; no flags or description changed, so cli-catalog.json needs no regeneration;
  the container returns stdout/stderr tail, so the new fields flow through. check:mcp clean.
- Docs: EN/VI consistent with each other and with code (`engine.receipt|current|current_matches`, `warnings`).

## Recommended actions
1. Emit each warning via `logger.warn` (stderr -> envelope LOG_WARNING), drop the stdout `warning:` lines,
   assert both in the smoke test. (Medium 1)
2. Fix "older engine" wording or handle newer ids. (Low 2)
3. Add the missing-engine / non-string id unit cases. (Low 4)
4. Optional: sanitize `engine.id` before printing. (Low 3)

## Unresolved questions
- Should `check-receipt` warnings use a dedicated envelope code (e.g. `STALE_RECEIPT_ENGINE`) instead of the
  generic `LOG_WARNING`? That would widen the `ResultEnvelope.warnings` union and is a separate decision.

## Resolution

- Medium (warning missing from the envelope): `check-receipt` now emits each warning through `logger.warn` (stderr), so the `--json` envelope lists it in its top-level `warnings`; `data.warnings` is kept. The smoke test asserts stderr in text mode and the envelope `warnings` in `--json` mode.
- Low (wording): README, SKILL.md, docs-site EN/VI and the interface comment now say "a different (e.g. older) engine".
- Low (echoed id): `engine.id` is taken only when it matches `^[\w./-]{1,64}$`; anything else is reported as `null` / "(unknown)".
- Low (tests): unit test covers a missing, null, non-string and malformed engine id.
- Low (line wrap): the EN/VI docs paragraphs are rewrapped.
- Verified: lint, typecheck, build, `npm test` (2258 passed, 22 skipped), `npm run verify:docs`.
