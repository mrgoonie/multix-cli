# Code review: 3e7127b fix(agent): never report a provider's estimated cost as credits or cost spent (#298)

## Scope
- Files: src/core/usage-extract.ts (+4), tests/unit/core/usage-extract.test.ts (+21), docs-site .../reference/for-ai-agents.md (EN + VI, 1 line each)
- REVIEW.md: not present at repo root; AGENTS.md rules applied.
- Checks run: focused vitest (7/7 pass), tests/unit/agent (15/15 pass), `npm run lint` clean, `npm run typecheck` clean. `check:mcp` not needed: worker/ does not import usage-extract.
- Mutation probe: ran pre-fix (3e7127b~1) and post-fix extractUsage on the same bodies (tsx, scratchpad).

## Overall
The fix is correct and minimal for the reported bug. No blocking issues. One test assertion proves nothing, and two of the three regex alternatives have no test that fails without the fix.

## Correctness
- The filter runs only in the promotion loop, so estimate values stay in `metrics` and are only skipped when picking `cost_usd` / `credits`. This matches the issue.
- End-to-end for Runway: the create POST (`estimatedCost.credits`) goes to `run.postUsage`, and poll GETs (`cost.credits`) go to `run.getUsage`. run-state.ts:93-94 adds them up, so before the fix one Runway run reported estimate + charge (e.g. 60 + 55). Now it reports only the charge.
- Header path: not affected. The header loop runs after the body loop, and its key `header.character-cost` never matches ESTIMATE_PATH. One side effect: if a body holds only an estimate credit, `credits` is now left undefined, so ElevenLabs `character-cost` can fill it. That is correct.

### False positives on real charge fields (grep of src/providers/**, src/commands, worker/src)
- `estimat`: Runway `estimatedCost` (meant to match), and Gemini omni `cost_estimate` / `estimateOmniCost`. The omni value is built by the CLI and written to the session record. It is not in the provider HTTP response that fetch-telemetry parses, so it does not reach this path.
- `quote`: only `shellQuote` helpers. These are not response fields.
- `expected`: only local variables and error messages. These are not response fields.
- No provider response type has a charge field whose path contains these substrings. Because the regex is unanchored, it also matches `unexpected*` and `quoted*`. The probe showed `usage.unexpected_tokens` next to `usage.cost` still promotes `cost` (the filter checks each leaf path on its own). Risk is low. Anchoring is optional (see O3).

### False negatives (accepted, outside the stated scope)
- `projected_credits`, `forecast*`, `approx*`, `reserved*`, `hold*`: still promoted (probe: `projected_credits: 9` gives credits 9). No current provider sends these. The issue asked for exactly estimat/quote/expected.

## Findings

### Blocking
None.

### Optional / non-blocking
O1 (Medium, test adequacy). The `quote: { cost: 0.5 }` assertion is a phantom. Before the fix, `quote.cost` was never promoted to `cost_usd` anyway: the cost rule needs a path that matches `/usage|^cost|billing/` (usage-extract.ts:149). The probe confirms old = {} and new = {} for this input. So the `quote` alternative has no regression coverage, and `expected` has none at all. Suggested replacement in the first test:
```ts
quote: { credits: 3 },          // old: credits 3, new: undefined
expected_credits: 7,            // old: credits 7, new: undefined
usage: { estimated: { cost: 0.25 } },
```
or `usage: { quote: { cost: 0.5 } }`, which the cost rule would promote. Verified: `quote.credits` and `expected_credits` were promoted before the fix and are not promoted after it.

O2 (Low, test adequacy). No test sums usage across requests (fetch-telemetry plus run-state) with a Runway-shaped POST `{id, estimatedCost:{credits:60}}` followed by a GET `{id, status:"SUCCEEDED", cost:{credits:55}}`. That double count was the user-visible symptom in the envelope and history. The unit test "reports credits charged next to an estimate" only covers the case where both are in one body. A small run-state test would cover the real path.

O3 (Low). Optional hardening: limit the regex to key-segment boundaries, e.g. `/(^|[._\[])(estimat|quote|expected)|(Estimat|Quote|Expected)/` or a per-segment check, so `unexpected*` / `quoted*` do not match. No current provider is affected, so leaving it as is is fine.

### Pre-existing, out of scope (open a separate issue per AGENTS.md)
P1 (Medium). The credit rule `/credit/i.test(leaf)` takes the first numeric leaf whose name contains "credit", so balance fields count as spend too. Example: `multix leonardo me` returns `user_details[].user.apiCredit` (remaining balance; src/providers/leonardo/types.ts:58). The probe shows `{user:{apiCredit:1000}}` gives credits 1000 both before and after this commit. The same applies to any `remaining_credits` / `credit_balance` / `creditsPerSecond` leaf. This is the same class of bug as #298 (a number that is not a charge reported as credits), and this commit does not cover it.

## Docs
The EN and VI wording is accurate and matches the code ("stays in `metrics` and is never reported as `cost_usd` or `credits`"). README.md:669 and skill/SKILL.md:235 already describe `estimatedCost` vs billed `cost` correctly, so they need no change.

## Commit hygiene
Conventional commit, `Closes #298`, scoped to the issue, no plan IDs in the code comment. The `fix` type publishes a patch release, which is appropriate.

## Unresolved questions
- Should P1 (balance fields promoted as credits) be filed as a new issue? I recommend yes.

Status: DONE_WITH_CONCERNS
Summary: The fix is correct and minimal: Runway estimatedCost no longer inflates credits (it was summed with the billed cost across POST and GET), there are no false positives on current provider charge fields, and the header path is unaffected. Not blocking: the `quote.cost` test assertion is a phantom, `quote`/`expected` have no real regression coverage, and the existing promotion of balance fields such as Leonardo `apiCredit` should go in its own issue.
