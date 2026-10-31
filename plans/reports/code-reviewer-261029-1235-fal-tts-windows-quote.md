# Code review: quote the Windows --output-dir in the fal tts resume test (#524)

Reviewer: isolated code-reviewer subagent (did not write the fix). Report written by the implementing session from the reviewer's returned findings.

## Scope

`tests/unit/providers/fal/tts-command.test.ts`: the expected resume command now uses `shellQuote(out)`.

## Verification by the reviewer

- 43/43 tests pass on Linux and biome is clean. A POSIX temp path matches the plain-argument regex, so the expectation is unchanged there.
- On a Windows-style path (`C:\Users\RUNNER~1\...\out`), `shellQuote` returns the single-quoted form that `resumeCommand` produces in CI.
- Importing `src/agent/agent-runtime.ts` has no side effects at import time; its `install*` functions run only when called. Four other test files already import it.
- No other test builds a resume command from a raw temp path. `fal/commands.test.ts:503` uses a path with a space, which is always quoted.
- The exported `shellQuote` in `agent-runtime.ts` and the private one in `request-receipt.ts` are character-for-character identical.

## Findings

- Low: the test ties itself to the `agent-runtime` copy of `shellQuote`. If the two copies drift, the test fails, which is the safe direction. Merging them is out of scope; `request-receipt.ts` keeps its own copy so the provider client stays free of CLI code.
- Low: the expectation is computed by the quoting function, so this test does not check quoting by itself. `fal/commands.test.ts:503` checks it with a literal string.
- Info: the reviewer could not run on Windows. The windows-latest CI jobs on `dev` confirm the fix.

## Result

Approved; no change requested.
