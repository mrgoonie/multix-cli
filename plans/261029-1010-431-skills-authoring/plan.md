# Skills authoring: drafts, publishing, revisions, sharing (#431)

Status: in progress. Phase 2 of #415; phase 3 is #432.

## Outcome

An account manages its own skills in its `AccountSkills` registry over MCP
(`multix_skills_manage`) and REST (`/api/v1/skills…`): drafts, publishing,
revision control, metadata, deletion and team sharing. Readers keep using the
phase 1 surfaces (`skills/list|get`, `resources/read`, `multix_skills`).

## Constraints

- Owner-only writes: every write goes to `MULTIX_SKILLS.getByName(caller)`; the
  Durable Object refuses an owner id that is not its own.
- Same validation as phase 1 publishing (paths, media types, UTF-8 without BOM,
  frontmatter, 512 files / 16 MiB per skill, 1 MiB per file).
- Optimistic concurrency: `expected_revision` (served revision) and
  `expected_draft_digest`; a mismatch is a conflict (MCP `CONFLICT`, REST 409).
- No execution (phase 3). Built-ins stay read-only.

## Design

Storage keys added to the registry:

- `draft:<name>`: `{name, baseRevision, files, digest, createdAt, updatedAt}`.
  Blobs are content-addressed like revisions.
- `access:<name>:<accountId>` gains `grantId`.
- `share:<ownerId>:<name>` gains `grantId`. The catalog lists a share only
  while the owner's access record carries that `grantId`.

Operations: `saveDraft`, `getDraft`, `discardDraft`, `publishDraft`,
`revisions`, `revision`, `deleteRevision`, `setCurrent`, `unpublish`,
`updateMetadata`, `deleteSkill`, `grant`, `revoke`, `accessList`,
`ownSkills`. The grantee side has `acceptShare` (it checks the grant on the
owner's object) and `removeShare`.

Limits:

- at most 100 revisions per skill;
- a draft patch carries at most 8 MiB of decoded bytes (REST body cap 12 MiB
  on skill routes; MCP transport limits apply to the tool).

Blob GC: deleting a skill, a revision or a draft removes the blobs that no
remaining revision or draft references.

Sharing is opt-in for the grantee. A grant writes nothing into the grantee's
registry, so nobody can push skills into another account's `skills/list`.

## Files

- `worker/src/skills/skill-registry.ts`, `skill-types.ts`, `account-skills.ts`
- `worker/src/skills/skill-catalog.ts`: team owner segment check, grant-id-aware shares
- new `worker/src/skills/skill-manager.ts`: the input decoding and views shared by MCP and REST
- new `worker/src/skills/skills-manage-tool.ts`
- `worker/src/mcp-server.ts`
- `worker/src/api/api-router.ts`, new `worker/src/api/skill-api-handlers.ts`, `api-http.ts`, `openapi-document.ts`
- Tests: `worker/test/skill-authoring.test.ts`, `skills-manage-tool.test.ts`, `skill-api.test.ts`
- Docs:
  - `docs-site/.../guides/mcp-server.md` (EN and VI);
  - the REST docs page, if any;
  - `skill/SKILL.md`;
  - `README.md`.

## Validation

`npm run check:mcp`; root `lint`, `typecheck`, `build`, `test`; `verify:docs`.

## Rollback

Revert the PR. Stored drafts and new fields are ignored by phase 1 readers,
because `grantId` is optional on read.
