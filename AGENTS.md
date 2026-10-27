# AGENTS.md — contributor and agent workflow

Rules for anyone (human or AI agent) changing `multix-cli`. Follow them so that
parallel contributors do not step on each other.

## Issue workflow

Every change starts from a GitHub issue. Before writing code:

1. Search open issues and PRs for duplicates. If a related or duplicate issue
   exists, comment on it with a link to the issue you are working on instead of
   opening a second thread.
2. Assign yourself to the issue (`gh issue edit <n> --add-assignee @me`). An
   issue that is already assigned and labelled `in progress` belongs to someone
   else: comment and coordinate before touching it. Agent sessions often share
   one GitHub account, so an assignee that is `@me` proves nothing; step 3
   decides.
3. Claim it with a comment `Claimed by <session>, branch <branch>`, then
   re-read the issue's comments. The claim listed first on the issue wins. If
   an earlier claim exists, stop and support it (review, evidence) instead of
   building a second fix. Release a claim you abandon with a `Released`
   comment. A claim with no linked branch, PR or comment for 24 hours is
   stale: claim it anew and link the stale claim.
4. Move the issue through the status labels as the work advances. Only one
   status label should be on an issue at a time — remove the previous one.

| Label | Meaning |
|---|---|
| `in progress` | Someone is implementing it now. |
| `blocked` | Waiting on something outside the change (credential, upstream fix, decision). Explain the blocker in a comment. |
| `in review` | Implementation finished; under code review in an isolated context (a separate reviewer or review agent that did not write the code). |
| `done` | PR opened and linked to the issue (`Closes #<n>` in the PR body). |
| `shipped` | PR merged into `main`. |

Priority labels (`priority: P1`–`P3`) are set during triage; pick the highest
priority unassigned issue first.

```bash
gh issue edit 123 --add-assignee @me --add-label "in progress"
gh issue edit 123 --remove-label "in progress" --add-label "in review"
gh issue edit 123 --remove-label "in review" --add-label "done"     # after the PR is opened
gh issue edit 123 --remove-label "done" --add-label "shipped"       # after merge
```

Where GraphQL is blocked (some agent sessions), `gh issue edit` fails; use the
REST routes instead:

```bash
gh api -X POST repos/mrgoonie/multix-cli/issues/123/labels -f 'labels[]=in review'
gh api -X DELETE "repos/mrgoonie/multix-cli/issues/123/labels/in%20progress"
```

Re-check right before you open a new issue or a PR, with direct reads rather
than `--search` (the search index lags behind by up to a minute, which is
exactly the window in which parallel sessions collide):

```bash
gh issue view 123 --json comments,closedByPullRequestsReferences   # claims and PRs that close it
gh pr list --limit 20                                               # newest open PRs first
gh issue list --limit 20                                            # newest open issues first
```

If another PR or issue already covers the work, do not open yours. When two
cover the same work, keep the one tied to the earliest claim (or, with no
claim, the one opened first); close the other with a link to it instead of
racing to merge, and carry over any evidence it adds.

Found an unrelated bug, security gap, or hardening opportunity while working?
Open a new issue for it (with evidence) rather than widening the current PR.

## Branches, commits, PRs

- Branch from `main`: `feat/<scope>-<slug>`, `fix/<scope>-<slug>`, `docs/<slug>`, `chore/<slug>`.
- Use a separate git worktree per issue when several issues are in flight.
- Conventional commits (`feat(replicate): …`, `fix(gemini): …`); release-please builds the changelog from them.
- One issue per PR; put `Closes #<n>` in the PR body.
- Do not merge release-please PRs as part of feature work; they publish to npm.
- `release-please.yml` merges its own release PR, so every merge into `main`
  with a `feat`, `fix`, `perf`, `refactor` or `docs` commit publishes a new npm
  version (these have visible changelog sections in
  `release-please-config.json`); `chore`, `ci`, `build`, `test` and `style` do
  not. A `!` in the commit type or a `BREAKING CHANGE:` footer publishes a new
  major version; use it only for a deliberate breaking change.
- Dependencies: keep lockfile diffs confined to the packages you meant to
  change.

## Verification before review

```bash
npm ci
npm run lint
npm run typecheck
npm run build        # the smoke tests execute dist/cli.js, so build before testing
npm test             # MULTIX_DISABLE_HOME_ENV=1 is set by vitest.config.ts
npm run verify:docs  # when docs-site/ changed (needs `npm ci --prefix docs-site`)
npm run check:mcp    # when worker/ or a client it imports changed
```

- Running the test suite needs Node 20.19+ or 22.12+ (required by vite, which
  vitest uses). The published CLI itself still supports Node ≥ 20.
- In a fresh worktree, run `npm ci --prefix worker` before `check:mcp`.
- Tests must not call paid APIs by default. Mock `globalThis.fetch`
  (`tests/helpers/mock-fetch.ts`) or inject a fetch function.
- Optional live smoke tests must be gated behind an explicit env opt-in and the
  provider credential, and must never print key values.
- Attach evidence (test output, CLI output with secrets redacted) to the PR.

## Code conventions

- TypeScript ESM, Node ≥ 20, Biome for lint/format, kebab-case file names.
- Providers live in `src/providers/<name>/`; register the command group in
  `src/commands/index.ts`, and add the key to `src/commands/check.ts`,
  `src/commands/check-helpers/setup-hints.ts`, `.env.example`, `README.md`,
  the docs site (`docs-site/src/content/docs/**`, English and Vietnamese), and
  `skill/SKILL.md`.
- A new task-serving command must be added to
  `src/capabilities/command-capabilities.ts` (or `UTILITY_COMMANDS` there if it
  serves no task). Only models checked against the provider's own schema go in
  `src/capabilities/model-registry.ts`, with their `source` URL and `verified_at`.
  Regenerate the worker catalog with `npm run catalog` in `worker/`.
- Keep provider HTTP clients free of `node:*` imports (take `fetch`, `apiKey`
  and `baseUrl` as inputs) so they can be reused by non-Node runtimes such as a
  Cloudflare Worker. File-system, env loading and downloads stay in the command
  layer.
- Never log API keys, signed URLs, or full prompts at info level. Use
  `redact()` from `src/core/redact.ts` for keys.
- `worker/` is a separate package (remote MCP server for Cloudflare Workers)
  that imports runtime-neutral provider clients from `src/providers/**`. It is
  not published with the CLI. When you change a client it uses, run
  `npm run check:mcp` (worker typecheck, tests, and a bundle check that fails
  on any `node:*` or bare Node built-in import, `commander`, `execa`, or CLI code).
- The job container (`worker/container/`) is rolled out before the Worker
  (`worker/scripts/roll-out-job-container.mjs`, run by `deploy-mcp.yml`), so a
  new container must work with the Worker that is still live, in both
  directions: accept the job spec it sends, and keep its responses
  (`/jobs/current` and job results) and R2 output layout readable by it. Widen
  what the container accepts first; the Worker may then send the new form in
  the same or a later change. Rolling back the Worker does not roll back the
  container, so the same rule covers a rollback. When `instance_type` or
  `max_instances` in `worker/wrangler.jsonc` differ from the live container
  application, the workflow applies them after the Worker deploy. Other fields
  of the `containers` block are not compared: after changing one, run the
  workflow manually with `apply_container_settings`. The workflow deploys only
  from `main`.
- The Cloudflare deploy secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
  live in the `production` GitHub Environment, which only `main` may use. A
  workflow job that deploys to Cloudflare must set `environment: production`;
  do not add the secrets back at repository level.

## Documentation

- User-facing docs: `README.md` and `docs-site/` (English at `docs/`, Vietnamese at `docs/vi/`).
- Agent-facing usage: `skill/SKILL.md`.
- Implementation plans and reports: `plans/`. Isolated code-review reports go
  in `plans/reports/` (`code-reviewer-<yymmdd>-<hhmm>-<slug>.md`).
