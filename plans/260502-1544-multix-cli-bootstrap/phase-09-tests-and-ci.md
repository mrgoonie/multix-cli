# Phase 09 — Tests and CI

## Context
- Plan: [plan.md](plan.md)
- Depends on: phases 01-08 (consumes all source modules).

## Overview
- Priority: P1
- Status: pending
- Goal: vitest unit/smoke tests + GitHub Actions CI matrix on Node 20/22.

## Key Insights
- Use `vi.mock` to stub `undici fetch` and `execa` so tests are offline.
- Smoke test: spawn built `dist/cli.js --help` and assert exit 0 + expected commands listed.
- Avoid integration tests against real APIs (cost, secrets).

## Requirements
Test matrix:
- `tests/unit/core/env-loader.test.ts` — process.env wins, .env layering.
- `tests/unit/core/result.test.ts` — ok/err helpers.
- `tests/unit/core/http-client.test.ts` — timeout, error wrapping (mock fetch).
- `tests/unit/providers/gemini/task-resolver.test.ts` — extension → task.
- `tests/unit/providers/minimax/models.test.ts` — defaults map.
- `tests/unit/providers/openrouter/build-payload.test.ts` — modalities, fallbacks.
- `tests/unit/commands/media/detect-type.test.ts`
- `tests/unit/commands/check.test.ts` — exit codes by env permutation.
- `tests/smoke/cli.test.ts` — run `node dist/cli.js --help`, assert top-level commands.
- `tests/smoke/parse-args.test.ts` — each subcommand with `--help` exits 0.

CI:
- Workflow `.github/workflows/ci.yml`: matrix `node-version: [20.x, 22.x]`, `os: [ubuntu-latest, windows-latest]`. Steps: checkout, setup-node, `npm ci`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`.
- Cache npm.

## Architecture
```
tests/
  unit/
    core/*.test.ts
    providers/<provider>/*.test.ts
    commands/<group>/*.test.ts
  smoke/*.test.ts
  helpers/
    mock-fetch.ts
    fixtures/
```

## Related Code Files
Create: `tests/**`, `vitest.config.ts`, `.github/workflows/ci.yml`.
Modify: `package.json` — `test` script already added in phase-01; add `test:smoke` if needed.

## Implementation Steps
1. `vitest.config.ts`: `globals: true`, `coverage.provider: 'v8'`.
2. `tests/helpers/mock-fetch.ts`: factory `mockFetch(responseMap)` patching `globalThis.fetch`.
3. Write unit tests per module above.
4. Smoke tests: execute compiled `dist/cli.js` via `execa`.
5. Add CI workflow yaml.
6. Add coverage threshold in vitest config (start lenient: 70%).

## Todo List
- [ ] vitest.config.ts
- [ ] tests/helpers/mock-fetch.ts
- [ ] core unit tests
- [ ] provider unit tests
- [ ] command unit tests
- [ ] smoke tests
- [ ] CI workflow

## Success Criteria
- `npm test` green locally.
- CI green on Node 20 + 22 across Ubuntu + Windows.
- Coverage ≥70% lines on `src/core/**` and `src/providers/**`.

## Risk Assessment
| Risk | L | I | Mitigation |
|------|---|---|-----------|
| Smoke test on Windows misses shebang issues | M | M | Always invoke via `node dist/cli.js`, not direct exec |
| Flaky network in tests | L | H | All HTTP mocked; reject if any test makes real fetch |
| Coverage gates block dev | M | L | Start at 70%, raise after stabilization |

## Security Considerations
- Tests must never read real `~/.multix/.env` — set `MULTIX_DISABLE_HOME_ENV=1` in vitest setup.
- No fixtures contain real keys.

## Next Steps
Gates phase-10. After CI green, proceed to publish/docs.
