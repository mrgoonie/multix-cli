# Code review: model & provider catalogue (#414)

Branch `claude/gracious-heisenberg-8maah6` vs `origin/dev` (4 commits, 53 files, +6473/-44).
Reviewer did not write the code. No source files modified.

## Checks run

- `npm run lint`: clean (619 files).
- `npm run typecheck`: clean.
- `npx vitest run tests/unit/catalog tests/unit/commands/catalog-command.test.ts`: 8 files, 202 tests pass.
- `npm run check:mcp`: worker typecheck ok, 23 files / 399 tests pass, bundle check clean (no `node:*`, commander, execa).
- Manual: `node dist/cli.js catalog ...` with `HOME` set to a scratch directory; no provider key set, no paid API called.
- Source checks: fal Seedance 2.5 and Kling v3 Pro model pages fetched to check the rate cards.

## Invariants: verified

| Invariant | Result |
|---|---|
| Unknown/stale prices never $0, never ranked | Holds. `quoteRate` returns `total_usd: null` for non-current rates; ranking only covers `priced` rows. |
| compare ranks only rows confirming every pinned setting | Holds (`matchConfig`, `price-compare.ts:47-67`). |
| Usage dedupes by receipt operation_id; unreceipted ok runs = unknown | Holds (`usage-aggregate.ts:146-161`). See finding 4 for a separate counting bug. |
| Review/note text scrubbed + marked untrusted | Holds on write. Breaks on the ledger (finding 1) and on read (finding 2). |
| team/public refused | Holds (`reviews.ts parseScope`). |
| Atomic write, mode 0600 | Holds for a single writer (store file and dir are 600/700). Concurrent writers lose updates (finding 5). |
| MULTIX_CATALOG_FILE not settable from project .env | Holds; checked live (warning printed, value ignored). |
| No `node:*` in worker-imported src | Holds (import graph read + bundle check). |
| No key values / signed URLs logged or returned | **Broken** by finding 1 (run ledger). The worker side is fine. |
| CLI --json, MCP and REST same payload via catalogQuery | Holds for providers/models/compare. **Not for `show`** (finding 6). |

## Findings

### 1. [blocking] `multix catalog` runs are recorded in the run ledger: unscrubbed review text lands in history.jsonl, and the ledger fills with catalogue noise

- `src/agent/agent-runtime.ts:47`: `UNRECORDED = /^(history|models|guide|rerun|check|update)\b/` does not include `catalog`. This branch adds `catalog` to `UTILITY_COMMANDS` and `EXCLUDED_COMMANDS` but not to this list.
- How it fails (reproduced):
  ```
  multix catalog review fal:x --text "see https://bucket.s3.amazonaws.com/v.mp4?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAXXXX me@corp.com api_key=abc123 AIzaSyA1234567890abcdefghijklmn"
  ```
  The store gets the scrubbed text (`?[redacted] [email] [redacted] [redacted]`). `~/.multix/history.jsonl` gets the full argv as typed, including the signed query, the e-mail address, `api_key=abc123` and the Google key. `redactArgv` (`history-store.ts:74`) only redacts secret-named options and argv items that *start with* a signed URL. It does not look inside free text. `multix history show` prints this back, so the review scrubbing does not protect the ledger. This also contradicts SKILL.md ("Ledger has no keys or signed URLs").
- Further effects (reproduced):
  - `catalog usage --by provider` lists a `catalog` row ("catalog 3 req, 3 ops, 3 ok") and counts the usage command's own run. With `--by offering` the row is `catalog:(unknown model)`.
  - `history`, `history stats` and `rerun last` are filled with catalogue reads.
  - The documented `catalog rate <offering> 4 --job last` (docs `catalog.md:88`, `vi/commands/catalog.md:90`) does not work in normal use. `last` is the previous `catalog` command, so it fails with "Run h_… used catalog:an unknown model". A failed `catalog rate` is recorded too, so retrying fails the same way.
- Fix: add `catalog` to `UNRECORDED` (`/^(history|models|guide|rerun|check|update|catalog)\b/`). Add a test that a `catalog review --text <secret>` run leaves no ledger entry. Separately, consider redacting URLs embedded inside argv text in `redactArgv` (`redactUrlsInText`). That is a pre-existing gap: open a separate issue per AGENTS.md.

### 2. [blocking] Project-scope store is read with no validation or re-scrubbing: a cloned repo can inject terminal escapes and poison `recommend`

- `src/commands/agent/catalog-store.ts:33-49` (`readStore`) accepts any array content. `readAll()` always reads `./.multix/catalog-notes.json` from cwd for `show`, `reviews list`, `note list` and `recommend`. The project store is meant to be committed (docs `catalog.md:101`), so it is repository-controlled input. This is the same threat this PR blocks for `MULTIX_CATALOG_FILE` ("a repository must not read or seed your private reviews").
- How it fails (reproduced with a crafted `.multix/catalog-notes.json` holding scores `99`, `"5"`, `7` and text `\u001b]0;pwned\u0007\u001b[2J … https://x/?X-Amz-Signature=abc`):
  - `catalog reviews list` (human) writes the raw ESC/BEL sequences to the terminal (`catalog-command.ts:541`, `:628`, `:306`). This allows title rewriting and screen clearing; the signed URL is printed as is.
  - `summarizeReviews` (`reviews.ts:258,267`) adds the string score `"5"` by concatenation: `average 3319/5`. `recommend -t video --json` gives the offering `score: 207.375` and a rating factor `value: 829.5`, outside the documented 0–1 range. An agent that acts on `recommend` can be steered by any repo.
  - `distribution["99"]++` adds a `NaN` key.
- Fix: in `readStore`, validate each record on load. Keep a record only if `offering` matches `OFFERING_RE`, `scope` matches the file, `score` is an integer 1–5, the aspects are valid, the verdict is valid, and the timestamps are strings. Pass all text fields through `scrubText` and the existing bounds (reuse `cleanReview`/`cleanNote`), and drop or count invalid records. Add a test with a hostile project file.

### 3. [should-fix] Symlinked project store copies private reviews into the repository

- `catalog-store.ts:25` resolves `./.multix/catalog-notes.json` and follows symlinks on read. `writeStore` (`:56-60`) then replaces the link with a regular file.
- How it fails (reproduced): a repo commits `.multix/catalog-notes.json -> ~/.multix/catalog-notes.json`. The user runs `multix catalog rate fal:y 3 --scope project`. The private store is read as the "project" store, a review is added, and the result is written as a regular file in the repo. The repo file now holds the user's private reviews (checked: the private text appears in `repo/.multix/catalog-notes.json`), ready to be committed and pushed. `readAll` also shows private records twice while the link exists.
- Fix: for the project scope, `lstat` the file and its `.multix` parent and refuse a symlink (or open with `O_NOFOLLOW`). Also drop records whose `scope` does not match the file being read.

### 4. [should-fix] `usage` counts runs that sent nothing as requests and failures, which skews success rate and `recommend` reliability

- `src/catalog/usage-aggregate.ts:136` skips only `dry_run`/`estimate_only`. Docs (`catalog.md:73`) say "A request is one recorded run that sent something."
- How it fails (reproduced): `multix fal video "x"` with no `FAL_KEY` set records a run whose receipt is `role: "none"`, `actual_source: "no_request"`. `catalog usage --by provider` then shows `fal 1 req, 1 ops, 0 ok, 1 failed`. Local validation and missing-key errors lower `success_rate`, and through it the `recommend` reliability factor (`recommend.ts`, `u.requests >= MIN_RUNS`), even though the provider was never contacted.
- Fix: in `aggregateUsage`, skip entries whose receipt has `role === "none"` or `actual_source === "no_request"`, plus legacy entries with no `http`/`provider_ids`. Alternatively, keep them in a separate `not_sent` count and use only sent runs for `requests`, `failed` and `success_rate`.

### 5. [should-fix] Concurrent writes lose records (no lock around read-modify-write)

- `catalog-store.ts:84-104, 106-131, 151-168`: `upsertReview`/`addNote`/`replaceNote`/`removeRecord` read the whole store, change it and rename it into place. Each write is atomic; the read-modify-write cycle is not.
- How it fails (reproduced): 8 parallel `multix catalog rate fal:m$i 4` calls leave 7 reviews. Agents commonly run tool calls in parallel.
- Fix: take an exclusive lock file (`fs.openSync(file + ".lock", "wx")` with retry and a stale-lock timeout) around read+write. Also use a unique tmp name (pid plus random), so a leftover tmp from a crashed run cannot keep an older mode.

### 6. [should-fix] Doc claim false: `show` from MCP/REST is not "the same payload as the data of `multix catalog show --json`"

- CLI `show` (`catalog-command.ts:268-292`) does not call `catalogQuery`. Its `data` keys are `notes, offering, provider, ratings, reviews, schema, usage, user_content`. `catalogQuery` `show` (used by MCP/REST) returns only `schema, offering`. The claim is in `docs-site/.../commands/catalog.md:130`, the VI page, `guides/mcp-server.md` (tool table) and the README (MCP section, "the same payload as the `data` of `multix catalog <view> --json`").
- Scenario: an agent or script that switches between local `--json` and REST on `show` gets `provider`/`usage`/`ratings` locally and missing keys remotely.
- Fix: either build the CLI `show` from `catalogQuery({view:"show"})` and put the local-only blocks under one clearly named key (`local: {usage, ratings, reviews, notes}`), or narrow the docs to say providers/models/compare are identical and `show` adds local blocks in the CLI.

### 7. [should-fix] fal Seedance 2.5 rate cards pin `audio: true` although fal says audio does not change the price

- `src/catalog/rate-cards.ts:58-59`: the comment says "it gives no audio-off price" and the cards use `config: { resolution, audio: true }`. The fal model page (fetched 2026-10-28) says: "`generate_audio` does not change your token count — audio is generated in the same pass." The token formula has no audio term.
- Scenario: `catalog compare -t video --resolution 720p --duration 10 --audio off` reports fal Seedance as `not_comparable: no price on file for resolution 720p, audio off`, although the source states the price. With audio left unpinned, the fal row shows "not ranked: pin audio on" while Atlas (which really does not state audio) is ranked #1. The result is a conservative but wrong exclusion, and the ranking ends up favoring the less-documented provider.
- Fix: `config: { resolution }`, `config_independent: ["audio"]`, and cite the sentence in `notes`.

### 8. [nit] `9:16` and other aspect ratios make token-billed quotes `unknown`

- `rate-cards.ts:158-162` has only `@16:9` frame sizes. `compare ... --aspect-ratio 9:16` gives `unknown: frame size of 720p at 9:16 is not on file` (reproduced), although the area, and so the token count, is identical. Add the transposed sizes (`"720p@9:16": [720, 1280]`, etc.) once they are confirmed against fal's formula.

### 9. [nit] REST and MCP validation differ

- `worker/src/api/job-api-handlers.ts:33,74-75`: REST accepts `images=2.5` (OpenAPI says `integer`; MCP uses `.int()`) and an unbounded `duration_s` (MCP caps it at 3600). The impact is harmless arithmetic, but the "same inputs" parity claim does not hold. Reuse the zod schema, or add `Number.isInteger` and a max in `numberParam`.

### 10. [nit] `verifiedUsage` compares against the string `"<provider>:undefined"`

- `catalog-command.ts:133`: when a run has no resolved model, the comparison string is `fal:undefined`. `parseOffering` accepts `fal:undefined` as an offering id, so `catalog rate fal:undefined 5 --job <id>` marks the review as verified against a run with an unknown model. Reject the run when `model` is undefined before comparing.

### 11. [nit] `note edit` bypasses the 20-notes-per-use-case limit

- `catalog-command.ts:643` plus `replaceNote` (`catalog-store.ts:144-160`): changing `--use-case` on edit does not re-check `LIMITS.notesPerUseCase`. `--text` also cannot be cleared on edit (`opts.text ?? prev.text`).

### 12. [nit] Human `usd()` shows small known amounts as `$0.0000`

- `catalog-command.ts:71`: `n < 0.01 ? n.toFixed(4)` prints `$0.0000` for $0.00004. This is not a null shown as $0, but it reads as zero. `src/agent/cost-preflight.ts` already has a `usd()` that uses `toPrecision(3)`; reuse it (DRY).

## Regressions checked

- `history` command: `receiptOf` moved to `usage-aggregate.ts` and re-exported unchanged; there is no other importer. Behaviour is the same, apart from catalogue runs now showing up in the ledger (finding 1).
- `pricing-catalog.ts`: three meters added to the union. `tsc` passes and existing exhaustive uses compile. Audio price entries are unchanged.
- MCP tool list: `multix_model_catalog` is always listed. The legacy-schema test was relaxed from equality to `arrayContaining`; it still fails if a legacy tool goes missing. Worker tests pass.
- `cli-command-policy.ts` excludes every `catalog *` command from `multix_run`; `cli-catalog.json` was regenerated.

## Plan follow-ups (`plans/261028-0907-414-model-catalogue/plan.md`)

Phases 1–4 are implemented. Before the status moves on, findings 1–2 need fixing, with tests for: no ledger entry for catalog runs, a hostile project store, and not-sent runs excluded from usage.

## Unresolved questions

- Do status-poll runs (`fal video-status` etc.) record `model_resolved`? If they do, polls count as separate "runs" toward `recommend`'s `MIN_RUNS` and success rate, since `success_rate` is per request rather than per operation. I did not verify this; consider using operations for reliability.
- Atlas per-resolution prices were not re-checked against the live pricing page.

Status: DONE_WITH_CONCERNS
Summary: The core pricing and compare invariants hold and all checks pass. Two blocking defects: catalog runs are written to the run ledger with unscrubbed review text (secrets and signed URLs), and the project-scope store is trusted on read (terminal escapes, recommend poisoning).
Concerns/Blockers: Findings 1 and 2 should be fixed before merge; 3–7 are should-fix.

## Resolution (implementer, 2026-10-28)

| # | Outcome |
|---|---|
| 1 | Fixed: `catalog` added to the unrecorded commands in `src/agent/agent-runtime.ts`; smoke test checks that a review with a signed URL and an e-mail address leaves the ledger empty. |
| 2 | Fixed: `loadReview` / `loadNote` in `src/catalog/reviews.ts` validate and scrub every stored record on read (string or out-of-range scores, bad aspects, bad ids or timestamps are dropped; scope is the file's own). |
| 3 | Fixed: the project store refuses a symbolic-link file or `.multix` folder on read and write. |
| 4 | Fixed: `sentRequest` leaves out failed runs with no job, receipt, provider id or HTTP request. Docs EN and VI updated. |
| 5 | Fixed: `withStoreLock` (exclusive lock file, 5 s wait, 30 s stale) wraps every read-modify-write; 8 parallel `catalog rate` calls now keep 8 reviews. |
| 6 | Fixed in docs: identical payload stated for `providers`, `models` and `compare`; `show` on MCP and REST returns the offering without the CLI's local data (README, catalogue page and MCP guide, EN and VI). |
| 7 | Fixed: fal Seedance cards use `config_independent: ["audio"]`. |
| 9 | Fixed: REST `duration_s` ≤ 3600 and `images` a whole number ≤ 100, matching the MCP schema. |
| 10 | Fixed: `--job` refuses a run without a resolved model. |
| 11 | Fixed: `note edit` enforces the per-use-case limit. |
| 12 | Fixed: the CLI uses `usd()` from `src/agent/cost-preflight.ts`. |
| 8 | Kept: the token formula only knows 16:9 frame sizes, so another aspect ratio stays `unknown` instead of a guessed price. |
