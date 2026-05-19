---
phase: 6
title: "Release Validation and Publish Prep"
status: complete
priority: P2
effort: "2h"
dependencies: [5]
---

# Phase 6: Release Validation and Publish Prep

## Context Links

- Publish workflow: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/.github/workflows/publish.yml`
- CI workflow: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/.github/workflows/ci.yml`
- Package: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/package.json`

## Overview

Validate the provider end-to-end, prepare minor release, and preserve the tag-driven npm release workflow.

## Requirements

- Functional: build, typecheck, lint, tests pass.
- Functional: compiled `dist/cli.js` exposes `openai` commands.
- Functional: release prep includes version bump plan and changelog.
- Non-functional: no live API secrets in git, tests, or docs.
- Non-functional: live smoke tests are manual/optional unless keys are present.

## Architecture

Release remains tag-driven:

```text
merge feature -> bump package version -> tag vX.Y.Z -> GitHub Action -> npm publish --provenance
```

This phase should verify readiness, not push/release unless the user explicitly asks during cook/ship.

## Related Code Files

- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/package.json`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/package-lock.json`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/CHANGELOG.md`

## Implementation Steps

### Tests Before

1. Record current package version and latest npm version:

```bash
node -p "require('./package.json').version"
npm view @mrgoonie/multix version
```

2. Run baseline validation before release edits:

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

### Refactor

3. Bump minor version after implementation is stable.
4. Ensure `package-lock.json` version updates with `npm install --package-lock-only` if needed.
5. Ensure `CHANGELOG.md` has OpenAI provider entry.

### Tests After

6. Re-run full validation.
7. Run package smoke:

```bash
npm pack --dry-run
node dist/cli.js openai --help
node dist/cli.js openai generate --help
node dist/cli.js openai transcribe --help
```

8. Optional live smoke only when credentials are intentionally available:

```bash
multix openai generate --prompt "small blue square icon" --output /tmp/multix-openai-test.png
multix openai generate-speech --text "hello" --output /tmp/multix-openai-test.mp3
multix openai transcribe --input /tmp/sample.mp3 --format text
```

### Regression Gate

```bash
npm run build && npm run typecheck && npm run lint && npm test && npm pack --dry-run
```

## Success Criteria

- [x] Full local validation passes.
- [x] Package dry-run includes `dist`, README, skill, license, changelog.
- [x] Version/changelog ready for minor release.
- [x] No secrets or auth artifacts are staged.

## Risk Assessment

- Risk: release conflicts if main moved. Mitigation: merge/sync current main before tagging.
- Risk: CI differs from local. Mitigation: publish workflow already runs install, lint, typecheck, build, test before npm publish.

## Security Considerations

- Run secret hygiene check before commit/tag.
- Do not commit `.env`, Codex auth files, generated test media with embedded sensitive data.
