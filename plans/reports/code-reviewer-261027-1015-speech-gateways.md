# Code review: OpenRouter and fal TTS behind `multix speech` (#334)

Commit `08b4fcc` on `claude/gracious-heisenberg-zmpkrm`, diff `origin/dev...HEAD` (22 files, +1213/-226).

## Verification run

- `npm run lint`, `npm run typecheck`: clean.
- `npm run build && npm test`: 123 files passed, 8 skipped (2167 passed, 22 skipped).
- `npm run check:mcp`: passes, bundle check clean.
- Ran `node dist/cli.js ... --dry-run --json` with fake keys for both gateways. For `openrouter tts` and `fal tts` I diffed the dry-run envelopes against an `origin/dev` build (in a temporary worktree, now removed) over 11 flag combinations. Request bodies, output envelopes and exit codes are identical, except for the error ordering in finding 5.
- No real API was called. No source file was edited.

## Findings

### 1. blocking: `--extra openrouter.speed` is sent to the paid POST without range validation
- File: `src/commands/speech/speech-adapters.ts:281` (`speed: num(x.speed)`)
- The range check `positiveNumber(opts.speed, "--speed", 4)` stayed in the `openrouter tts` command layer (`src/providers/openrouter/commands/tts.ts`, action handler). It did not move into `runOpenRouterTts`, so the façade skips it.
- Scenario (verified): `multix speech generate --provider openrouter --text hello --extra openrouter.speed=-3 --dry-run --json` succeeds. The planned body is `{"model":"google/gemini-3.8-flash-tts",...,"speed":-3}`. `speed=9` is sent the same way. The same values on `openrouter tts --speed 9` exit 2 (`--speed must be a number greater than 0 and at most 4`).
  - This breaks the façade rule that the whole request is validated before any provider call.
  - The live catalog GET does not check speed.
  - Depending on the upstream provider, the paid POST is either rejected or clamped and billed.
- Fix (either works):
  - Validate `speed` (0 < n <= 4) inside `runOpenRouterTts`, so both callers share the check.
  - Or reject it in `buildRoute`/`extrasFor` with a per-key range, so it fails during planning with the other problems.
  - Add a façade test for out-of-range speed.

### 2. minor: `fal tts` now creates `./multix-output` even when nothing is downloaded
- File: `src/providers/fal/commands/tts.ts:193` (`outDir: opts.outputDir ? path.resolve(opts.outputDir) : getOutputDir()`)
- `getOutputDir()` calls `mkdirSync`. The refactor calls it eagerly, before submit, for every run. Before, it ran only after the result came back and only when `--download` was on.
- Scenario (verified against an `origin/dev` build): `fal tts "hi" --detach --dry-run --json` in an empty directory now leaves `multix-output/` behind. `origin/dev` does not. The same applies to `--no-download` and `--detach` real runs. With an unwritable `MULTIX_OUTPUT_DIR`, a `--detach` run that needs no output dir now fails before submitting.
- Fix: pass `outDir` lazily, for example `outDir?: string` with `opts.outDir ?? getOutputDir()` inside `runFalTts` just before `saveSpeechAudio`, or a `() => string` getter. The same eager call exists in the façade adapter (`speech-adapters.ts:322`), where it is harmless because the façade always downloads.

### 3. minor: fal `--async` silently drops `--output`
- Files: `src/commands/speech/speech-adapters.ts:327-330`, `src/commands/speech/index.ts:245`
- Scenario: `speech generate --provider fal --text ... --output scene.wav --async`.
  - The adapter returns `job.resume = receipt.result_command` (`multix fal result <model> <id> --download [--format ...]`), which has no destination.
  - `index.ts` returns before printing `Copied to`.
  - The user's `--output` is ignored with no warning. Running the resume command later writes to `./multix-output`, not `scene.wav`.
  - The Atlas route handles the same case: `resumeCommand(id, ctx.output)` adds `--output`.
- Fix (either works):
  - Reject `--output` together with `--async` on the fal route during planning.
  - Or append `--output-dir <dirname(output)>` to the resume command and tell the user the file name will differ. `fal result` has no `--output` flag, so rejecting is the simpler choice.

### 4. minor: `--language` is accepted and silently dropped on every OpenRouter route and on the fal Gemini endpoints
- Files:
  - `src/speech/speech-catalog.ts:413` and `:431`: `languages: null`, and no `language_param` for Gemini rows.
  - `src/speech/speech-request.ts:317` skips the check when `languages` is null.
  - The adapters forward `language` only when `language_param` is set.
- Scenario (verified): `speech generate --provider fal --language zz --text hi --dry-run` passes. The body is `{"prompt":"hi","voice":"Kore"}`. On `--provider openrouter --language vi` the body has no language either. Neither run prints a warning.
  - The `--language` help text says the value is "checked against the model's documented list".
  - An agent that picks a route for Vietnamese gets no signal that the value was not used.
- Fix: in `buildRoute`, when `input.language` is set and the capability has neither `languages` nor `language_param`, either push a problem ("takes no language parameter; the model infers it from the text") or emit a warning recorded in `data`. The direct Gemini route never sends the language either but at least checks it against a list.

### 5. nit: `openrouter tts` validation order changed
- File: `src/providers/openrouter/commands/tts.ts:447`
- `--cost-wait` is now validated before `--format`, `--sample-rate`, `--speed`, the input, and the `provider/name` model check. Those checks used to run first.
- Scenario (verified): `openrouter tts --text hi --format bogus --cost-wait 500` reported `Invalid --format: bogus` on `origin/dev` and reports `--cost-wait must be between 0 and 120 seconds` now. The exit code is still 2. Only the message differs.
- Fix: move the `costWait` check after the call arguments are computed, or accept the change as harmless.

### 6. nit: fal cost estimate reports an empty model
- File: `src/budget/command-cost.ts:156` and `:200`
- `SPEECH_DEFAULT_MODELS` and `runtimeDefaults` have no `fal` entry, so `defaultModel("fal")` is `""`.
- Scenario (verified): `speech generate --provider fal --text hello --dry-run --json` gives estimate `"detail":"No price for the fal/ route; ...","model":""`.
- Fix: add `fal: FAL_DEFAULTS.ttsModel` to `SPEECH_DEFAULT_MODELS`. The status stays `unknown`; only the label is fixed.

### 7. nit: the docs say the model picks the voice when `--voice` is omitted, but the façade sends a fixed default
- Files: `docs-site/src/content/docs/commands/speech.md:121-122` (and the Vietnamese mirror)
- The docs say "without `--voice` the model's default is used".
- Scenario (verified): an OpenRouter Gemini dry run sends `"voice":"Kore"` and marks `voice_defaulted: true`. The default comes from the catalog row (`Kore` for Gemini, `sarah` for ElevenLabs), not from the model. The direct `openrouter tts` command, by contrast, sends no voice.
- Fix: reword to "without `--voice` the route uses the default listed by `speech models` (Kore for Gemini, sarah for ElevenLabs)".

## Checked and not a problem

- **Ambiguous model id:** `--model google/gemini-3.8-flash-tts` without `--provider` exits 2 with `served by openrouter and fal; pass --provider to choose`, and nothing is sent. With `--provider` set, the right row is chosen. Fallback between the two applies the other provider's default voice and prints the differences warning.
- **Request mapping:**
  - OpenRouter: style becomes `instructions`; zdr and deny_data_collection go into `provider`; Gemini rows default to wav, which requests pcm.
  - fal Gemini: `prompt`, `voice`, `style_instructions`; no format field.
  - fal ElevenLabs: `text`, `voice`, `language_code`, and `output_format` (`mp3_44100_128` / `pcm_24000`).
  - Format/container mismatches and `--style` on ElevenLabs rows are rejected during planning.
- **fal async receipt:** saved with the `--format` resume argument; `job.resume` is in `data`.
- **No paid request is ever retried or resent:**
  - A missing key leads to fallback before any send.
  - A 500 or 502 after submit is not retried.
  - An ambiguous fal submit fails with an unknown-remote-state error and is not retried.
  - Tests cover each of these cases with mocked fetch.
- **Refactor of the existing commands:** the `openrouter tts` JSON result keys and the text output lines are unchanged. The `fal tts` detach, no-download and download output is unchanged.
- **No secrets in logs:** keys are not logged. `Cost: multix openrouter generation <id>` logs only the generation id.
- **Worker:** `speech generate --provider fal|openrouter` hands the job only the routed groups' keys. An old container receiving the new providers fails validation (exit 2) before any send, so the rollout order is safe.
- **Provider clients:** no new `node:*` imports in `src/providers/**` clients. `node:fs`/`node:path` were added only to the command-layer adapter, and `check:mcp` passes.

## Plan/task status
Issue #334 scope is implemented: catalog rows, adapters, budget, worker policy, docs (EN/VI, README, SKILL.md) and tests. Fix finding 1 before merge; 2 to 4 are small follow-ups that can go in the same PR.

Status: DONE_WITH_CONCERNS
Summary: The gateway routes are correct and the refactor keeps both existing commands' output identical. One blocking issue: the OpenRouter speed extra reaches the paid request without validation. There are also three minor regressions or gaps: an eager output-dir mkdir in `fal tts`, `--output` dropped on fal `--async`, and `--language` silently ignored.
