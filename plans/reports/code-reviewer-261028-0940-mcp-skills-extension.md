# Code review: MCP Skills Extension and skills registry (issue #415, phase 1)

Reviewer: isolated code-reviewer (did not write the code). Date: 2026-10-28.

## Scope

- At review start the changes were uncommitted. During the review they were committed as
  `a991b9b feat(skills): …` and `c7c3ea6 docs(mcp): …` on `claude/gracious-heisenberg-qesabr`.
  The review covers `cc84589..HEAD`: 40 files, +3451/-527.
- Focus: `worker/src/skills/*`, `worker/scripts/skill-catalog-builder.ts`, `build-skill-catalog.ts`,
  the server wiring, wrangler/package/gitignore/biome, the skills tests, the `skill/` split,
  release-please config, and the CI/deploy workflows.
- Spec: https://skills.extensions.modelcontextprotocol.io/specification/stable/skills (fetched).

## Verification run

- `npm run skills`: 7 skills, 7 files, 75 983 bytes.
- `npx tsc --noEmit` (src and test configs): clean.
- `npx vitest run` on the skills, mcp-tools, mcp-events and job-tools test files: 6 files, 138 tests, all passed.
- `npm run check:bundle`: clean, with no `node:*` imports in the bundle.
- Probes (scratchpad scripts, no source edits):
  - `__proto__` frontmatter key (finding M2): confirmed.
  - BOM SKILL.md (finding L1): confirmed.
  - YAML scalar typing (finding L3): confirmed.

## Overall assessment

Phase 1 is solid where it matters most.

- **Cross-account isolation:** each account has its own Durable Object. A `private/` URI always resolves to the caller's own registry. A `team/` URI requires a grant in the owner's object, and the visibility must match the URI namespace.
- **No information leaks:** a forbidden skill gets exactly the same answer as a missing one.
- **URI parsing:** the parser is strict, and traversal attempts are refused.
- **Integrity:** every read re-hashes the content.
- **Spec conformance:** checked, and conforms. Details are in the next section.

No Critical issues were found. The blocking problems are release and versioning plumbing. Most remaining risks are latent: they only matter once phase 2 exposes `publish` and `grant`.

## Spec conformance (verified)

| Requirement | Status |
|---|---|
| `extensions["io.modelcontextprotocol/skills"] = {directoryRead:true}` plus a `resources` capability in `server/discover` | OK (test) |
| `skills/list` and `skills/get` return `resultType:"complete"`, `ttlMs` and `cacheScope` | OK (test) |
| Entries have the same shape in list and get; `resources` is complete; the enclosing root skill includes the nested files | OK (test) |
| Digest is `sha256:<64 hex>`; `size` is the byte length | OK |
| The final URI segment equals `frontmatter.name`; the root URI has no trailing slash | OK |
| `resources/directory/read`: non-recursive, `inode/directory` for subdirectories, -32602 on a non-directory or unknown URI | OK |
| -32602 for an unknown skill or file; -32603 for corruption | OK |
| Limits: 512 files and 16 MiB per skill | OK (enforced on publish and build) |
| Frontmatter must match a host's YAML parse field by field | Partial, see L3 |

## Critical

None.

## High

### H1. The beta release path never bumps the nested skills' `version:` lines

- **Files:**
  - `release-please-beta-config.json:16-21` (unchanged; only `skill/SKILL.md` is listed)
  - `AGENTS.md` (the new skill rule names only `release-please-config.json`)
- **Scenario:**
  1. The current line is `1.22.0-beta.2`, and `release-please-beta.yml` runs on every push to `dev`.
  2. The next beta release rewrites only `skill/SKILL.md`.
  3. The six task skills keep `version: 1.22.0-beta.2` in the npm package and in the Worker catalogue (`_meta…version`).
  4. This contradicts the plan's claim that each skill describes "the CLI it sits next to".
- **Fix:**
  - Add the six `skill/<task>/SKILL.md` files to `extra-files` in `release-please-beta-config.json`.
  - Mention both configs in AGENTS.md.
  - Add a test that both configs list every `skill/**/SKILL.md`, and that every built-in `version` equals `package.json` `version`. This also catches a future task skill that someone forgets to register.

## Medium

### M1. Deploy workflow does not trigger on `skill/**`

- **File:** `.github/workflows/deploy-mcp.yml:11-18` (path filter)
- **Scenario:**
  1. A commit that only edits `skill/**` merges to `main`.
  2. It does not redeploy the Worker, so the remote catalogue keeps serving old text and digests.
  3. A `docs`/`feat`/`fix` commit is eventually followed by a release-please commit that touches `package.json`, which does trigger a deploy. So the catalogue is stale until then.
  4. A `chore`/`style` change to `skill/` never produces a release commit, so it stays stale until some unrelated Worker or `src/` change.
- **Fix:** add `"skill/**"` to `paths`.

### M2. Frontmatter parser accepts `__proto__` as a key (prototype pollution of the result)

- **File:** `worker/src/skills/skill-frontmatter.ts:129,166,178-180`. `KEY_RE` allows `__proto__`, and the outputs are plain `{}` objects.
- **Scenario (confirmed by probe):**
  - **Map value:** `__proto__:\n  name: evil\n  description: x` passes validation, because `name` and `description` are inherited from the prototype.
    - The serialised frontmatter is `{}`.
    - So a `skills/list` entry would have no `name` or `description`, which violates the spec's MUST.
    - The registry would store the skill under `skill:evil` with an empty frontmatter.
  - **Scalar value:** `__proto__: 5` is silently dropped, so the result is no longer verbatim.
- **Reachability:** not reachable from the network in phase 1, because `publish` is only an internal Durable Object RPC. Phase 2 will feed untrusted SKILL.md files into this path.
- **Fix:**
  - Reject the keys `__proto__`, `constructor` and `prototype`, or build `out` and `map` with `Object.create(null)`.
  - Read `name` and `description` with `Object.hasOwn`.

### M3. The Durable Object trusts the owner id the caller passes in

- **File:** `worker/src/skills/skill-registry.ts:224-228` (`canRead`), `:235`, `:259`; `account-skills.ts:33-46`
- **Problem:**
  - `served(ownerId, principal, …)`, `listServed` and `readFile` grant full access whenever `principal === ownerId`, but `ownerId` is an argument, not the object's own identity.
  - `publish` also stores `input.ownerId` as `skill.ownerId`, and that value is later used to build team URIs.
- **Why it is safe today:** `SkillCatalog.servedFor` passes the same id it used to address the object.
- **Scenario:** a future caller passes a mismatched id, for example `registries.getByName(victim).served(me, me, name)`. That caller reads the victim's private skills.
- **Fix:** derive the owner from `this.ctx.id.name` inside `AccountSkills`, and drop the parameter (or assert it matches).

### M4. Every request does unbounded fan-out; pagination only slices afterwards

- **File:** `skill-catalog.ts:554-569` (`list`), `skill-registry.ts:219-222,245-253`, `skills-tool.ts:274`
- **Problem:**
  - `skills/list`, `resources/list`, `multix_skills search` and `multix_skills read` all call `catalog.list()`.
  - `list()` fetches every served skill: one RPC returning up to 200 full revisions, each with up to 512 file records.
  - It then makes one cross-object RPC per share record. `shares()` has no limit, and there is no cap on the number of share records.
  - `multix_skills read` builds the whole list just to look up one revision number.
- **Scenario:** a grantee with thousands of share rows (phase 2), or an account at the 200-skill limit, turns every `skills/list` page into many megabytes of RPC traffic and hundreds of subrequests. That risks hitting the per-request subrequest and CPU limits.
- **Fix:**
  - Cap shares per account.
  - Page inside the Durable Object: return summaries, and fetch full revisions only for the page.
  - In `read`, take the revision from `servedFor` (or from the builtin entry) instead of calling `list()`.

### M5. `multix_skills` revision staleness check is a no-op for built-ins

- **File:** `skill-catalog.ts:448` (`revision: 1` hard-coded); `skills-tool.ts:274-282`
- **Problem:**
  - Built-ins are the only content served in phase 1, and they always report `revision: 1`, even after a deploy that changes their bytes.
  - The docs say: "Pass the `revision` or `digest` … to get `STALE_REVISION` if it changed since."
- **Scenario:** an agent passes `revision: 1` after a redeploy and silently receives the changed text. `_meta.revision` likewise never changes between deploys.
- **Fix:** either expose a builtin revision that changes when the content changes (for example derived from the `manifestDigest` or the version), or document that `digest` is the only staleness token for built-ins. Add a test.

### M6. Revision numbering in `publish` is not atomic (latent until phase 2)

- **File:** `skill-registry.ts:147-192`
- **Problem:**
  - The `skill:` existence and count checks, and the read of the last revision, are separated from the final `put` by awaited blob puts and `await manifestDigest(...)` (crypto, not storage).
  - Whether the Durable Object's input gate holds across the crypto await is not guaranteed.
- **Scenario:** two concurrent publishes of the same name both compute `revision N+1`. The second one overwrites the "immutable" revision record. The 200-skill cap can be exceeded the same way.
- **Fix:**
  - Compute all digests, including the manifest digest, before reading the counter.
  - Run the check-and-write in `ctx.storage.transactionSync` or `blockConcurrencyWhile`.
  - Refuse if the target `rev:` key already exists.

## Low

### L1. A UTF-8 BOM in a built-in SKILL.md builds cleanly but every read then fails as CORRUPT (confirmed)

- **File:** `worker/scripts/skill-catalog-builder.ts:376`
- **Problem:** `ignoreBOM: false` strips the BOM from `text`, but `size` and `digest` are computed over the raw bytes. At runtime, `skill-catalog.ts:602-604` re-encodes the text, so the size check fails (67 bytes vs 64) and every read returns -32603.
- **Fix:** refuse a BOM in the builder, or decode with `ignoreBOM: true`.

### L2. Registry "text" files are not checked for valid UTF-8 (phase 2)

- **File:** `skill-catalog.ts:678-681`
- **Problem:** a published `.md` or `.txt` file that is not valid UTF-8 is decoded lossily, with U+FFFD replacements. The text sent to the host then no longer matches the advertised digest, so host verification fails.
- **Fix:** validate UTF-8 for text media types at publish time, or fall back to `blob`.

### L3. Some YAML scalars are typed differently from YAML 1.2 core (confirmed)

- **File:** `skill-frontmatter.ts:61-69`
- **Problem:** `0x1F`, `0o17`, `.inf` and `.nan` become strings here but numbers in core-schema parsers. Timestamp-like values such as `2026-10-28` become `Date` objects in js-yaml's default schema.
- **Impact:** the spec requires hosts to compare frontmatter field by field, so a host would treat these as verification failures.
- **Fix:** in keeping with the strict design, refuse these forms rather than guess (require quoting).

### L4. Team URIs can address an arbitrary Durable Object name

- **File:** `skill-catalog.ts:407-408, 575`
- **Problem:** in `skill://team/<anything>/x/SKILL.md`, the `<anything>` segment is passed straight to `getByName`, so each request can spin up an empty object.
- **Impact:** low. Requests are already rate-limited per account.
- **Fix:** validate the owner segment against the account id format `^gh-\d+$`.

### L5. A team skill read via a valid grant can fail with a spurious STALE_REVISION (phase 2)

- **File:** `skills-tool.ts:225-229, 274-281`
- **Scenario:** the grant exists but no `share:` index row does. `owningSkill` then returns undefined, so passing `revision` fails with STALE_REVISION "now revision unknown".
- **Fix:** resolve the revision from the URI directly (same fix as M4).

### L6. Changing a skill back to `team` revives old grants (phase 2)

- **File:** `skill-registry.ts:169-179, 224-228`
- **Problem:** republishing a skill as `private` leaves its `access:` rows in place. Flipping it back to `team` silently re-grants every earlier principal.
- **Fix:** clear grants on a visibility change, or require them to be re-issued.

## Informational

- **Plan claim:** "Docs: … worker README", but no `worker/README.md` exists. Docs were updated in `README.md` and the docs-site guides (EN and VI) instead.
- **Agent Skills frontmatter:** top-level `version:` is not an Agent Skills frontmatter field (it predates this change; the nested skills copy it). Strict validators such as `skills-ref` may warn.
- **Legacy (2025) responses** now include `resources` in `initialize`, a fifth tool `multix_skills`, and `ttlMs`/`cacheScope` in `resources/*` results. These are additive. The existing four tool schemas are unchanged (job-tools test).
- **Generated JSON:** `builtin-skills.json` is gitignored and regenerated by the `pre*` hooks. CI (`npm run typecheck|test|check:bundle --prefix worker`) and deploy (`npm run deploy --prefix worker`) all go through npm scripts, so the hooks fire there. Running `npx vitest` or `npx tsc` directly in a fresh worktree fails until `npm run skills` has been run. The test "matches the repository's skill/ directory" guards against a stale file.
- **Bundle:** no `node:*` imports anywhere in `worker/src/skills`.

## Test gaps against the acceptance criteria

- No test for release-please extra-files coverage or version consistency (H1).
- No test that a built-in content change changes `revision` or STALE_REVISION (M5).
- No frontmatter test rejecting `__proto__` or other reserved keys (M2), and none for BOM handling (L1).
- No test for concurrent `publish` (M6), nor for a team read with a grant but no share row (L5).
- Modern `resources/read` is only exercised with the `mcp-name` header injected by the test helper. Confirm that this matches what 2026-07-28 clients actually send.

## Recommended actions (priority order)

1. H1: add the nested skills to the beta config, update AGENTS.md, and add a config/version consistency test.
2. M1: add `skill/**` to the `deploy-mcp.yml` paths.
3. M5: give built-ins a content-derived revision, or document digest-only staleness.
4. M2 and L1: harden the parser and builder (reserved keys, BOM).
5. Before phase 2: M3 (owner from object identity), M4 (bounded fan-out, cap on shares), M6 (atomic publish), L2, L5, L6.

## Unresolved questions

- Is the `dev`/beta release line still active after this merges? If it is, H1 is a blocker.
- Should built-in `revision` track deploys, or is `manifestDigest` the intended staleness token?
