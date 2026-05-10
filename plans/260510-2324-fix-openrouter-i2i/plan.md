---
title: Fix OpenRouter image-to-image
description: ''
status: completed
priority: P2
branch: fix/openrouter-image-to-image
tags: []
blockedBy: []
blocks: []
created: '2026-05-10T16:29:22.798Z'
createdBy: 'ck:plan'
source: skill
---

# Fix OpenRouter image-to-image

## Overview

Fix OpenRouter image-to-image failure for `openai/gpt-5.4-image-2` (and any non-Gemini text+image model) caused by inverted `modalities` heuristic. Also harden response parser, surface better errors, add Recraft `--strength`, support `OPENROUTER_FALLBACK_MODELS` in i2i, update README.

**Test case:** `multix openrouter i2i --prompt "<vi prompt>" --ref tests/demo/zuey.png -m openai/gpt-5.4-image-2 -v` → must produce a saved PNG.

## Phases

| Phase | Name | Status |
|-------|------|--------|
| 1 | [Refactor & modalities fix](./phase-01-refactor-modalities-fix.md) | Completed |
| 2 | [Tolerant parser & better errors](./phase-02-tolerant-parser-better-errors.md) | Completed |
| 3 | [Recraft strength + i2i fallbacks](./phase-03-recraft-strength-i2i-fallbacks.md) | Completed |
| 4 | [Tests & README](./phase-04-tests-readme.md) | Completed |

## Dependencies

<!-- Cross-plan dependencies -->
