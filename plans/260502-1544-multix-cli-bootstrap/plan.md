---
title: "Bootstrap multix CLI (NodeJS/TS port of ai-multimodal)"
description: "Publishable npm CLI + Claude skill that ports Python ai-multimodal scripts to TypeScript"
status: pending
priority: P2
effort: ~22h
branch: main
tags: [cli, typescript, ai, multimodal, bootstrap]
created: 2026-05-02
---

# Plan: multix CLI Bootstrap

Port `claudekit/ai-multimodal/scripts/*.py` (~3.5K LOC) to a strict-TS, ESM, npx-runnable CLI named `multix`, plus a companion Claude skill describing how to invoke it.

Source scout: [`plans/reports/scout-260502-1544-source-scripts.md`](../reports/scout-260502-1544-source-scripts.md)

## Stack (KISS)
TypeScript strict · ESM · commander · zod · execa · undici/native fetch · dotenv · vitest · tsup · biome.

## Phases

| # | File | Title | Status |
|---|------|-------|--------|
| 01 | [phase-01-scaffold-package.md](phase-01-scaffold-package.md) | Scaffold package, tsconfig, build, lint, bin entry | pending |
| 02 | [phase-02-shared-core.md](phase-02-shared-core.md) | Shared core (logger, env resolver, errors, http, output dir) | pending |
| 03 | [phase-03-providers-gemini.md](phase-03-providers-gemini.md) | Gemini provider (analyze/transcribe/extract/generate/video) | pending |
| 04 | [phase-04-providers-minimax.md](phase-04-providers-minimax.md) | MiniMax provider (image/video/speech/music) | pending |
| 05 | [phase-05-providers-openrouter.md](phase-05-providers-openrouter.md) | OpenRouter image generation | pending |
| 06 | [phase-06-media-optimizer.md](phase-06-media-optimizer.md) | Media optimizer (ffmpeg/imagemagick wrappers) | pending |
| 07 | [phase-07-document-converter.md](phase-07-document-converter.md) | Document converter (Gemini Files API) | pending |
| 08 | [phase-08-check-command.md](phase-08-check-command.md) | `multix check` diagnostics | pending |
| 09 | [phase-09-tests-and-ci.md](phase-09-tests-and-ci.md) | Vitest + GitHub Actions CI matrix | pending |
| 10 | [phase-10-docs-readme-skill-publish.md](phase-10-docs-readme-skill-publish.md) | README, LICENSE, CHANGELOG, SKILL.md, publish workflow | pending |

## Dependency Graph
```
01 ─┬─> 02 ─┬─> 03 ─┐
    │      ├─> 04 ─┤
    │      ├─> 05 ─┤
    │      ├─> 06 ─┤─> 09 ─> 10
    │      ├─> 07 ─┤
    │      └─> 08 ─┘
```
Phases 03-08 can run in parallel after 02; 09 gates 10.

## File Ownership Map (no overlap)
- 01: `package.json`, `tsconfig.json`, `tsup.config.ts`, `biome.json`, `src/cli.ts`, `src/index.ts`
- 02: `src/core/**`
- 03: `src/providers/gemini/**`, registers under `src/cli.ts` via dynamic command import
- 04: `src/providers/minimax/**`
- 05: `src/providers/openrouter/**`
- 06: `src/commands/media/**`
- 07: `src/commands/doc/**`
- 08: `src/commands/check.ts`
- 09: `tests/**`, `.github/workflows/ci.yml`
- 10: `README.md`, `LICENSE`, `CHANGELOG.md`, `skill/SKILL.md`, `.github/workflows/publish.yml`

NOTE: Each provider/command phase appends a registrar export consumed by `src/cli.ts` (registry pattern) — only phase 01 touches `src/cli.ts` skeleton; later phases add files to `src/commands/index.ts` registry without editing `cli.ts`.

## Success Criteria
- `npx multix --help` lists all 6 top-level commands.
- `multix check` returns non-zero only when no provider keys configured.
- Vitest green on Node 20 + 22; tsup build emits `dist/cli.js` (executable shebang).
- `npm pack` produces a tarball <500 KB.
- `skill/SKILL.md` documents invocation patterns for Claude.

## Unresolved Questions
1. Veo video gen — keep flag, mark experimental? (assume yes)
2. Default output dir — `./multix-output/` (decided: yes, override via `MULTIX_OUTPUT_DIR`)
3. Pillow replacement — `magick` shell-out only, no native deps. (decided)
