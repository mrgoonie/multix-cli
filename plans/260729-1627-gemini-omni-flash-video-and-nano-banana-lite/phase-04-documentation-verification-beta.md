---
phase: 4
title: "README, full verification, and beta release evidence"
status: in_progress
priority: P1
effort: "4h"
dependencies: [2, 3]
---

# Phase 04: README, Full Verification, and Beta Release Evidence

## Overview

Document the exact user-facing contracts and prove the feature through automated gates plus a deliberate paid-preview beta smoke. This phase publishes nothing by itself.

## Requirements

- Update the Gemini command examples/model notes in `README.md` with Omni command examples, the explicit interaction-ID edit loop, the provider-side storage/retention trade-off, output behavior, billing/preview status, and each published limitation.
- Document Nano Banana 2 Lite’s exact model ID, 1K-only constraint, accepted aspect ratios, and multi-reference/multi-turn caveat alongside existing image guidance.
- Do not claim availability in the EEA/CH/UK for uploaded-video edits, audio refs, video extension/interpolation, or voice editing.
- Execute automated tests without credentials and a manually authorized paid smoke with credentials supplied only through the normal local environment. Never commit API keys, output media, interaction IDs, or captured customer content.

## Related code files

- Modify: `README.md`
- Read only: `CHANGELOG.md`, `release-please-beta-config.json`, `package.json`
- Validate: `tests/unit/providers/gemini/*.test.ts`, `tests/smoke/cli.test.ts`, `tests/smoke/parse-args.test.ts`

## Implementation steps

1. Write README examples from the compiled command help and verified behavior; keep documentation in the existing Gemini section rather than creating a parallel guide.
2. Run focused Gemini unit and smoke suites, then `npm run typecheck`, `npm test`, `npm run lint`, and `npm run build`; fix real failures before proceeding.
3. On a billing-enabled non-EEA/CH/UK account where uploaded-video editing is available, run four manual beta checks: URI-delivered prompt-to-video, edit with returned interaction ID, Lite prompt-to-image, Lite single-reference edit. Confirm Files reach `ACTIVE`, downloads are playable, and interaction IDs change between turns.
4. Record only redacted command shape, version, exact commit SHA, pass/fail, and npm beta package/version receipt in the PR/release evidence. Use the existing dev Release Please prerelease flow; do not manually tag or promote stable.

## Success criteria

- [x] README matches actual help and describes all material constraints.
- [x] Automated quality gates are green on the final source, not an earlier build.
- [ ] Paid-preview smoke has evidence for the four scoped scenarios or a documented external access blocker.
- [ ] Beta package is released through the dev workflow, then installed and smoke-checked by exact version before any stable decision.

## Risks and mitigations

- Preview API availability/billing may block live smoke. Treat that as a release blocker, not a reason to weaken tests or fabricate evidence.
- Documentation can overpromise. Compare every claim against the implemented validation and the supplied API limitations before merge.
