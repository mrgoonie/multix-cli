# Code review: 912a06b, spend keys that name a balance (#341)

Reviewer: isolated code-reviewer (did not write the change). Date: 2026-10-26 UTC.
Branch: `claude/gracious-heisenberg-k5dsyx` (holds the first claim on #341). No REVIEW.md in repo.

## Scope
- `src/core/usage-extract.ts` (+15): `SPEND_WORDS`, `isSpendLeaf()`, early return in `isBalancePath()`.
- `tests/unit/core/usage-extract.test.ts` (+22): two new cases.
- Consumers: `src/agent/fetch-telemetry.ts:242` (every fetch in an agent run), summed in `src/agent/run-state.ts:130` (GET and POST credits are added into the run total), surfaced as `provider_reported.credits` in `src/budget/cost-receipt.ts:156,219`.

## Verification run
- `npx vitest run tests/unit/core/usage-extract.test.ts`: 16/16 pass.
- `biome check` on both files: clean. `npm run typecheck`: clean.
- Behaviour probe (scratch copy of the module, run under node --experimental-strip-types); results quoted below.

## Overall
The change is small, correct for the shapes named in #341, and does not produce a false positive on any account endpoint multix calls today. No blocking findings. A comment claims more than the code does, the tests miss a few cases, and one semantic risk should be recorded.

## Provider false-positive sweep (balances now reported as spend)
The only paths whose result changes are leaves that contain a spend word AND either match `BALANCE_LEAF` or sit under a `BALANCE_PARENT`. Account/me endpoints multix calls:
- HeyGen `GET /v3/users/me` (`src/providers/heygen/client.ts:253`). The documented schema has `wallet.remaining_balance`, `wallet.auto_reload.*`, `subscription.credits.{premium,add_on}_credits.{remaining,resets_at}`, `usage_based.{spending_current_usd, spending_cap_usd, included_credits, remaining_credits}`. None contain used/spent/consumed/cost/charged as a whole word (`spending` is not `spent`). No change.
- Leonardo `GET /me` (`src/providers/leonardo/commands/me.ts:18`): `user_details[].{apiCredit, subscriptionTokens, paidTokens, ...}`. No spend words. No change.
- ElevenLabs `GET /v1/user` (`src/providers/elevenlabs/commands/account.ts:42`): `subscription.character_count/limit`. No credit leaf, so it is never a credit. No change.
- No multix command calls OpenRouter `/credits` or `/key`, the Runway `/organization` endpoints, or fal billing (grep over `src/providers/**`).
Result: no live regression.

## Critical / High
None.

## Medium

M1. The JSDoc claims `unused_credits` stays a balance, but it does not (`src/core/usage-extract.ts:50-54`, test at `tests/unit/core/usage-extract.test.ts:112-116`).
`unused` is not in `BALANCE_LEAF`, so a top-level `unused_credits` or `unusedCredits` is reported as credits spent. Probe output:
`{"unused_credits":40} => 40`, `{"unusedCredits":40} => 40`.
The test "matches spend words whole, so unused credits stay a balance" passes only because each case also contains a balance signal (`quota` in the leaf, or the `subscription` parent). It proves only that `unused` does not match `used` as a whole word. It does not prove that unused credits are treated as a balance. The gap existed before this commit, but the commit adds a comment and test name that state otherwise.
Fix: either add `unused` (and arguably `left`, which #341 also mentions) to `BALANCE_LEAF` and add a bare `{ unused_credits: 40 }` case, or reword the comment and test name to "`unused` is not read as the spend word `used`".

M2. Period-to-date or lifetime counters under a balance parent now count as run spend (semantic risk, not live).
`{"subscription":{"credits_used_this_period":3500}} => 3500` and `{"wallet":{"lifetime_credits_spent":12000}} => 12000`. Both were dropped before this commit.
On an account GET, such a leaf is the account's running total, not this run's charge. `run-state.ts:130` adds GET credits into the run total, so a call like `<provider> me` would inflate `provider_reported.credits` in the receipt by the whole month's usage.
#341 explicitly asks for `subscription.credits_used` to count, so this follows the issue author's decision, and no provider returns such a key today. Record it as a known limitation, or restrict the override to leaves outside a `BALANCE_PARENT`, so that only the leaf-substring case from #341 (`quota_credits_used`, `included_credits_used`) is fixed. Do not change this without the issue author's input.

## Low

L1. Tokenizer misses a spend word glued to digits or to an acronym (`src/core/usage-extract.ts:58-62`).
`([a-z0-9])([A-Z])` splits lower-to-upper only, and the word split keeps digits attached:
- `quotaCreditsUsed30d => undefined` (`used30d` is not a word), while `quota_credits_used_30d => 5`.
- `remainingCreditsUSEDToday => undefined` (no split between an uppercase run and the next capitalised word).
- `includedCREDITSUSED => undefined` (an all-caps run has no word boundary).
`APICreditsUsed`, `API_CREDITS_USED`, `creditsUsedByAPI`, `includedCreditsUsedByAPI`, `quotaCreditsUsedV2` and `credits-used` all work.
A fuller split would be `.replace(/([a-z])([A-Z0-9])|([0-9])([A-Za-z])|([A-Z])([A-Z][a-z])/g, ...)`, or split letters from digits with `/[a-z]+|[0-9]+/g` after lower-casing camel boundaries. These are hypothetical shapes, so this is low priority.

L2. The test `remainingCreditCost` asserts a questionable classification (`tests/unit/core/usage-extract.test.ts:103`).
"Remaining credit cost" reads naturally as an outstanding budget. The `cost` override also turns `credit_cost_remaining` into spend (`=> 9`; it was a balance before). No provider uses these keys. Keeping one of them as a pinned spend case fixes an ambiguous name in place. Prefer an unambiguous case such as `includedCreditsCost`, or drop it.

L3. Test gaps worth one line each:
- A bare `{ unused_credits: 40 }` (see M1).
- An acronym case (`APICreditsUsed`) and an all-caps snake case (`API_CREDITS_USED`), since the commit claims camelCase support.
- A regression guard that a pure balance next to a spend leaf in an account-shaped body still stays out, for example the HeyGen `/v3/users/me` shape with `usage_based.remaining_credits`. The existing test at line 87 partly covers this.
- An end-to-end check through `run-state` summing is not needed; the unit level is enough.

## Scout notes / edge cases checked
- Array-index stripping (`[\d+]$`) is unaffected; numeric array items are never metric leaves.
- `ESTIMATE_PATH` is still applied after the balance check, so `estimatedCreditsUsed` is still excluded.
- `max_credits_used` and `credits_used_limit` are still excluded by `SKIP_KEY` before classification.
- `cost_usd` selection is unaffected in practice: it needs an exact leaf name (`cost|total_cost|cost_usd|usd`), so the `cost` override only matters for credit leaves.
- Key order: `{quota_credits_used: 2, quota_credits: 40}` gives 2, and the reverse order also gives 2 because the balance is skipped.
- `worker/` does not import `usage-extract.ts`, so `check:mcp` is not needed. No `node:*` imports were added.
- Docs: `docs-site/.../for-ai-agents.md:74` stays accurate. No docs change is needed.
- Process: #341 has a second claim (session_013TK1..., branch `xramjw`, which targets `dev`). This branch's claim is listed first and wins under AGENTS.md. The second session should be told so that two PRs are not opened.

## Plan / issue follow-up
The #341 expected behaviour is met: a leaf containing used/spent/consumed/cost/charged is no longer a balance, and each listed key shape has a test. The optional items (`credits_left`, `account.credits`, OpenRouter `total_credits`) are correctly left out because no command calls those endpoints.

## Recommended actions
1. Fix M1: correct the comment and test name, or add `unused` to `BALANCE_LEAF` with a bare-key test.
2. Note M2 in the PR body as a known limitation, or ask the #341 author whether parent-scoped counters should count.
3. Optional: L1 tokenizer hardening and L2/L3 test tweaks.

## Unresolved questions
- Should an account-level "used this period" counter under `subscription`/`wallet` ever be reported as run spend (M2)?
