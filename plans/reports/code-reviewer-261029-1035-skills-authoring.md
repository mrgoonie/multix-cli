# Code review: skills authoring (#431)

Reviewer: isolated code-reviewer (did not write the code). Date: 2026-10-29.

## Scope

- Code under review: commit `f3dc1cb feat(mcp): author skills with drafts, revisions and team sharing`
  (it was uncommitted when the review started; the author committed it while the review ran, and
  the committed worker files match what was reviewed). Docs commit `cf152e8` not reviewed in depth.
- Files: `worker/src/skills/{skill-registry,skill-types,account-skills,skill-catalog,skill-manager,skills-manage-tool}.ts`,
  `worker/src/api/{skill-api-handlers,api-router,api-http,openapi-document}.ts`,
  `worker/src/{mcp-server,mcp-api-handler,index,app-context}.ts`, tests `skill-authoring`, `skill-registry`,
  `skills-helpers`, `rest-api`. About 2,900 changed lines.
- Checks run: `npx vitest run` on the four skills/REST test files: 63/63 pass. The full worker suite run
  through `npx vitest run` had one failure, `skill-files.test.ts`, because the generated catalog was stale
  after the `skill/SKILL.md` edit. `npm test` regenerates it in `pretest`, so this is not a code defect.
  `tsc --noEmit`: clean. `biome check`: clean.
- I ran a Miniflare/workerd experiment (compat date 2026-09-01, same as `wrangler.jsonc`). A Durable Object
  method threw `class RegErr extends Error { name = "SkillRegistryError"; reason }`, and the caller received
  `{"inst":false,"name":"SkillRegistryError","reason":"conflict","message":"nope"}`. `instanceof` fails across
  DO RPC, while `name` and own properties survive.

## Critical

### C1. Every registry refusal becomes an internal error in production (instanceof across DO RPC)

- `worker/src/api/api-http.ts:96`, `worker/src/skills/skills-manage-tool.ts:54` (and the existing check at
  `worker/src/skills/skill-catalog.ts:354`).
- `SkillRegistryError` is thrown inside the `AccountSkills` Durable Object and crosses an RPC boundary
  (`MULTIX_SKILLS.getByName(id).saveDraft(...)`). Workers RPC rebuilds the error as a new object, so
  `error instanceof SkillRegistryError` is false in the Worker. I confirmed this with workerd (above).
- What fails: `PUT /api/v1/skills/foo/draft` with a stale `expected_digest` returns 500 `internal` instead of 409 `conflict`.
  The same happens to every `invalid` (400) and `not_found` (404), such as a bad SKILL.md, a missing draft, a revision
  limit, or an unknown skill. On MCP, `refusal()` rethrows the error, `runTool` sees no `MultixError`, and the tool
  returns "Internal error while running the tool", logged at `error` level. So the whole optimistic-concurrency
  contract (`CONFLICT` / 409) and every validation message are lost in production, and error logs fill with ordinary
  user mistakes. Corrupt-content detection in the catalog also falls through to a generic error.
- Why the tests miss it: `test/skills-helpers.ts:17-31` builds `AccountSkills` in process and calls it directly,
  so the class identity survives.
- Fix: replace the `instanceof` checks with a structural guard that the RPC copy also passes. For example, in
  `skill-registry.ts`:
  ```ts
  export function registryErrorOf(e: unknown): { reason: RegistryErrorReason; message: string } | null {
    if (!(e instanceof Error) || e.name !== "SkillRegistryError") return null;
    const reason = (e as { reason?: unknown }).reason;
    return reason === "invalid" || reason === "not_found" || reason === "conflict" || reason === "corrupt"
      ? { reason, message: e.message } : null;
  }
  ```
  Use it in `errorResponse`, `refusal` and `SkillCatalog.read`. The structural guard depends on enhanced error
  serialization, which compat date ≥ 2026-04-21 enables and which Cloudflare says is not guaranteed. A sturdier option
  is to have the DO return `{ ok: false, reason, message }` values instead of throwing. Add a test in which the fake
  namespace sends errors through `structuredClone`-like rewrapping (e.g. `throw Object.assign(new Error(e.message), { name: e.name, reason: e.reason })`)
  so a regression fails CI.

## High

### H1. `deleteSkill` is not crash-safe or retryable, and stale grants can attach to a new skill of the same name

- `worker/src/skills/skill-registry.ts:688-702` (and `canRead` at `:798-808`, `access` at `:757-761`, `grant` at `:720-722`).
- The order is: delete the `skill:` record, then `revokeAll`, then delete each revision and release its blobs, then
  discard the draft. That is up to 100 revisions × 512 digests, about 51k `list` calls inside one
  `blockConcurrencyWhile`. If the object is reset partway (bCW timeout, CPU limit, deploy, eviction):
  1. Retrying `delete` hits `skillOrThrow` and returns `not_found`. The remaining revisions, refs, blobs, the draft
     and possibly `access:` rows are now unreachable leaks.
  2. If the reset happens between deleting the record and `revokeAll`, the `access:<name>:<gh-x>` rows survive.
     When the owner later creates a new team skill with the same name, `canRead`/`access` accept those old rows
     because they never compare `access.skillId` with `skill.id`. A grantee's old share with the same `grantId` then
     lists the new, unrelated skill, which the owner never shared with them. `grant()` also returns the stale row as
     if it were current.
  3. A new skill with the same name inherits the leftover `rev:` records: `revisions()` lists them, `set_current`
     can serve them, and they count toward the 100-revision limit.
- Fix:
  - Delete in the reverse order: grants, then the draft, then revisions (with release), and the `skill:` record last.
    `deleteSkill` must then resume when the record is gone but `rev:`/`draft:`/`access:` keys remain.
  - In `canRead`, `access()` and `grant()`, require `access.skillId === skill.id`. A row from an earlier skill
    incarnation should be treated as absent (and deleted in `grant`).
  - Make `release` cheaper for whole-skill deletes. Collect all digests first, delete all refs, then check each
    distinct digest once.

### H2. MCP authoring is capped at a 64 KiB request, and the tool never says so

- `worker/src/mcp-api-handler.ts:94,107,167` (`MAX_BODY_BYTES = 64 KiB`) and the tool description at
  `worker/src/skills/skills-manage-tool.ts:85`.
- A `save_draft` call goes through the MCP transport, which refuses bodies over 64 KiB. One file cannot be split
  across updates, so a binary asset over about 47 KiB (base64 + JSON-RPC overhead) can never be uploaded over MCP,
  even though the registry accepts 1 MiB files. The description advertises base64 images and PDFs, and the plan's
  "MCP transport limits apply" is not visible to the agent, which gets a transport 413 with no guidance.
- Fix: raise the MCP body cap for `tools/call` (for example to `MAX_SKILL_BODY_BYTES`, with the method checked
  before buffering), or state the per-call limit in the tool description and in `skill/SKILL.md` and point to
  `PUT /api/v1/skills/{name}/draft` for large files.

## Medium

### M1. MCP cannot express "no draft expected" (`expected_digest: null`)
- `worker/src/skills/skills-manage-tool.ts:123-127`. The zod schema only accepts a digest string. Two MCP sessions
  creating the same new draft both use `undefined`, and the second one silently patches the first one's draft (or
  `replace: true` wipes it). REST supports `null` (`skill-api-handlers.ts:128-133`). Fix: allow
  `z.union([digest, z.null()])` for `save_draft` and pass `null` through, matching the REST behaviour and the stated invariant.

### M2. REST and MCP validate `capabilities` differently
- REST `worker/src/api/skill-api-handlers.ts:80` accepts any `string[]`, which `cleanTags` only checks against
  `[a-z0-9-]`. MCP `skills-manage-tool.ts:138-141` limits values to `TASKS ∪ {"any"}`. The REST header comment says the
  "validation … [is] identical on both surfaces". With REST, a skill can advertise made-up capabilities that then
  appear in other accounts' `skills/list` `_meta` (team shares) and affect task-based skill selection. Fix: validate
  capabilities against `TASKS` in the registry or manager (one place) and drop the MCP-only enum.

### M3. `publish` ignores the draft's `baseRevision`
- `worker/src/skills/skill-registry.ts:533-563`. Suppose a draft starts from revision 3, and another session
  publishes revision 4 or rolls back with `set_current`. Publishing the draft without `expected_revision` makes
  revision 5 from rev 3 + edits and serves it, silently undoing the other session's change. Nothing is deleted, but
  the served content regresses. Fix: when `expected_revision` is omitted, default it to `draft.baseRevision`, or at
  least return `base_revision` against `current_revision` in the publish result so clients can detect it.

### M4. N+1 cross-object RPC on every list
- `worker/src/skills/skill-catalog.ts:291-301` and `worker/src/skills/skill-manager.ts:199-211`: one sequential DO
  RPC per share, with up to `MAX_SHARES_PER_ACCOUNT = 200`. This runs on every `skills/list`, `GET /skills` and
  `GET /skill-shares` (the latter also loads every own skill only to discard it). Fix: use `Promise.all` with a small
  concurrency bound, and give `/skill-shares` GET its own `shares()` path.

### M5. Test gaps on the stated invariants
- None of these are tested:
  - RPC error rewrapping (C1);
  - the draft, grant and share limits (`MAX_SKILLS_PER_ACCOUNT` for drafts, `MAX_GRANTS_PER_SKILL`, `MAX_SHARES_PER_ACCOUNT`);
  - `expected_digest: null` when a draft exists (REST);
  - the `replace` and `from_revision` combinations in `saveDraft`, including `from_revision` with an existing draft
    and no `replace`;
  - `deleteRevision` of a revision whose blobs the draft also holds;
  - `deleteSkill` resuming after a partial delete.
- The plan names `skills-manage-tool.test.ts` and `skill-api.test.ts`, which do not exist; that coverage was folded
  into `skill-authoring.test.ts` and `rest-api.test.ts`. The plan should say so.

## Low

- L1. `worker/src/skills/skill-registry.ts:256-265`. Revisions stored by the phase 1 `publish` have no `ref:` rows.
  If such data exists, `discardDraft` or `deleteRevision` would delete blobs that those revisions still use.
  Phase 1 had no write path (no caller of `publish` in `src/`), so production data is very likely empty. State
  that assumption in the plan's rollback/compat note, or treat a revision without refs as holding all its digests.
- L2. Legacy `share:` / `access:` rows without `grantId`: `canRead` with `grantId === undefined` accepts any grant
  (`skill-registry.ts:807`), so a legacy share would come back after revoke + re-grant. Same "no phase 1 data"
  assumption as L1.
- L3. `deleteSkill` followed by re-creating the same name restarts revision numbers at 1, because `lastRevision` is
  lost with the record. Clients that cache by `(uri, revision)` may serve stale bytes. Consider using the skill `id`
  in cache keys, or keep a tombstone `lastRevision`.
- L4. `worker/src/api/skill-api-handlers.ts:16`. The body cap assumes base64 overhead. Text files sent as `text` with
  many escaped characters (`\n`, `"`, control characters as `\u00XX`) can exceed about 11.7 MiB of JSON while staying
  under the 8 MiB decoded limit, so the client gets a 413 that disagrees with the documented limit. Document "8 MiB
  decoded, about 11.7 MiB JSON body", or size the cap for worst-case escaping.
- L5. `optionalBody` (`skill-api-handlers.ts:36-40`) answers 415 for a body-bearing POST without `content-type`
  (for example chunked `curl -X POST` with no data). This is minor and consistent with the other routes.

## Verified OK

- Owner isolation: every authoring call goes to `getByName(ctx.userId)`, and the DO's `owner()` refuses a mismatched id.
- `addShared` reads the grant on the owner's object with `principal = caller`.
- A grantee cannot forge a `grantId`.
- Team URIs are checked against `ACCOUNT_ID_RE` in both the catalog and `teamSkill`.
- Paths are checked by `isSafeRelativePath`. Lookups are exact matches against the stored file list, so they
  cannot traverse.
- Validation happens before writes in `saveDraft`, `commit` and `grant`.
- Write order: blobs, then refs, then record. Removal order: record, then refs, then orphan blobs (except H1's
  ordering in `deleteSkill`).
- Shared blobs survive across revisions and the draft.
- `lastRevision` stops number reuse while the skill exists.
- The served revision cannot be deleted.
- Writes are serialized by `blockConcurrencyWhile`.
- Storage put/delete calls are batched at 128 keys.
- No secrets or file contents are logged; `runTool` logs `action` and the skill name only.

## Plan follow-ups

- Code tasks in the plan appear implemented. The docs were done in `cf152e8` (not reviewed in depth).
- Blocking before merge: C1. Strongly recommended: H1 and H2. Then M1-M3.

Status: DONE_WITH_CONCERNS
Summary: The authoring design and owner isolation are sound, but every registry refusal crosses DO RPC as a plain error, so the REST and MCP error contracts (409/CONFLICT, 400, 404) collapse to internal errors in production (confirmed in workerd). deleteSkill is also not crash-safe and can attach stale grants to a new skill of the same name.
Concerns/Blockers: C1 instanceof SkillRegistryError fails across DO RPC (api-http.ts:96, skills-manage-tool.ts:54); H1 deleteSkill ordering and access rows without a skillId check; H2 64 KiB MCP body cap makes binary uploads over MCP impossible.

## Resolution (author)

- C1 fixed: `registryRefusal()` reads `name` and `reason`, which survive a Durable Object call, instead of `instanceof`. It is used by the REST error mapper, `multix_skills_manage` and the catalog's corrupt check. `fakeRegistries()` now rethrows errors the way a stub does, without the class. With the old mapper that fake turns the REST conflict test into a 500.
- H1 fixed: `deleteSkill` first stops serving the skill, then revokes grants and removes revisions and the draft, and deletes the record last, so a retry resumes. Grants count only when their `skillId` matches the skill (`canRead`, `access`, `grants`; `grant` replaces a stale record). Both behaviours have tests.
- H2: the MCP request cap stays. The tool description and the docs point large or binary uploads to several `save_draft` calls or to REST `PUT /skills/{skill}/draft`.
- M1 fixed: `expected_digest` accepts null over MCP.
- M2 fixed: `SkillManager` refuses capabilities that are not task ids or `any` on both surfaces.
- M3 fixed: a draft records the revision served when it started (`servedRevision`). Publishing without `expected_revision` fails with a conflict if another revision is served by then.
- M4 fixed: the shared skills of a list are read in parallel.
- M5: tests were added for C1, H1, M1, M2 and M3.
- Low: no phase 1 write path existed, so there are no stored revisions without ref records or grants without a grant id (the assumption the reviewer named). Revision numbers restarting for a re-created skill is intended, because it is a new skill with a new id. The 415 for a body with no content-type matches the other REST routes.
