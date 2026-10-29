# Plan: model & provider catalogue, usage, reviews (#414)

Status: in progress · Branch: `claude/gracious-heisenberg-8maah6` → `dev`

## Outcome
One catalogue (`multix.catalog/v1`) that the CLI (`multix catalog …`) and the
remote MCP/REST surface read from the same runtime-neutral code: providers,
model offerings, configuration-aware rate cards with provenance, equivalent-
configuration price comparison, usage from the local run ledger, local
ratings/reviews/use-case notes, and explainable recommendations.

## Constraints
- Extend `multix models`, `multix history`, `src/capabilities`, `src/budget`; do not replace them.
- No invented prices: unknown/stale/unverified stay `null` with a reason, never $0.
- Compare only offerings whose rate card confirms the requested configuration.
- Usage keys on the resolved model; attempts and logical operations stay apart; spend via `settleOperations`.
- Reviews/notes are local and private by default; secrets, signed URLs and e-mail addresses are scrubbed.
- Runtime-neutral modules (no `node:*`) under `src/catalog/`; file I/O stays in the command layer.

## Non-goals (this PR)
- Remote ledger dashboard and account-scoped usage (needs #294).
- Shared team/public reviews with moderation (needs a remote store; follows #294).
- Live price scraping at runtime; rate cards are dated static entries.

## Phases
1. `src/catalog/` types, rate cards (fal, Atlas Cloud), offerings, quotes, compare.
2. Usage aggregation from history; reviews/notes validation + local store; recommend.
3. `multix catalog` CLI; worker `multix_model_catalog` tool + `GET /api/v1/model-catalog`.
4. Tests (pricing variants, provenance/TTL, retry accounting, scrubbing, parity), docs EN/VI, skill.

## Acceptance
See issue #414 checklist; Phase 2/remote items are tracked as follow-ups.
