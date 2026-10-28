# Code review: `multix catalog` + `multix_price_book` / `GET /price-book` (issue #414 phase 1)

Diff: `git diff cc84589..HEAD` (3 commits, 53 files, +7231/-41). Branch `claude/gracious-heisenberg-htvhke`.

## Verification run

| Check | Result |
|---|---|
| `npm run build` | pass |
| `npm run lint` | pass (619 files) |
| `npm run typecheck` | pass |
| `npm test` | 136 files passed, 8 skipped; 2511 tests passed, 22 skipped |
| `npm run check:mcp` | pass; worker 23 files / 400 tests; bundle check clean (no `node:*` in `src/catalog/**`) |

I also ran the built CLI by hand, with a scratch HOME, `MULTIX_HISTORY_FILE` and `MULTIX_CATALOG_FEEDBACK_FILE`, to reproduce the findings below.

## Critical

None found. Key values are never output. The `providers` view, on both the CLI and the Worker, returns only env-var names and a ready boolean (`src/catalog/price-book.ts` listProviders, `worker/src/jobs/price-book-view.ts` priceBookHooks). The REST route sits behind `authenticate()`. Errors go through the existing `errorResponse`/`runTool` sanitisers.

## High

### H1. `compare` ranks different resolutions and aspect ratios against each other when the caller leaves them out
`src/catalog/price-book.ts:330-345` (`assumed`), `:385-395` (`betterQuote`), `:417-433` (`compareFamily`)

When the config does not set `resolution`, `aspect_ratio` or `audio`, `quoteRate` still returns `quoted` and only records the rate's own condition in `assumed`. `compareFamily` then keeps the cheapest quote per ref (`betterQuote` prefers the lower amount) and ranks all of them in `comparable`. As a result each provider's cheapest tier is ranked against every other provider's cheapest tier, whatever those tiers are.

Reproduced:
```
$ multix catalog compare seedance-2.0 --duration 10
#1 byteplus:dreamina-seedance-2-0-260128  $0.7   (10 s x 0.07 USD/video_second)  assumes resolution 480p, aspect ratio 16:9
#2 fal:bytedance/seedance-2.0/image-to-video  $3.034  assumes resolution 720p
#3 fal:bytedance/seedance-2.0/text-to-video   $3.034  assumes resolution 720p
```
BytePlus 480p is ranked against fal 720p. The command, the MCP tool description and the OpenAPI text all promise a "like-for-like" comparison, and agents read `comparable[0]` from `--json` / `multix_price_book` without parsing `assumed`. Same path: without `--task`, text-to-video and image-to-video quotes are ranked together. The BytePlus ref covers both modes, while fal has one ref per mode.

Fix (choose one):
- Rank a quote only when its `assumed` list is empty. Quotes with assumptions go to `not_comparable`, with a reason such as "give --resolution (rates differ by resolution)".
- Or group `comparable` by the tuple of assumed conditions and rank only inside a group. Do not use `betterQuote` to pick the cheapest tier.
- At minimum, when the family's rates differ on resolution, require `resolution` for `compare`, and require `task` when they differ on mode.

Add a test: `compareFamily("seedance-2.0", { duration_s: 10 })` must not rank BytePlus 480p above fal 720p.

### H2. Usage for async jobs moves to `<provider>:(unknown model)` once a status poll is the latest run, and `--job <provider job id>` is then refused
`src/catalog/usage-analytics.ts:236-246` (`usageReport` grouping by the latest entry), `src/commands/agent/catalog-command.ts:84-104` (`verifiedUsage`)

`usageReport` puts every run of an operation in the group of the operation's **latest** entry. Status, result and resume runs (`fal status <model> <id>`, `leonardo status`, `runway status`, `heygen status`, ...) usually record no model:
- `agent-runtime.ts:323-326` writes `model` only from `run.requestModel ?? options.model`.
- A GET poll has no JSON body, so `modelFromRequest` finds nothing.
- `model_resolved` is set only when the response names a model.

So the most common async flow (submit, then `status`) moves the whole operation, including its cost, to `fal:(unknown model)`.

Reproduced with a two-line ledger: a submit with `model` and job `J1`, then a later `fal status` for `J1` with `usage.cost_usd`. `catalog usage --by model` returns a single row `fal:(unknown model)` with the $3 cost. Consequences:
- `catalog show <ref>` reports `usage: null`.
- `recommend` loses the reliability evidence for that offering.
- `catalog rate <ref> --job J1` fails with `Run h_a2 used fal:(unknown model), not fal:bytedance/...`. The same call succeeds with the submit's history id.

Fix:
- Key an operation by the latest entry **that names a model**: `resolvedModelOf` of the newest entry with any model, falling back to `(unknown model)` only when none does.
- In `verifiedUsage`, look at all entries of the operation (by `operationOf`). Accept the run when any entry matches the ref, and require a completed job state, not just a successful submit (see M3).

## Medium

### M1. Project-scoped feedback leaks into every project
`src/commands/agent/catalog-command.ts:247` (`show`), `:378` (`recommend`), `:449` (`feedback`)

`--scope project` stores `project: path.basename(cwd)`, but every reader uses `readFeedback()` unfiltered. A project-A `avoid` note therefore sinks the offering in `recommend` in project B, and project-A ratings are counted in B's `ratings` mean. Repos that share a basename (`app`, `web`) also collide.

Fix:
- Filter to `scope === "private" || project === <current project>` in show, recommend and the summary.
- Store a stable project identity, such as the realpath or a hash of the git root, instead of the basename.

### M2. `catalog edit` can create duplicate ratings for the same use case
`src/commands/agent/catalog-command.ts:497-516`

`addFeedback` enforces one rating per ref, use case, scope and project (`sameRating`). `edit --use-case X` writes through `updateFeedback` with no such check. If a rating for X already exists, two ratings now count in `summariseRatings` (count, mean, confidence).

Fix: in `edit`, when kind is `rating` and `use_case` changes, either refuse or merge into the existing entry using the `sameRating` logic.

### M3. "Verified usage" accepts a submit that only queued a job
`src/commands/agent/catalog-command.ts:99-101`

`entry.ok` on a submit run without `--wait` means the provider accepted the job, not that it completed. A job that later fails at the provider is still marked `verified_usage` and counted in `summariseRatings.verified_usage`. For job entries, fix this by requiring an ok entry of the operation that has outputs or a terminal success state.

### M4. `findHistory` prefix matching makes `--job` loose
`src/commands/agent/catalog-command.ts:87-89`

`findHistory(job)` is tried first and accepts `last`, `last-N` and any **prefix** of a history id. The documented intent is "local history run id or provider job id". `--job h_` therefore verifies against whichever run is newest, and an exact provider job id is never tried if a history id happens to start with it.

Fix: for `--job`, match a history id exactly or a job/provider id exactly. Keep prefix and `last` only if that is explicitly intended, and document it.

## Low

- **L1. Price book needs key decryption on views that do not use keys.** `worker/src/api/api-router.ts:251`. `routeName === "price-book"` always decrypts the account's keys. A stored key that cannot be decrypted then fails `models`, `show` and `compare` as well, which are static data. Only `view=providers` needs keys. Decrypt lazily, or only for `view=providers`.
- **L2. CLI/Worker parity on `count`.** The Worker requires an integer (`z.number().int()`). The CLI's `bounded()` (`src/catalog/quote-config.ts:28-35`) accepts `--count 2.5` and quotes "2.5 image(s)". Add `Number.isInteger` for count in `quoteConfig`, so every surface shares the rule as the file header claims.
- **L3. `--count` is silently ignored for video and request units.** `price-book.ts:357-363`. `count` only scales `image` units, so `--count 3` on a per-second or per-video rate quotes a single clip. Either scale `video` and `request` too, or mark the field as not applied.
- **L4. Rounded BytePlus "example" rates are quoted and ranked as exact.** `media-rate-cards.ts` byteplusCards `perSecond`. These are the page's rounded 16:9 / 5 s examples: 0.15 vs about 0.1512 /s at 720p, 0.37 vs about 0.374 /s at 1080p, from the token rate. The Quote also drops the card's `notes`, including "alias resolution not confirmed". Consider carrying `label`/`notes` into `Quote`, or quoting from the token rate when the resolution is known.
- **L5. `sensitiveContent` "long token" pattern gives false positives.** `feedback-rules.ts` (`[A-Za-z0-9_-]{40,}` with a digit and a letter) rejects ordinary hyphenated phrases or model slugs of 40+ characters, e.g. `image-to-video-with-native-audio-at-1080p`. Consider excluding runs that contain `-` separated dictionary-like segments, or raising the threshold.
- **L6. Feedback store read-modify-write has no lock.** `feedback-store.ts` addFeedback, updateFeedback and deleteFeedback. Two concurrent `catalog rate` runs (parallel agent sessions) lose one write. The atomic rename prevents corruption but not lost updates. This is acceptable for a local CLI; note it, or use a lockfile like other stores if one exists.
- **L7. A malformed feedback file breaks the read paths.** `readFeedback` throws on bad JSON or schema, so `catalog show` and `recommend` fail entirely, not just the feedback parts. Entries are not shape-checked: a hand-edited `score: 7` produces a `distribution["7"] = NaN` key. Validate entries on read and degrade `show`/`recommend` with a warning.
- **L8. `catalog usage --since bad` throws a plain `Error`** (`parseSince`), which is not a `ValidationError`, so the exit code and error class differ from other input errors. The same behaviour already exists in `history`; it is mentioned only for consistency.

## Regressions to existing behaviour (checked)

- `receiptOf` moved from `history-command.ts` to `usage-analytics.ts` and changed semantics: legacy job entries now use operation `<provider>:<job id>` and role `observation` instead of `run:<id>` and `charge`. I traced this through `settleOperations`. A settled observation with `actual_usd` now settles the operation once (latest wins), where before each poll counted as a separate charge. This intentionally fixes double counting in `multix history` stats. `operationOf` matches `operationIdFor` (`<provider>:<providerIds[0]>`), so legacy and new entries of one job merge correctly. No other importer of the old export exists (grep: only `history-command.ts`).
- `catalog` was added to `UNRECORDED`, `NON_PROVIDER_GROUPS` and `NO_DRY_RUN_GROUPS`. Feedback writes are not recorded in history and get no `--dry-run`. OK.
- Worker `EXCLUDED_COMMANDS` lists all 12 `catalog` subcommands. `catalog-view` drops groups with no runnable command, so `catalog` does not appear as an empty job group. The worker tests that pin tool counts were updated.
- `MULTIX_CATALOG_FEEDBACK_FILE` was added to `PROJECT_ENV_EXCLUDED`, so a repo `.env` cannot redirect or seed feedback. OK.

## Input validation on REST/MCP (checked)

- The zod schema bounds `ref` (max 200), `family` (regex), `provider` (regex), `task` (enum), `duration` (positive, at most 3600; NaN is rejected), `count` (int 1-100), `resolution` (max 12, then the CLI regex), `aspect_ratio` (max 5, then `^\d{1,2}:\d{1,2}$`).
- REST booleans accept only `true/false/1/0`, otherwise 400. A non-GET method returns 405.
- `ValidationError` from the shared builders is a `MultixError`, so it maps to 400 (REST) or a tool error (MCP).
- `runTool` logs `view`, `ref` and `family` only.

## Recommended actions (priority order)

1. H1: stop ranking quotes whose assumed conditions differ, and require or segregate resolution and mode in `compare`. Add a regression test.
2. H2: key operations by the newest entry that names a model, and fix `verifiedUsage` to look across the operation.
3. M1: filter project-scoped feedback by the current project, with a stable project id.
4. M2 to M4: edit dedupe, completed-job check and exact `--job` matching.
5. L1 and L2: lazy key decryption, and count integer parity.

## Unresolved questions

- Is the BytePlus per-second "example" card meant to be rankable, or reference only? Its `label: "example"` suggests reference only.
- Should `compare` without `--task` merge modes into one ranking at all?

Status: DONE_WITH_CONCERNS
Summary: Build, lint, typecheck, all CLI tests and worker check:mcp pass, and I found no key leakage or trust-boundary defect. Two high-severity correctness bugs need fixing before merge: `compare` ranks different resolutions as like-for-like when `--resolution` is omitted, and usage plus `--job` verification lose the model for async jobs once a status poll runs.
Concerns/Blockers: H1 and H2 should be fixed before merge. Both were reproduced with the built CLI.

## Resolution (implementer, after review)

| Finding | Outcome |
|---|---|
| H1 compare not like-for-like | Fixed. `compareFamily` ranks nothing while a condition left open (resolution, aspect ratio, audio) is priced differently across the family's quotable rates; it returns `needs` and marks the quotes `not_equivalent` with the reason. Text mode prints which flags to give. Tests: CLI unit + Worker tool. |
| H2 async job loses model after a status poll | Fixed. An operation's group is decided by its latest run that names a model; `--job` checks every run of the job for the model and for a completed run. Tests added. |
| M1 project feedback leaks across projects | Fixed. Project tag is `<folder>@<sha256(path)[:8]>`; `show` and `recommend` use private feedback plus this project's only. Test added. |
| M2 edit bypasses one-rating rule | Fixed in `updateFeedback`. Test added. |
| M3 queued submit counts as verified | Not changed: history records no terminal job state yet, the same limit as `multix history` success counts. Tracked in a follow-up issue. |
| M4 `--job` prefix before exact id | Fixed: exact history id, then exact provider job id, then prefix / `last`. Test added. |
| L1 price-book decrypts keys for static views | Fixed: keys are loaded only for `view=providers`. |
| L2 `--count 2.5` | Fixed: whole number required on the CLI, matching the Worker. |
| L3–L8 | Low severity; tracked in a follow-up issue. |

Verification after fixes: lint, typecheck, build clean; `npm test` 2517 passed / 22 skipped; `check:mcp` 401 passed, bundle clean; `verify:docs` 0 errors.
