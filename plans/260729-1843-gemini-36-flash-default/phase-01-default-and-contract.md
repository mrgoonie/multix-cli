---
title: "Gemini 3.6 Flash default and contract"
status: complete
---

# Phase 01: Default and contract

## Files

- Modify `src/providers/gemini/models.ts`.
- Modify `tests/unit/providers/gemini/models.test.ts`.
- Modify the environment template, `README.md`, and `skill/SKILL.md`.

## Steps

1. Change the shared text default to the stable Gemini 3.6 Flash ID.
2. Update the default-resolution assertion while retaining override precedence tests.
3. Update every active user-facing text-default reference without touching historical
   changelogs or completed plans.
4. Run the focused unit test, lint, typecheck, build, full test suite, and help smoke.

## Success criteria

- No media-output model changes.
- No public override regression.
- Every stated default matches the actual shared constant.

## Validation

- Focused model-default tests pass.
- Lint, typecheck, build, full tests (245), CLI help, and `git diff --check` pass.
