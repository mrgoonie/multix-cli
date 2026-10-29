# Code review: commit e1fc23b, gemini generate partial failure (#493)

## Scope
- Commit under review: e1fc23b only. Its parent c42d99e, which merges PR #491, is out of scope.
- Files: src/providers/gemini/commands/generate.ts, src/agent/agent-runtime.ts (finalizeRun, withOptions), src/agent/run-state.ts, tests/unit/agent/finalize-run-partial.test.ts, tests/unit/providers/gemini/generate-errors.test.ts, docs-site gemini.md and for-ai-agents.md (en and vi), skill/SKILL.md.
- Read for context: output-file-tracker.ts (producedFiles), history-store.ts (redactArgv), result-envelope.ts (nextForError), image-webp-finalize.ts, gemini/client.ts (extractImages).
- Out of scope: outputs under os.tmpdir() are filtered out (#496).

## Verification performed
- `npx vitest run` on the two touched test files: 7/7 pass.
- `npm run typecheck`: clean. Biome on the 5 touched files: clean.
- Probe test in the scratchpad (repo not modified) that calls `withOptions` with `{ "--num-images": "2", "--output": null }`, plus a commander parse check:
  - `--prompt constructor --num-images 3 --json` -> `--prompt 3 --json --num-images 2`, so the prompt becomes "3".
  - `--prompt toString --json` -> `--prompt --num-images 2`
  - `--prompt --output --num-images 3` -> `--prompt 3 --num-images 2`. Commander does accept `--prompt --output` and sets prompt to "--output".
  - `--prompt a=b`, `--output=x=y.png`, `--num-images=3`: handled correctly.
- No paid APIs were called.

## Findings

### Medium

**M1. `withOptions` uses the `in` operator, so prototype keys match option names. The suggested paid command can silently use a different prompt.**
`src/agent/agent-runtime.ts:164`, `if (!(name in options))`. `options` is a plain object literal, so `"constructor" in options`, `"toString" in options`, `"valueOf" in options` and `"__proto__" in options` are all true. Any argv token with one of these names is dropped, and the token after it is skipped too.
- Failure scenario: `multix gemini generate --prompt constructor --num-images 3 --json`. Request 2 returns 503. `next[0]` becomes `multix gemini generate --prompt 3 --json --num-images 2`, and an agent that runs `next[0]` pays for 2 images of the prompt "3". The prompt `toString` gives `--prompt --num-images 2`: commander reads the prompt as the literal text "--num-images", and "2" becomes an excess argument.
- These prompts are unlikely, but the function is a general exported helper and the result is a wrong command that costs money.
- Fix: `if (!Object.hasOwn(options, name))`, or build `options` with `Object.create(null)` or a `Map`. Add a test for each.
- Related, Low: commander lets a required option value start with `--`, so a value that equals a replaced option name (`--prompt --output`) is also mangled. `withOptions` has no way to tell option names from option values. Accept and document this, or skip the value of every known value-taking option.

**M2. The remainder command goes first in `next` even when the error is not retryable.**
`src/agent/agent-runtime.ts:311-321`. The partial branch is gated only on `info && !inFlight && outputs.length`.
- Failure scenario: free-tier quota runs out after image 1. Request 2 returns QUOTA_EXCEEDED (exit 5, `retryable: false`). The hint becomes "1 file(s) were saved…; request only the rest with the next command. <quota hint>", and `next[0]` is the remainder, which will fail the same way. The useful step, `multix models --task … --ready`, drops to `next[1]`.
- The same applies to PROVIDER_REJECTED (a safety block on a regenerated image) and INVALID_KEY.
- This contradicts the updated docs and skill: exit 5 still says "change input/provider", and only exit 4 mentions `next[0]` for saved outputs.
- Fix: put the remainder first only when `info.retryable`, or when `info.code` is in RATE_LIMITED, PROVIDER_UNAVAILABLE or NETWORK_ERROR. Otherwise prefix only the "files were saved, keep them" part of the hint and put the remainder after the code-specific `next` entries. Add a QUOTA_EXCEEDED test case.

### Low

**L1. `remaining` counts requests, not missing images.**
`generate.ts:111`, `numImages - i`. A request that returned no image (the `continue` at :120) counts as done.
- Failure scenario: `--num-images 4`. Request 1 saves an image, request 2 returns no image, request 3 returns 503. `remaining` is 2, so the caller ends with 3 images, not 4, while the hint says "request only the rest".
- Fix: use `numImages - savedFiles.length`, clamped to at least 1, or state that the count is in requests. This is consistent with the current one-image-per-request behaviour.

**L2. The hint's file count includes the `--output` copy.**
`agent-runtime.ts:315`. `outputs` comes from `producedFiles`, which holds both the generated `gemini_generated_*` file and the `--output` copy.
- Failure scenario: 1 image saved with `--output a.png`. The hint says "2 file(s) were saved before the failure" while `--num-images` asks for 2 more. An agent comparing counts could be confused.
- The unit test hides this by putting only `run.options.output` into outputs.
- Fix: say "file(s) are in outputs", or count images separately.

**L3. Failures outside the try block skip the partial path.** This is not a regression.
`generate.ts:128` (writeFileSync of image k), `:142` (copy to `--output`) and `:146` (finalize).
- Failure scenario: ENOSPC on image 2, or EACCES on the `--output` copy after request 2 fails. The fs error replaces the provider error, `run.partial` is not set, and `next` falls back to `multix rerun <id>`, which pays for everything again.
- In the second case the provider error code (for example 503) is lost.
- Fix (optional): wrap the `--output` copy and finalize in try/finally and set `run.partial` before them when `failure` is set. Otherwise track this in a follow-up issue.

**L4. A signal during request k>1 does not use the new path.**
SIGINT while request 2 is in flight. `run.partial` is only set right before the rethrow, so the image already saved is not copied to `--output` or converted, and the hint follows `run.interrupted` or the generic CANCELLED rerun guidance. `outputs` still lists the file.
- This is acceptable for #493, which is about failed requests. Note it in the issue as a known gap.

**L5. The history ledger does not record the partial state.**
`appendHistory` stores `ok: false` with the saved outputs. A later `multix rerun <id>` replays the full `--num-images N` and pays again. Nothing in this commit suggests that rerun, but the ledger keeps no remainder. Informational only.

**L6. The full prompt appears in the suggested command.**
The prompt goes into `next[0]` in the envelope and on stderr in text mode. The BUDGET `--estimate` suggestion already does this, so there is precedent. `redactArgv` runs after `withOptions`, so secrets are still redacted.

### Checked, no issue found
- `--num-images` missing from argv: `numImages` is then 1, so the partial path cannot be reached. `withOptions` appends the value in any case.
- `--num-images=3` and repeated `--num-images` are both removed and replaced once.
- Values containing '=': only the text before the first '=' is compared, which is correct.
- Short aliases: the command defines none for `--num-images` or `--output`.
- The only signal-path change is the partial branch, and it requires `!inFlight`. `run.partial` is never set when the error comes from a signal exit. The interrupted branch requires `input.error === undefined`, and the partial path always has an error.
- `savedFiles.length === 0` at the first failure rethrows immediately, so `process.exit(1)` cannot run with a pending failure.
- The `multix rerun ` prefix filter covers the only rerun suggestion from `nextForError`.
- Budget refusals are preflight only, so they cannot occur in the middle of the loop.
- Docs: en and vi are updated together, and the skill is updated. The exit-5 wording conflicts with M2.

## Overall verdict
The approach is sound and fixes the scenario in #493: a 503 on request 2 still reports the saved files, keeps the error code, and offers a remainder in place of a paid rerun.

Fix before merge:
- M1: one line, `Object.hasOwn`, plus tests.
- M2: gate the remainder on retryable codes, plus a QUOTA_EXCEEDED test.

L1 and L2 are cheap to fix in the same change. L3 to L5 can be follow-up issues.

## Resolution (author, follow-up commit)

- M1: `withOptions` uses `Object.hasOwn`; test with `--prompt constructor`.
- M2: the remainder run is `next[0]` only for a retryable error; otherwise it is last, after the fix (QUOTA_EXCEEDED test).
- L1: the remainder counts requests that returned images, not requests made (test).
- L2: the hint no longer counts files.
- L3: a failure while finishing the saved images (`--output` copy, format conversion) after a request failure is logged as a warning; the request's error and the remainder still decide the run. An image write failure inside the loop stays as before.
- L4, L5, L6: left as is (signal path is #493-independent; history rerun replays the recorded argv by design; prompt in `next` has precedent in the `--estimate` suggestion).
