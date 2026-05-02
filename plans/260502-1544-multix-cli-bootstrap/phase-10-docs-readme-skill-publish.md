# Phase 10 — Docs, Readme, Skill, Publish

## Context
- Plan: [plan.md](plan.md)
- Depends on: phase-09 (CI green).

## Overview
- Priority: P1
- Status: pending
- Goal: ship-ready repo — README, LICENSE, CHANGELOG, companion Claude skill, npm publish workflow stub.

## Key Insights
- Companion skill follows `/ck:agentize` pattern: `skill/SKILL.md` declares how Claude should invoke `npx multix ...`.
- npm publish workflow is manually triggered (workflow_dispatch) gated on tag `v*`.
- README must include: install, env vars, command reference matrix, troubleshooting, links.

## Requirements
Files:
- `README.md` — install via `npm i -g multix` or `npx multix`; env var table; command-by-command examples ported from Python `--help` epilogs.
- `LICENSE` — MIT (Duy Nguyen, 2026).
- `CHANGELOG.md` — `0.0.1 — initial release` seed.
- `skill/SKILL.md` — frontmatter + invocation patterns + decision tree (when to use which subcommand).
- `.github/workflows/publish.yml` — `workflow_dispatch` + tag trigger; runs build + test + `npm publish --access public`.
- `.npmignore` — exclude tests, plans, .github, .env*.

## Architecture
```
README.md           # human + LLM facing
skill/
  SKILL.md          # for Claude Code skill catalog
LICENSE
CHANGELOG.md
.github/workflows/
  ci.yml            # from phase-09
  publish.yml       # this phase
```

## SKILL.md Outline
```
---
name: multix
description: AI multimodal CLI (Gemini/MiniMax/OpenRouter, ffmpeg/imagemagick, doc-to-md)
---
# When to use
- User asks to generate/analyze image/video/audio/music
- User asks to optimize media or convert documents to markdown

# Invocation
- multix check
- multix gemini analyze --files ... --prompt ...
- multix gemini generate --prompt ... --aspect-ratio 16:9
- multix minimax generate-video --prompt ...
- multix media optimize --input ... --output ... --target-size 100
- multix doc convert -i ... -o ...

# Required env
GEMINI_API_KEY | OPENROUTER_API_KEY | MINIMAX_API_KEY (at least one)
```

## Related Code Files
Create: `README.md`, `LICENSE`, `CHANGELOG.md`, `skill/SKILL.md`, `.github/workflows/publish.yml`, `.npmignore`.
Modify: `package.json` — confirm `files` whitelist + `repository` + `keywords`.

## Implementation Steps
1. Author `README.md` (sections: Install, Quick Start, Commands, Env, Troubleshooting, Contributing).
2. Author `LICENSE` (MIT template).
3. Author `CHANGELOG.md` keep-a-changelog format, seed 0.0.1.
4. Author `skill/SKILL.md` per outline above.
5. Author `.github/workflows/publish.yml`:
   - Triggers: `workflow_dispatch`, `push: tags: ['v*']`.
   - Steps: setup-node, `npm ci`, `npm run build`, `npm test`, `npm publish --provenance --access public` (uses `NODE_AUTH_TOKEN` secret).
6. Update `package.json`: `repository.url`, `homepage`, `keywords` (`cli`,`ai`,`multimodal`,`gemini`,`minimax`,`openrouter`,`ffmpeg`).
7. Run `npm pack --dry-run` to verify tarball contents.
8. Tag and trigger publish (manual gate).

## Todo List
- [ ] README.md
- [ ] LICENSE
- [ ] CHANGELOG.md
- [ ] skill/SKILL.md
- [ ] .github/workflows/publish.yml
- [ ] .npmignore
- [ ] package.json metadata polish
- [ ] npm pack dry-run verification

## Success Criteria
- `npm pack --dry-run` shows only `dist/`, `skill/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`.
- README documents every subcommand from phases 03-08.
- Publish workflow exists but does not run automatically on push.
- Tarball <500 KB.

## Risk Assessment
| Risk | L | I | Mitigation |
|------|---|---|-----------|
| Accidentally publishing tests/plans | M | H | `files` whitelist + `.npmignore` + `npm pack --dry-run` review |
| Provenance fails for unauth publish | L | M | Document `NPM_TOKEN` secret setup in README |
| README drifts from CLI flag surface | H | M | CI step: `node dist/cli.js --help` snapshot diff (defer; YAGNI v1) |

## Security Considerations
- Never commit `NPM_TOKEN`; use GH secret.
- `.npmignore` excludes `.env*`, `plans/`, `tests/`, `.github/`.
- Tag protected branch policy on `main` (manual setup, not in repo).

## Next Steps
Backlog candidates (post v0.0.1):
- Key rotation (port `api_key_rotator`)
- `multix all generate ...` cross-provider fallback wrapper
- Snapshot test for `--help` output to prevent README drift
- Veo video full support once SDK stable
