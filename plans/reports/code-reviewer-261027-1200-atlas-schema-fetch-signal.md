# Code review: atlas schema-fetch signal (c7647f8, issue #392)

Scope: `src/providers/atlascloud/commands/prediction-runner.ts` (loadModelSpec), `tests/smoke/agent-mode.test.ts`, README.md, skill/SKILL.md, docs-site atlascloud.md (en/vi). About 50 changed lines.
Checks: lint clean, typecheck clean, build ok, `vitest run tests/smoke/agent-mode.test.ts tests/unit/providers/atlascloud/prediction-runner.test.ts` 61 passed / 1 skipped.

## Verdict
Correct and minimal. No blocking or high-severity findings.

## Verified (no defect)
- Exit path: `stop` calls the wrapped `process.exit` (agent-runtime.ts:426), so `finalizeRun` writes the envelope and history, then calls `realExit`. The catalog GET counts in `run.requestsStarted`, so `classifySignalExit` would give the "paid job may already exist" hint. `run.interrupted = NOTHING_SUBMITTED` overrides it (agent-runtime.ts:243-249). The smoke test asserts this hint.
- Error-swallowing catch: the handler exits synchronously and never rejects the work promise, so the catch cannot turn a signal into "sending without validation". A real fetch error still warns and continues as before.
- Listener leaks and overlap: `finally` removes the listeners before `loadModelSpec` resolves. Code after it runs synchronously up to the next `exitOnInterrupt`: `assertEndpoint`/`buildModelInput` in generation-command.ts:44-49, then uploads (:52), and `validateRawInput` in run.ts:59-71, then `executePrediction` submit (prediction-runner.ts:246). So two handlers are never active at once, and no macrotask gap lets a signal fall through to Node's default action. `--no-validate` returns before installing anything. `atlas run --input @file` reads synchronously, and no stdin-file handler is involved.
- Both fetches inside `getModelSpec` (catalog and https schema document, client.ts:313-322) run inside the wrapper.
- Docs: all four surfaces say the same thing. "Before the submit" is accurate because every other pre-submit step is synchronous. The Vietnamese text matches the English.

## Low
1. **`loadModelSpec` cannot take an injected `exit`** (prediction-runner.ts:119-147). `executePrediction` and `exitOnInterrupt` accept `exit` for tests, but this wrapper does not. So the new behavior can only be tested by spawning the CLI, and generation-command/run cannot thread a test exit through. Failure scenario: nothing in production. It is only a gap in test reach and consistency. Fix (optional): add an optional `exit?: (code: number) => void` parameter and forward it.
2. **The smoke test covers only the catalog GET, not the schema-document GET** (agent-mode.test.ts:311-327, hang on `/models`). The schema URL must be https (client.ts:315), so the plain-http fake cannot serve it. Coverage of that second fetch rests on the code structure (same wrapper), not on a test. Scenario: a future refactor moves the schema fetch outside `loadModelSpec` (for example, prefetching in the command), and no test notices. Fix (optional): add a unit test that calls `loadModelSpec` with a client whose `getModelSpec` never resolves, emit `process.emit("SIGINT")`, and assert the injected exit got 130 and `run.interrupted === NOTHING_SUBMITTED`. This depends on item 1.
3. **The test does not check the stderr message or SIGTERM/SIGHUP.** It asserts only SIGINT/130 plus the envelope. The signal-to-code mapping is shared and covered elsewhere, so the risk is low. Optionally add `expect(result.stderr).toContain("loading the schema")` to pin the phase-specific message.

## Edge cases considered
- A second signal: the first exits synchronously, so there is nothing to double-handle.
- A signal during the catalog fetch in `--dry-run`: unchanged by this commit.
- The test is a real regression test: before the fix no listener was installed in this phase, so SIGINT killed the child and execa reported no exit code, which fails `toBe(130)`. This was concluded from code reading. Pre-fix dist was not rebuilt.

## Unresolved questions
None.
