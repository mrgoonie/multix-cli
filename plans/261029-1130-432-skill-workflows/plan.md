# Skill workflows: run a skill's manifest after explicit authorization (#432)

Status: implemented; follow-ups #479 and #480. Phase 3 of #415 (phase 1 #420, phase 2 #431).

## Outcome

A published skill may ship `multix.workflow.json`, a manifest of multix CLI
steps. An account runs that workflow in the job sandbox only after it
authorized exactly that revision and manifest digest, over REST. MCP clients
describe, start, read and cancel runs with `multix_workflow`; they cannot
authorize.

## Constraints

- Reading a skill never runs anything. Running needs an authorization bound
  to the skill id, revision and manifest digest; a new revision, a different
  digest or a recreated skill voids it.
- Authorization is REST only (an API key from /dashboard), never MCP, so a
  model cannot authorize its own runs.
- Every step goes through the same checks as `multix_run`: catalog and command
  policy (`prepareRun`), operator caps, URL guard, spend guard and cost
  preflight. Steps are rendered from a manifest, never from free text: each
  value stays one argv element.
- Optional `max_cost_usd` on the authorization caps a whole run: each step
  must have a known price that fits the remaining budget (strict policy when
  the caps cannot bound the command).
- Tests mock every job backend; no paid API calls.

## Non-goals

- Branching, loops, parallel steps, scheduling, shell scripts or arbitrary code.
- Workflows in built-in skills.
- Background progress without a reader: a run advances when it is read.

## Design

- `skills/workflow-manifest.ts`: parse and validate the manifest (version 1,
  at most 10 steps and 20 inputs, 64 KiB, known runnable commands, references
  only to declared inputs and earlier steps), validate run inputs, render one
  step into a `RunRequest`. Templates: `{{inputs.name}}`,
  `{{steps.<id>.outputs[<n>]}}`. A value that is exactly one template keeps
  the input's type; an absent optional input leaves the value out.
- Publishing (`publish`, `publishDraft`) refuses an invalid manifest.
- `skills/workflow-store.ts` in the runner's `AccountSkills` object:
  `wfauth:<owner>:<name>` authorizations and `wfrun:<id>` runs, saved with a
  version check (compare and swap). At most 5 active and 50 stored runs per
  account; the oldest finished runs are pruned.
- `skills/workflow-manager.ts`: describe, authorize, revoke, start, status
  (advances the run), cancel, list. Starting a step takes a 2 minute lease
  first, re-checks the authorization and the served skill, then starts the job
  with `wait_seconds: 0`. A busy job slot leaves the step pending.
- Surfaces: MCP `multix_workflow` (describe, run, status, cancel, list); REST
  `/api/v1/workflows`, `/workflow-authorizations`, `/workflow-runs`.

## Acceptance

- No authorization, or one for another revision or digest: run refused.
- A command the policy refuses fails the run without starting a job.
- `max_cost_usd` is enforced across steps.
- Two concurrent readers start a step once; steps run in order and pass
  outputs forward.
- Templates cannot add arguments or flags.
- lint, typecheck, build, `npm test`, `check:mcp` and `verify:docs` pass.

## Files

- New: `worker/src/skills/workflow-manifest.ts`, `workflow-store.ts`,
  `workflow-manager.ts`, `workflow-tool.ts`,
  `worker/src/api/workflow-api-handlers.ts`
- Changed: `skill-registry.ts`, `account-skills.ts`, `skill-catalog.ts`,
  `mcp-server.ts`, `api-router.ts`, `api-http.ts`, `openapi-document.ts`
- Tests: `worker/test/skill-workflows.test.ts`, `rest-api.test.ts`
- Docs: README, docs-site MCP server and REST API guides (EN and VI),
  `skill/SKILL.md`
