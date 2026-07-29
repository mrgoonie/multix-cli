---
phase: 4
title: "Diagnostics documentation and release validation"
status: completed
priority: P1
effort: "3-5h"
dependencies: [2, 3]
---

# Phase 4: Diagnostics documentation and release validation

## Overview

Integrate image, speech, and narrowly-curated video commands into the CLI and setup surface, then run the repository’s release-quality checks.

## Requirements

- `multix check` reports native Cloudflare usable only when account ID and token are both configured, and separately reports video usable only with Gateway ID plus Replicate token; redact every credential and never print account/token values unnecessarily.
- Document direct vs Gateway permissions/configuration, static catalog, payload-log default, image/TTS/video examples, and the separate Replicate credential boundary with Cloudflare source links.
- Smoke help must list `cloudflare`, `generate`, `generate-speech`, `generate-video`, and `video-status`.

## Related code files

- Modify: `src/commands/index.ts` — import/register Cloudflare provider.
- Modify: `src/commands/check.ts` — Cloudflare configuration readiness and safe summary.
- Modify: root configuration documentation — account, token, optional gateway/model/logging key names only.
- Modify: `README.md` — provider matrix, configuration table, examples, direct/Gateway behavior, non-goals.
- Modify: `tests/unit/commands/check.test.ts` — complete/incomplete Cloudflare readiness and redaction expectations.
- Modify: `tests/smoke/cli.test.ts` and `tests/smoke/parse-args.test.ts` — registration/help contract.

## Tests first

1. Add check-command cases for account-only, token-only, native-ready, video-missing-gateway, video-missing-Replicate-token, video-ready, and redacted output.
2. Add compiled-help assertions for top-level Cloudflare and its image, speech, and video subcommands.
3. Review examples against the static catalog and configuration names before editing documentation.

## Implementation steps

1. Register the provider after Phase 2/3 command tests pass; extend diagnostics without a billed live media ping.
2. Update configuration documentation and README with safe placeholders, permission notes, and documented URL references. Never add real credentials or raw request traces.
3. Run `npm test`; then `npm run lint`, `npm run typecheck`, and `npm run build`.
4. Re-run smoke tests against fresh `dist`, inspect `git diff --check`, and verify no generated output/media or credential material is staged.

## Success criteria

- [ ] Setup/docs make direct and Gateway selection unambiguous without exposing credentials.
- [ ] Check and help tests prove the supported media surface and its distinct credential requirements.
- [ ] Full lint, typecheck, build, and test suite pass before a later release decision.

## Risks and rollback

Do not add a live `check` ping: image/TTS can bill or generate artifacts. The release remains a normal feature PR; version bump/publish occurs only through the existing Release Please workflow after review.
