# Multix Worker: MCP Skills Extension and versioned skills registry (issue #415, phase 1 of 3)

Status: implemented, in review

## Outcome

- Modern (2026-07-28) clients see `capabilities.extensions["io.modelcontextprotocol/skills"]
  = { directoryRead: true }` and `resources` in `server/discover`, and can call
  `skills/list`, `skills/get`, `resources/read` and `resources/directory/read`.
- 2025-era clients keep the same tools plus `resources/list` / `resources/read`
  (every SKILL.md as a resource) and the read-only `multix_skills` tool
  (`search`, `get`, `read` with a stale-revision check). The four existing
  tools are unchanged.
- The repository's `skill/` is split into the `multix` entry skill and six
  nested task skills (image-generation, video-production, speech-production,
  media-qa, document-conversion, 3d-generation); each task skill points to
  `multix models --task <task> --ready` for live model choice.
- A per-account, versioned, content-addressed registry (`AccountSkills`)
  holds private and team skills with explicit read grants. Phase 1 serves
  it read-only; publishing tools come in a later phase.

## Constraints and non-goals

- Read-only: no method or tool writes, fetches a URL or executes a skill
  file; reading a skill never activates it.
- No Node built-ins in the Worker bundle (`check:bundle`).
- No publish/share API, R2 storage or `skills/list_changed` in this phase.
- One account never sees another's skills: a forbidden URI gets the same
  answer as a missing one.

## Design

| Concern | Choice |
|---|---|
| URIs | `skill://multix/SKILL.md` (entry), `skill://multix/<task>/SKILL.md` (nested), `skill://private/<name>/…` (caller's own), `skill://team/<ownerId>/<name>/…` (granted team skill) |
| URI safety | Plain segments only (`[A-Za-z0-9_][A-Za-z0-9._-]*`, no `..`, no trailing dot); no query, fragment, `%`, `\` or whitespace; ≤ 512 chars |
| Built-ins | Generated at build time from `skill/` into `worker/src/skills/builtin-skills.json` (`npm run skills`, run before dev/build/typecheck/test/deploy; gitignored because release-please rewrites the `version:` lines) |
| Build checks | Symlinks and non-regular files refused; UTF-8 text only; frontmatter parsed strictly; `name` equals the directory; `metadata.tasks` must be known task ids |
| Frontmatter | Strict YAML subset (scalars, one-level maps and lists) rendered verbatim as JSON; anything else refused rather than guessed |
| Registry records | `Skill`, `SkillRevision` (immutable once published, `manifestDigest`), `SkillFile` (path, media type, size, `sha256:` digest), `SkillAccess` (read grant) |
| Limits | 512 files and 16 MiB per skill (extension limits), 1 MiB per file, 200 skills per account, 16 tags |
| Integrity | Blobs stored under their SHA-256; every read re-hashes and fails as corrupt (JSON-RPC internal error) on mismatch |
| Write order | Blobs first, then revision + skill record in one put: an interrupted publish leaves only unreferenced blobs |
| Cache hints | Built-ins only: `ttlMs` 300 000, `public`; with account skills: 60 000, `private` |
| Pagination | 50 per page (max 100), opaque base64 offset cursor; forged cursor → -32602 `Invalid cursor` |
| Errors | -32602 with deterministic messages (`No skill is served at <uri>`, `No resource is served at <uri>`, `<uri> is not a directory resource`, `Invalid skill URI: …`) and `data.code`; tool errors lead with the same code (`STALE_REVISION: …`, `BINARY_FILE: …`) |
| Registry metadata | `_meta["me.zuey.multix/skill"]`: id, version, revision, manifestDigest, status, visibility, tags, capabilities |

### Storage: Durable Object SQLite, not D1

Each account's registry is its own `AccountSkills` Durable Object (SQLite
storage, binding `MULTIX_SKILLS`, addressed by account id), like
`AccountEvents`. Reasons:

- Isolation by construction: a lookup can only ever reach the registry it
  was addressed to, so cross-account leaks need a wrong address, not a
  missing `WHERE`.
- Transactional single-writer semantics for revision numbering without a
  global lock.
- No new binding type or migration tooling; the deploy workflow already
  rolls out SQLite Durable Objects declaratively (`exports` in
  `wrangler.jsonc`).

D1 would make cross-account queries (a public marketplace, global search)
easier; that is not in scope, and a later phase can add an index next to
the per-account objects. Blobs live in Durable Object storage (≤ 1 MiB per
value); moving large assets to R2 is deferred.

### Local CLI skill vs remote catalogue

- The npm package ships `skill/` matching the installed CLI version; the
  Worker serves the `skill/` of its own deployed version (frontmatter
  `version` and `_meta…version`).
- An agent driving the local CLI uses the local skill; an agent using the
  remote MCP server uses the remote catalogue. When the versions differ,
  each describes the CLI it sits next to, so neither is "stale" for its own
  runtime.

## Files

- `worker/src/skills/*` (new): frontmatter parser, file rules, types,
  registry and its Durable Object, catalog, MCP methods, `multix_skills`.
- `worker/scripts/skill-catalog-builder.ts`, `build-skill-catalog.ts` (new).
- `worker/src/mcp-server.ts`, `mcp-api-handler.ts`, `index.ts`, `config.ts`,
  `wrangler.jsonc`, `package.json`; `.gitignore`, `biome.json`.
- `skill/SKILL.md` and `skill/<task>/SKILL.md`; `release-please-config.json`.
- Tests: `worker/test/skill-files.test.ts`, `skill-registry.test.ts`,
  `mcp-skills.test.ts` (+ updated tool-list assertions).
- Docs: README, docs-site MCP guide (EN/VI), worker README.

## Validation

- `npm run check:mcp`: worker typecheck, all worker tests, bundle check.
- `npm run lint`, `typecheck`, `build`, `test`; `npm run verify:docs`.

## Next phases

- Phase 2 (separate issue): skills CRUD, drafts and publishing with
  ownership and revision control, writing to this registry. Carry over from
  the phase 1 review (`plans/reports/code-reviewer-261028-0940-mcp-skills-extension.md`):
  team URIs address the owner by raw account id; `grant` and `addShare` are
  two writes on two objects, so a failed `addShare` leaves a grant nobody
  can reach; revoking and re-granting must not revive a stale grant. Built-in
  skills stay at revision 1 across deploys, so clients detect their changes
  by digest.
- Phase 3 (separate issue): manifest-defined skill script/workflow execution
  in a restrictive sandbox, only after explicit authorization.
