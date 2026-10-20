---
title: "Gemini 3.6 Flash Default Support"
description: "Adopt the GA Gemini 3.6 Flash model as the default text-output model for Gemini CLI tasks."
status: in_progress
priority: P1
effort: "0.5d"
branch: "codex/gemini-36-flash"
tags: [gemini, models, release]
blockedBy: []
blocks: []
created: "2026-07-29"
source: "Feature request: Gemini 3.6 Flash; beta then stable"
---

# Plan: Gemini 3.6 Flash Default Support

## Outcome

Use GA `gemini-3.6-flash` as the default Gemini text-output model for `analyze`,
`transcribe`, `extract`, and document conversion. Existing explicit `--model`,
`GEMINI_MODEL`, and `MULTIMODAL_MODEL` overrides must continue to win.

## Scope and non-goals

- Change only the shared text default and direct documentation/tests that state it,
  including the environment template, README, and published `skill/SKILL.md` command reference.
- Keep Gemini Omni Flash, Veo, image models, and TTS defaults unchanged: Gemini
  3.6 Flash produces text output, not images, audio, or video.
- Do not add a Google SDK, a new credential, or an API-specific command.
- Release in two stages: merge to `dev`, publish and smoke the beta package, then
  carry only this feature onto a clean `main`-based stable PR. Do not promote the
  divergent whole `dev` branch into `main`.

## Acceptance criteria

- [ ] `TEXT_MODEL_DEFAULT`, analysis, and document defaults resolve to
      `gemini-3.6-flash` without environment overrides.
- [ ] `MULTIMODAL_MODEL` still takes precedence over `GEMINI_MODEL`; both keep
      their existing behavior for text tasks.
- [ ] Help, README, and the published skill identify Gemini 3.6 Flash as the text default and do not
      advertise unsupported media generation.
- [ ] Focused unit tests, lint, typecheck, build, full tests, and CLI help smoke pass.
- [ ] A new beta package is published; an exact installed beta package passes help
      smoke plus authorized no-override `analyze`, `transcribe`, JSON `extract`, and
      document-convert smoke cases, with all inputs and output identifiers redacted.
- [ ] An equivalent focused implementation is merged to `main`, stable CI passes,
      and the stable npm/GitHub release receipt plus exact `latest` package smoke are verified.

## Phases

| # | File | Title | Status |
|---|---|---|---|
| 01 | [phase-01-default-and-contract.md](phase-01-default-and-contract.md) | Default, tests, and user-facing model contract | complete |
| 02 | [phase-02-beta-and-stable-release.md](phase-02-beta-and-stable-release.md) | Serialized beta then stable release | in_progress |

## Risks and rollback

- Gemini model availability is external: retain the existing environment overrides
  so users can immediately select a compatible model.
- `dev` and `main` diverge. A stable delivery must be an equivalent feature-only PR
  based on current `main`; it cannot blindly cherry-pick the dev commit because main
  does not yet have the shared text-default abstraction. Inspect its commits before merge.
- Release Please may hold an existing beta Release PR. Reuse its normal update
  flow and confirm the final published version and dist-tags, rather than manually
  publishing from a working tree.

## Validation and red-team record

- Plan validation: scope maps to the single shared default in
  `src/providers/gemini/models.ts`; all four text surfaces read that constant.
  The release configuration also publishes `skill/SKILL.md`, so its model examples
  must match the shared default. The environment template and all active README/skill
  command examples are also direct user-facing references.
- Red-team: model capability is text output only; no routing changes to image,
  video, audio, or Omni flows are permitted. Stable release must avoid unrelated
  `dev` commits.
- Local evidence: focused model tests plus lint, typecheck, build, full 245-test
  suite, generated help, and whitespace validation passed. Code review corrected a
  published-skill metadata reference before shipping.

## Unresolved questions

None.
