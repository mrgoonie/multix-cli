# Code review: c10ca2f fix(agent): keep spend keys such as *_credits_used out of the balance skip

Scope: `src/core/usage-extract.ts` (+15), `tests/unit/core/usage-extract.test.ts` (+26). Closes #341.

## Verdict

Fixes the three shapes the issue names and the tests prove it. Not ready to land as is: another
session claimed #341 first and has already pushed a competing fix (H1). The override also
turns a few balance and cumulative-account shapes into reported spend (M1, M2).

## Findings

### H1 (process, blocking): duplicate of an earlier claim
Issue #341 comments: `11:00:32Z Claimed by Claude Code routine session, branch claude/gracious-heisenberg-k5dsyx`,
then `11:00:47Z Claimed by session_013TK1rYAf9M9B9NGQsrYUdi, branch claude/gracious-heisenberg-xramjw` (this branch).
Branch `k5dsyx` has commit 912a06b at 11:02:28Z, "fix(agent): report spend keys that name a balance as credits spent",
which touches the same two files. AGENTS.md says the claim listed first wins: stop, support that branch
(review it, or carry over evidence such as these tests), and post `Released` on #341. Do not open a second PR.

### M1: account cumulative usage now outranks the per-request charge
The spend check runs before the parent check, so a spend leaf under `subscription`/`wallet`/`balances`/`user_details`
is no longer skipped. extractUsage takes the first credit leaf in key order. Probe:
`{ subscription: { credits_used: 1200 }, job: { credits: 5 } }` gives `credits = 1200` from `body.subscription.credits_used`.
Before this commit it gave 5. The same happens for cost: `{ subscription: { usage: { cost: 12.5 } } }` now sets
`cost_usd = 12.5`. A month-to-date `credits_used` on an account object is not what this request spent, and
#302/#306 existed to keep `/me` account data out of `usage.credits`. The issue asks for `subscription.credits_used`
to count, so this follows the spec. Still, either confirm the trade-off on #341, or give a non-parent credit leaf priority
over one reached only through the spend override. No provider returns these shapes today (per #341), so
the risk is latent.

### M2: whole-word match still lets some balance leaves through
Under a balance parent, a credit leaf that contains a spend word is now reported as spend even when it names a balance or cap:
- `subscription.credits_not_used` / `creditsNotUsed` gives credits 40 (negation not handled)
- `subscription.credits_used_cap` gives 1000 (`cap` is not in SKIP_KEY; `limit`/`max_` are)
- `wallet.credits_cost_remaining` gives 40 (the spend word wins over `remaining` in the same leaf)
Possible fix: when the leaf also matches BALANCE_LEAF, or contains `not|cap|left`, treat it as a balance.
These shapes are uncommon. Severity is medium because the result is a wrong money number, not a dropped one.

### L1: spend shapes still dropped (beyond the issue's word list)
`subscription.credits_spend`, `subscription.credits_deducted`, `included_credits_billed`, `quota_credits_usage`
and `subscription.creditsUsed30d` all give `credits = undefined`. The last fails because the camel split leaves `used30d`
as one word: `([a-z0-9])([A-Z])` adds no break between letters and digits. The issue lists only
used|spent|consumed|cost|charged, so these are out of scope. Add `spend` and a letter/digit split if a provider needs them.

### L2: tests
The tests mean something. The positive loop covers snake, camel (`creditsSpent`) and every balance parent with one
assertion per path, and each value is 5 so a wrong source would fail. The negative test would fail a substring
implementation, because `included_unused_credits` and `unusedCredits` contain "used". `{ quota_credits: 40 }` adds little,
since it has no spend word. Missing: a kebab case (`credits-used`, works in the probe), a digit case, and a mixed body
that pins which leaf wins (M1).

## Evidence
- `npx vitest run tests/unit/core/usage-extract.test.ts`: 15/15 passed.
- Probe: esbuild bundle of `src/core/usage-extract.ts` run under node. Outputs as quoted above. Kebab
  `subscription["credits-used"]` gives 7, `user_details[0].apiCreditsUsed` gives 3 (apiCredit 900 still skipped),
  `{remaining_credits: 9, credits_used: 3}` gives 3.
- Lint, typecheck and build were not run (change is limited to one regex helper and its tests).
