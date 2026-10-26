# Code review: usage balance vs credits spent (issue #302)

Commit: 85b3295 `fix(agent): never report an account credit balance as credits spent`
Scope: src/core/usage-extract.ts (+9), tests/unit/core/usage-extract.test.ts (+53), docs-site for-ai-agents.md (en, vi; 1 line each). Diff vs origin/main is exactly this commit.

## Verdict
No blocking findings. The fix is narrow, sits only in the promotion loop (metrics collection is unchanged), and the new tests fail on origin/main.

## Findings (by severity)

### Medium: the docs and the code comment say the HeyGen wallet balance "stays in metrics", but it is never collected
- docs-site/src/content/docs/reference/for-ai-agents.md:71, vi/reference/for-ai-agents.md:71, src/core/usage-extract.ts:34-37
- `walk()` keeps a numeric leaf only when the key matches METRIC_KEY or the parent path matches `usage|metrics|billing|extra_info`. `data.wallet.remaining_balance` and `data.subscription.credits.*.remaining` match neither, so they never reach `metrics`. A probe with the test's HeyGen body returned only `data.usage_based.{spending_current_usd,included_credits,remaining_credits}`.
- Failure scenario: an agent reads the docs, runs `heygen me`, and looks for the wallet balance in `usage.metrics`. It is not there. This is a documentation inaccuracy only; it does not cause wrong numbers.
- Fix: change the wording to "(Leonardo `apiCredit`, HeyGen usage-based remaining/included credits) is never reported as `credits` or `cost_usd`". Or drop "stays in metrics" for the wallet. Apply the same change to the code comment.

### Low: BALANCE_PATH matches the whole path, not the leaf, so a spend field under a balance-named parent is excluded
- src/core/usage-extract.ts:39,150
- Probes: `{subscription_job:{credits:4}}` and `{usage:{total_credits:5}}` now produce no `credits`. `{job:{api_credit:3}}` is excluded by `(^|\.)api_?credits?$`.
- I checked every spend path in src/providers/** and none of them hits this: Leonardo `*.apiCreditCost`, Runway `cost.credits`/`estimatedCost.credits`, OpenRouter `usage.cost`, BytePlus/OpenAI `usage.*_tokens`, Gemini usageMetadata/omni `usage.total_*_tokens`, Replicate/fal `metrics.*_time`, MiniMax `extra_info.*`, AtlasCloud `price`, and the ElevenLabs `character-cost` header (headers are handled after the loop). Probes confirm Leonardo `sdGenerationJob.apiCreditCost` still gives credits=8.
- The risk is hypothetical and applies to future providers. `total_credits` is the most ambiguous token, because some APIs use it for credits consumed. Optional hardening: test the words that name a container (`wallet|subscription|user_details`) against path segments, and test the rest against the leaf only.

### Informational (pre-existing, not introduced by this commit): Runway credits may come from estimatedCost
- src/core/usage-extract.ts:157. The first leaf containing "credit" wins, so `{estimatedCost:{credits:10}, cost:{credits:0}}` gives credits=10 (probed).
- This only matters if Runway still returns `estimatedCost` on terminal tasks. Per the AGENTS.md rule for unrelated bugs, open a separate issue with evidence rather than widening this PR.

## Specific checks requested
1. False exclusion of real spend paths: none found in the current providers (see Low above).
2. Missed balance fields: the account endpoints that commands actually call are Leonardo `/me` (leonardo/commands/me.ts:18), HeyGen `/v3/users/me` (heygen/client.ts:253) and ElevenLabs `user` (elevenlabs/commands/account.ts:38). All three are covered. ElevenLabs `subscription.character_count` was never promoted, and it is now also behind `subscription`. No Runway `/v1/organization`, OpenRouter `/credits` or `/key` call exists. The only promotion-capable HeyGen field, `usage_based.included_credits`, is now excluded.
3. Tests: they are meaningful. I ran the new test file against origin/main's usage-extract.ts. Both new tests fail ("expected 1000 to be undefined", "expected 992 to be 8"), and each case in the loop also promoted under the old code (credits_remaining, available_credits, billing.balance.usd as cost_usd, total_credits). On HEAD, `npx vitest run tests/unit/core/usage-extract.test.ts` gives 7/7 passed. Gap: no assertion covers the wallet field, which is how the Medium docs issue went unnoticed.
4. Docs: the English and Vietnamese lines say the same thing. Apart from the wallet wording (Medium), they are accurate.

## Checklist
Concurrency: N/A (pure function). Error handling: unchanged. API contract: `ResponseUsage` shape unchanged. Backward compatibility: fewer false `credits` values in the envelope and history; no schema change. Authz/N+1/data leaks: N/A.

Status: DONE
Summary: No blocking issues. The fix is correct for every provider path in the repo, and the tests fail on the old code. The docs and the comment wrongly say the HeyGen wallet balance appears in metrics. Full-path matching is a minor future false-exclusion risk.

## Resolution (author)

- Finding 1: fixed. Docs (EN/VI) and the code comment now say balances are never reported as `credits` or `cost_usd`, without claiming the HeyGen wallet appears in `metrics`.
- Finding 2: fixed. Balance words match the leaf key; container names (`wallet`, `subscription`, `user_details`, `balance(s)`) match whole parent segments, so `subscription_job.credits` still counts. `total_credits` was dropped as ambiguous (no current caller). Regression test added.
- Finding 3: not in scope; it is the estimate-vs-cost bug tracked by #298 (PRs #300/#301 add the estimate-path skip).
