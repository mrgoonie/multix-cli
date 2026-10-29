# Code review: #435 compare/recommend ranking (estimates, assumptions, unstated settings)

Worktree: wt-435, uncommitted changes on origin/dev 044dfec. Reviewer did not write the code.

## Scope
- Files: src/catalog/price-compare.ts, src/catalog/recommend.ts, src/catalog/catalog-types.ts,
  src/commands/agent/catalog-command.ts, worker/src/jobs/job-tools.ts, worker/src/api/openapi-document.ts,
  docs-site catalog.md (EN + vi), skill/SKILL.md, 6 test files. ~266 insertions / 34 deletions.
- Worker parity: worker/src/jobs/model-catalog-view.ts calls the same `catalogQuery` -> `compareOfferings`; no separate logic, parity holds by construction.

## Verification run
- `npm run build` OK; `npm run typecheck` OK; `biome check` on src/tests/worker: clean.
- `npx vitest run tests/unit/catalog tests/unit/commands/catalog-command.test.ts`: 216/216 pass.
- Full `npx vitest run`: 2515 pass, 22 skipped, 0 fail.
- worker `npx vitest run test/model-catalog.test.ts test/rest-api.test.ts`: 21/21 pass.
- Regression check: new tests copied onto a clean `git archive HEAD` of dev: 7 fail on dev
  (estimate x2, unstated audio, assumption, 720p-nothing-ranked, recommend x2), pass on the branch. The tests are real regressions, not phantom.
- CLI probes (MULTIX_DISABLE_HOME_ENV=1, no network): `compare -t video -d 5` with no pins, `--audio off|on`,
  `--resolution 720p` with/without `--aspect-ratio 16:9|9:16`, `--resolution 4k`, `--provider atlas`, no `--task`;
  `recommend` with/without `--aspect-ratio`. Kling standard/pro still rank #1/#2 for `--audio off`; no priced row shows $0; unknown rows stay null.
- Synthetic probes (esbuild bundle of src, scratch only, deleted after) for the edge cases below.

## Critical
None.

## High
None.

## Medium

### M1. A covering card that is itself unranked still un-ranks every silent card
`src/catalog/price-compare.ts:173-185` (`markUnstated`). The trigger is "any priced card with
`config_independent` including the key", regardless of whether that card is rankable.
Repro (synthetic): offerings a ($1/s, silent on audio), b ($2/s, silent on audio) rank #1/#2 alone.
Add k (config `{resolution:"4k"}`, `config_independent:["audio"]`) - k is unranked (open `resolution 4k`)
yet a and b both lose their rank: the comparison ranks nothing. Same with an estimated covering card.
The function's own doc says the silent rows "are not ranked against it", but there is no "it" in the ranking.
It also contradicts the accepted rule that silent cards still rank against each other
("still ranks cards that are all silent on audio" test). The ranking of a/b now depends on an unrelated
unranked row being in the filter set.
Impact today: none on real data (the only silent card, Atlas, is already unranked as an estimate; Kling 4k
is the covering card that triggers it in `-t video -d 5`). It is latent and bites the first list-priced
card that is silent on audio.
Fix: only count covering cards that are otherwise rankable, i.e. run the trigger after the
estimate/assumption/open checks:
`priced.some(p => cover(p.rate, key) && !p.row.open_settings && !p.row.reasons?.length)`, and add a test with an
unranked covering card. If the broader rule is intended, change the doc comment and docs to say "priced",
not "ranked against".

### M2. `recommend` reports a quoted price as "quote unknown"
`src/catalog/recommend.ts:79-90, 163`; text output `src/commands/agent/catalog-command.ts:417`.
Unranked rows are dropped from `quote`, so `quote_usd` is null and the CLI prints `quote unknown` for Atlas
(a $1.5023 estimate). Probe: `catalog recommend -t video --resolution 720p -d 5 --aspect-ratio 16:9` ->
`atlas... quote unknown` next to `price: quoted but not ranked ...`. This pattern existed for open-setting rows
on dev; the change extends it to every estimate and assumption row, which are now the common case. "unknown" is the
term the catalogue reserves for "no usable price", so the same row reads as both priced and unknown.
Fix: keep `quote_usd` null for scoring, but print `quote not ranked` (or the cheapest unranked total, labelled)
when `unranked.has(o.id)`. Alternatively add an `unranked_quote_usd` field.

### M3. README example now ranks nothing
`README.md:71`: `multix catalog compare -t video --resolution 720p --duration 10 --audio on  # rank prices for one exact request`.
On this branch that command ranks zero rows: Atlas is not_comparable (audio), and fal assumes 16:9 so it is unranked.
The docs site and SKILL.md examples were updated with `--aspect-ratio 16:9`, but the README was not (AGENTS.md lists README.md as a user-facing doc).
Fix: append `--aspect-ratio 16:9` in README.md:71.

## Low

### L1. Cross-task contamination of the unstated-setting reason when `--task` is omitted
`price-compare.ts:173-185`. Without a task filter, any priced non-video card (e.g. an `output_images` image card) is marked
"source does not state whether this price includes audio, while other prices here do" whenever a video card
covers audio. Audio is not a dimension of image prices. Synthetic probe confirms. There are no priced image cards today
(`compare -t image` -> "No offerings match"). Mixing tasks in one ranking already happens on dev, so this is not new.
Fix: scope the trigger to offerings sharing a task with the covering card, or skip `markUnstated` when `req.task` is unset.

### L2. `resolution` in STATED_KEYS is dead and untested
`price-compare.ts:29`. No rate card has `config_independent: ["resolution"]`, and no test covers that branch.
Fix: drop it until a card needs it (YAGNI), or add a synthetic test.

### L3. `recommend` drops estimate/assumption reasons when a row also has open settings
`recommend.ts:83-85`. When a row has open_settings, only `not ranked: pin X` is kept, and its `reasons` (estimate, assumption) are lost.
Probe: an estimated card fixing 720p -> `price: quoted but not ranked for this request (not ranked: pin resolution 720p)`.
After the user pins 720p, the row is still unranked for a reason they were not shown. The compare text output
(catalog-command.ts:329-336) concatenates both, so recommend is inconsistent with it.
Fix: `const why = [...(open ? [pin] : []), ...(r.reasons ?? [])]`.

### L4. Misleading test name
`tests/unit/catalog/price-compare.test.ts:429` "ranks a card silent on audio only after audio is pinned and every ranked card confirms it"
asserts that the silent card is `not_comparable` and never ranked. Rename it, e.g. "a card silent on audio is not_comparable once audio is pinned".

### L5. Wordy text output and stale help
- Text rows repeat the `not ranked:` prefix up to three times per row (e.g. Atlas with no pins), and recommend wraps it again as
  `quoted but not ranked (not ranked: ...)`. Consider stripping the prefix when joining.
- The `compare` help (catalog-command.ts:311) and `--aspect-ratio` help (:316) do not say that pinning the aspect ratio is
  required to rank token-billed video. Suggest: `--aspect-ratio <ratio>  Aspect ratio (16:9); pin it to rank token-billed video`.
- No test covers the changed text-mode compare output (the smoke test uses `--json`).

## Edge cases checked, no defect
- Dense tie ranking is unchanged (ties share a rank, and the next rank is +1). It applies only to rankable rows.
- `--duration` absent: every video row is unknown with a reason; nothing is ranked; never $0.
- `--aspect-ratio 9:16`: the fal row is `unknown` (frame size not on file). Atlas stays unranked as an estimate. Its audio reason disappears
  because the covering card is not priced, which is consistent with the "priced card" trigger.
- The not_comparable collapse path (`close` filtering on OTHER_CONFIG) only sees all-not_comparable offerings. Priced rows with
  reasons never reach it, so the new `reasons` on priced rows cannot leak into it.
- `markUnstated` mutates rows already pushed into `rows`. These are the same object references, created fresh per call, so there is no shared state.
- JSON contract: `reasons` on priced rows is additive, and `assumptions`, `basis` and `open_settings` are unchanged. `price_rank` disappears from
  estimate and assumption rows, which is the intended behaviour change. It should ship as `fix(catalog)`, not as breaking.
- The worker MCP and OpenAPI descriptions match the CLI behaviour. The worker test URL passes `aspect_ratio=16:9`.
- Docs EN and VI are in sync bullet for bullet. The Vietnamese diacritics are correct ("không giả định gì thêm", "Hãy cố định",
  "tính tiền cuối cùng theo usage mà họ đo được"). `estimate` is still printed by `models`/`show` (catalog-command.ts:214), so the docs claim holds.
  The doc example output matches the CLI byte for byte for the first two rows.
- Recommend docs already say that price needs "a ranked quote" (catalog.md:132), so they are still accurate.

## Recommended actions
1. M1: restrict the covering-card trigger to rankable rows (or reword the docs to match), and add a test.
2. M3: update the README.md:71 example.
3. M2: stop printing "quote unknown" for priced-but-unranked offerings in recommend.
4. L3, L4, L1 as cheap follow-ups. L2 and L5 are optional.

## Metrics
- Typecheck: clean. Lint: 0 issues. Tests: 2515 pass (CLI) and 21 pass (worker focused). 7 new tests fail on dev, as they should.

## Unresolved questions
- M1: should an unranked card that covers a setting (open or estimate) still suppress ranking among silent cards? The accepted
  design ("silent cards still rank against each other") suggests not.
