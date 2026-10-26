# Code review: never promote provider estimates to usage.credits / cost_usd (#298)

Scope: src/core/usage-extract.ts, tests/unit/core/usage-extract.test.ts,
docs-site/src/content/docs/{,vi/}reference/for-ai-agents.md.
Note: the reviewed diff was committed during review as 682745e; behavior was compared
against 682745e~1 with a scratch probe (no repo files changed). No REVIEW.md exists.

## Verdict
Fix is correct and minimal. No blocking issues.

## Verification
- Probe (old -> new) with Runway's real terminal task shape
  `{estimatedCost:{credits:60}, cost:{credits:40}}`: credits 60 -> 40 (the billed amount).
  Previously the create POST (60) and every GET poll (60) were also summed by
  summarizeUsage (src/agent/run-state.ts:93-94), so the fix removes double counting too.
- `{cost_estimate:{cost:1}}`: cost_usd 1 -> undefined (the cost_usd guard works).
- vitest (usage-extract + agent tests): 22 passed. biome clean. tsc --noEmit clean.

## False-positive check (regex /(estimat|quote|expected)/i on the full key path)
Grep of src/providers/** response types for these substrings:
- runway/types.ts:28,42 `estimatedCost` - the intended target; charged amount is `cost.credits` (not matched).
- elevenlabs/commands/dub.ts:26 `expected_duration_sec` - not a cost/credit leaf; unaffected.
- gemini omni `cost_estimate` - built locally (omni.ts:282, omni-flow.ts:438), not parsed from an HTTP response by fetch-telemetry; and it is an estimate anyway.
- atlascloud `expected`, fal/atlascloud `shellQuote` - function params/helpers, not response keys.
No provider has its charged amount under an estimate/quote/expected path.

## Findings (non-blocking)
1. Medium - phantom assertion. tests/unit/core/usage-extract.test.ts:52
   `expect(usage.cost_usd).toBeUndefined()` passes on the pre-fix code too: `usage.estimated_cost`
   (leaf is not `cost`) and `quote.cost` (path lacks usage|^cost|billing) were never promoted.
   The cost_usd branch of the skip is untested. Add e.g. `{ usage: { estimate: { cost: 0.5 } } }`
   or `{ cost_estimate: { cost: 1 } }` (verified: old -> cost_usd set, new -> undefined).
2. Low - tests/unit/core/usage-extract.test.ts:61-64 uses an invented `creditsCharged` key.
   Runway's actual billed shape is `cost: { credits }` (runway/types.ts:30); a test with
   `{ estimatedCost:{credits:60}, cost:{credits:40} }` -> credits 40 would pin the real regression.
3. Info - the regex is substring-based on the whole path (e.g. "unquoted", "expectedValue"
   parents would also be excluded). Acceptable: failure mode is under-reporting into metrics only,
   never inventing a charge, which matches the documented "Nothing is estimated" contract.

## Docs
EN and VI rows are accurate and consistent with code (estimate stays in metrics, never fills
cost_usd/credits). docs-site/dist is a build artifact already regenerated locally; confirm it is not tracked.

Status: DONE_WITH_CONCERNS
Summary: Fix is correct, no provider false positives found, and Runway credits now report the billed cost.credits instead of the estimate. The cost_usd half of the new test is a phantom assertion.
Concerns: tests/unit/core/usage-extract.test.ts:52 (cost_usd assertion passes pre-fix); tests/unit/core/usage-extract.test.ts:61-64 (uses synthetic key, not Runway's cost.credits).
