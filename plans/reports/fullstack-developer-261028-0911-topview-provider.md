# TopView provider (issue #413, part B): implementation report

Status: DONE_WITH_CONCERNS. Nothing committed or pushed.

## Delivered

- `src/providers/topview/`: runtime-neutral clients (`types.ts`, `models.ts`,
  `errors.ts`, `legacy-client.ts`, `platform-client.ts`), Node wiring
  (`node-client.ts`, `node-inputs.ts`, `node-outputs.ts`,
  `node-catalog-cache.ts`) and `commands/` (`index.ts`, `task-flow.ts`,
  `m2v.ts`, `video-avatar.ts`, `product-avatar.ts`, `product-anyshoot.ts`,
  `status.ts`, `upload.ts`, `credit.ts`, `models.ts`, `run.ts`,
  `prediction.ts`).
- `tests/unit/providers/topview/`: `fake-topview.ts` (both hosts),
  `legacy-client.test.ts`, `platform-client.test.ts`, `commands.test.ts`,
  `runtime-neutral.test.ts`, `usage-extract.test.ts`.
- Docs: `docs-site/src/content/docs/commands/topview.md` and
  `docs-site/src/content/docs/vi/commands/topview.md`.

## Verification

- `npx biome check src/providers/topview tests/unit/providers/topview`: clean.
- `npm run typecheck`: clean.
- `npx vitest run tests/unit/providers/topview`: 109 passed, 1 expected fail
  (the documented usage-extract gap below).
- `npm run verify:docs`: astro check and build clean; one docs test fails
  only because the page is not yet in the sidebar / llms.txt (controller-owned).

## usage-extract findings (not changed)

1. `remainCredit` is counted as credits spent. `BALANCE_LEAF` in
   `src/core/usage-extract.ts` matches `remaining` but not `remain`.
   Failing case: `extractUsage({code:"200",result:{remainCredit:120}}).credits === 120`.
   Fix: add `remain` to `BALANCE_LEAF` (e.g. `remain(ing)?`). The test is
   `it.fails` in `tests/unit/providers/topview/usage-extract.test.ts`; flip it
   to `it` after the fix.
2. `GET /user/credit/detail` lists recent tasks with `costCredit`, which the
   extractor would count as spend for `topview credit`. Recommend listing
   `topview credit` in `UNRECORDED` (or the equivalent) in
   `src/agent/agent-runtime.ts`.
3. `charged_usd` is a decimal string, so it is never counted, even when
   `CAPTURED`. RESERVED-not-spend holds (asserted). Counting CAPTURED would
   need a billing_state-aware rule.
4. A legacy `costCredit` sent as a numeric string ("5.00") is not counted;
   numeric values are.

## Controller follow-ups

- Register `registerTopviewCommands` in `src/commands/index.ts`; env names in
  check.ts, provider-keys.ts, setup-hints.ts, project-env-names.ts,
  provider-group-keys.ts, `.env.example`, README.md, skill/SKILL.md;
  capabilities in `command-capabilities.ts`.
- Docs site: sidebar entry `{ label: "TopView", slug: "commands/topview" }`
  in `docs-site/astro.config.mjs`, `src/pages/llms.txt.ts`, and the provider
  list in `docs-site/tests/site-output.test.mjs` if TopView should be there.
- The Platform docs name the key `TOPVIEW_API_PLATFORM_KEY`; multix uses
  `TOPVIEW_PLATFORM_API_KEY` as decided. Consider adding the docs name as a
  second entry of `TOPVIEW_PLATFORM_ROUTING.keyEnvs`.
- The catalog pagination parameter is undocumented: only the first page is
  read and `truncated` is reported.
