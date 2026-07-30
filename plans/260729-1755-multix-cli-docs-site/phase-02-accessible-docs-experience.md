---
phase: 2
title: "Accessible docs experience"
status: complete
priority: P1
dependencies: [1]
---

# Phase 2: Accessible docs experience

## Requirements

- Responsive header/sidebar/table-of-contents with no horizontal scrolling.
- Theme control supports system/light/dark and stores only the chosen theme.
- Cmd+K/search opens via keyboard, searches page headings/body, manages focus,
  supports escape/arrow/enter, and has a visible trigger.
- Render code blocks with Copy buttons and success/error feedback.
- Include semantic landmarks, skip link, focus styles, contrast-safe colors,
  and reduced-motion behavior.

## Files

- Create: Starlight component/CSS overrides and browser tests inside
  `docs-site/**`.
- Modify: Starlight configuration and docs-site tests.

## Validation

- Test keyboard panel interactions and copy behavior with a DOM-capable test
  harness or focused browser smoke check.
- Test both locale path sets and viewport navigation states.

## Risks

- Search index size. Use Starlight/Pagefind's static client-side index; no
  third-party analytics or hosted search dependency.
