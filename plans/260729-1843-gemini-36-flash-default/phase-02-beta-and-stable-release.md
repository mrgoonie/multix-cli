---
title: "Gemini 3.6 Flash beta and stable release"
status: in_progress
---

# Phase 02: Beta and stable release

## Steps

1. Create the feature issue and PR to `dev`; resolve review findings, merge, and
   wait for target-branch CI.
2. Merge the normal dev Release Please PR, verify the beta npm receipt, and smoke
   the exact package version.
3. Create a second PR from current `main` with an equivalent, clean implementation.
   Verify its diff contains only the shared default, matching tests, and user-facing
   references; review, merge, and wait for `main` CI.
4. Merge the main Release Please PR; verify the stable GitHub release, npm
   `latest` receipt, and an exact-package smoke.

## Safety checks

- Never direct-push or force-push protected branches.
- Do not merge a dev-to-main promotion that includes unrelated commits.
- Do not disclose environment values, tokens, or test inputs in GitHub artifacts.
- Treat beta and stable Release Please versions as independent streams and verify
  receipts separately.
