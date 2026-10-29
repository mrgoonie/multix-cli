# Code review: #436 catalog review scrubber and project verified_usage

Reviewer: isolated code-reviewer (did not write the code). Base: origin/dev 044dfec + uncommitted worktree diff.
Files: src/catalog/reviews.ts, src/commands/agent/catalog-store.ts, 3 test files, EN/VI docs-site catalog.md (+404/-35).

## Verification run
- `npx vitest run tests/unit/catalog tests/unit/commands/catalog-command.test.ts`: 8 files, 250 tests pass.
- `npm run typecheck`: clean. `biome check` on touched files: clean.
- `npm run check:mcp`: worker typecheck/tests/bundle check pass; `src/catalog` has no `node:*` imports.
- Probes: new and origin/dev `scrubText` bundled with esbuild into the scratchpad and run side by side (fake tokens built by concatenation).
- Exhaustive check over all code points: NFKC applied to any character that `INVISIBLE` keeps never produces a character that `INVISIBLE` would strip (0 hits). So stripping first and normalizing second is safe on this ICU.

## Overall
The ledger check is designed correctly: writes use `KEEP_RUNS`, reads check the ledger, and `carriedOver` covers edits. The tests cover the main paths. The invisible-character set is broad and handles tag characters, bidi, ZW*, VS and word joiner. Merging is blocked by one regression: the new authorization lookbehind is quadratic and fires on any long whitespace run, and project-store text is scrubbed before the length limit applies. A committed `.multix/catalog-notes.json` can therefore stall every `multix catalog` read. There are also two redaction gaps on shapes the issue covers.

## Critical
None.

## High

### H1. Quadratic regex on whitespace: a malicious project store stalls every catalog read
- src/catalog/reviews.ts:52 `/(?<=\bauthorization\s*[:=]\s*)[A-Za-z]+.../gi`. V8 checks the lookbehind at every position. Inside a whitespace run the trailing `\s*` scans back over the whole run and then fails on `[:=]`, so the cost is O(n) per position and O(n^2) overall. Any whitespace run triggers it. The word "authorization" does not need to be present.
- src/catalog/reviews.ts:95-98 (`boundedText`): `scrubText` runs on the raw value **before** the 2000-char limit is checked, and `loadReview`/`loadNote` scrub every text field of every record on every read (`readAll`, `locate`).
- Measured, full `scrubText`, text = `"Great model.\n" + "\n".repeat(100000)`: new code **21.9 s**, origin/dev **4 ms**. Output is 12 chars, so the record also passes validation and stays in the store. Isolated pattern timings at 40k chars: whitespace/newlines with authLB about 3.0-3.5 s. Growth is quadratic, so 1 MB takes tens of minutes.
- Failure scenario: a repository commits `.multix/catalog-notes.json` with one review whose `text` is a few hundred KB of blank lines. Every `multix catalog show/list/review list/note ...` in that checkout hangs. Agents calling the CLI stall or time out.
- Fix: (a) drop the lookbehind and use a capture group, e.g. `/\b(authorization\s*[:=]\s*)[A-Za-z]+\s+(?=[A-Za-z0-9._~+\/=-]*\d)[A-Za-z0-9._~+\/=-]{8,}/gi` with replacement `"$1[redacted]"`. The loop at :89 needs a per-pattern replacement for that. (b) Bound the input before any regex runs: reject or drop a raw string longer than, say, `4 * max` in `boundedText`, and in `loadReview`/`loadNote` drop any record whose raw strings exceed the bound. (c) Add a regression test that times `scrubText(" ".repeat(50_000))` and asserts a loose bound such as < 200 ms.

### H2. The tightened long-opaque pattern is also super-linear and about 3-8x slower than before
- src/catalog/reviews.ts:70. The extra `(?=[\w-]*[A-Za-z0-9]{16})` runs greedily to the end of a dash-joined run and backtracks at every `\b` start position (every `-` creates one).
- Measured on 60k chars, new vs old: `"a1-"` repeated 24.0 s vs 8.1 s; `"abcdefghijklmn1-"` repeated 10.9 s vs 1.4 s; `"0123abcd-"` repeated 12.8 s vs 2.0 s. The old pattern was already quadratic here; this change makes it several times worse. The H1(b) input bound fixes the exposure.
- Fix: match candidates with a linear regex and decide inside a callback: `out.replace(/[A-Za-z0-9_-]{32,}/g, t => /\d/.test(t) && /[A-Za-z]/.test(t) && /[A-Za-z0-9]{16}/.test(t) ? "[redacted]" : t)`. Each test is linear per token. Apply H1(b) as well.

## Medium

### M1. The AWS secret access key leaks even in its standard forms
- src/catalog/reviews.ts:63-65. AKIA/ASIA key ids are redacted now, but their paired secret is not:
  - `aws_secret_access_key = <40-char secret>` -> unchanged (the name ends in `access_key`, and `[\w-]*(api[_-]?key|token|secret|password)\s*[:=]` requires the matched word immediately before `:`/`=`)
  - `AWS_SECRET_ACCESS_KEY=<secret>` -> unchanged
  - a bare 40-char secret containing `/` -> unchanged (the long-opaque class excludes `/` and `+`, so no segment reaches 32)
- People who paste AWS credentials paste the id and the secret together, so the half that is actually secret leaks. The issue asks for AWS coverage.
- Fix: broaden the key=value name to `[\w-]*(?:api[_-]?key|access[_-]?key|secret[\w-]*|token|password|credential)`, and add a bounded base64 pattern for 40-char secrets: `(?<![A-Za-z0-9+\/])(?=[A-Za-z0-9+\/]*\d)(?=[A-Za-z0-9+\/]*[A-Z])[A-Za-z0-9+\/]{40}(?![A-Za-z0-9+\/=])`. Add tests for the `~/.aws/credentials` and env forms.

### M2. Regression: unknown-prefix keys made of dash-separated groups no longer redact
- src/catalog/reviews.ts:68-70. Tightening the pattern to spare hyphenated model ids also spares opaque keys built from short groups: `<8>-<8>-<8>-<8>-<8>` and `<12>-<12>-<12>` (mixed-case letters and digits, no known prefix) were redacted on origin/dev and now leak. The UUID pattern covers only exact 8-4-4-4-12 hex.
- Model ids are lower-case words with short version tokens. Random keys have mixed case, or digits in most groups.
- Fix: exempt a run only when it looks like a model id. For example, keep the old rule but skip tokens whose `-`-separated segments are all lower-case and each is either a dictionary-ish word (`/^[a-z]+$/`) or a short version token (`/^v?\d+[a-z]?$|^\d+[a-z]$/`). Or redact when at least 3 segments each mix letters and digits. Add tests for both directions (`kling-v2-1-master-image-to-video` kept, `aB3xaB3x-...` x5 redacted).

### M3. A teammate can reuse another person's run reference to mark their own review as verified on that person's machine
- src/commands/agent/catalog-store.ts:64-80 and src/catalog/reviews.ts:356-360. The check binds a run to the offering only. It does not bind the run to one review. Alice's committed project review exposes `{history_id, ts}` from her ledger. Bob commits a second review of the same offering (another `use_case`) that carries the same `verified_usage`. On Alice's machine both reviews read as verified and `verified` in `summarizeReviews` counts 2. Bob's text is shown as backed by Alice's run. (Guessing an unknown id is infeasible: `h_<ms36><4 random>` plus an exact ts.)
- Fix: in `readStore`, accept each `history_id` for at most one review (the first or oldest), and drop it from later claimants. Optionally also require `created_at >= ts`.

## Low

- L1. Performance (src/commands/agent/catalog-store.ts:67-79). `entries.some` runs per project review and calls `resolvedModel` before comparing ids. The cost is O(reviews x ledger). A hostile store with 5000 fake-verified reviews against a ledger near 20 MB means about 10^8 iterations. `catalog show` (catalog-command.ts:273-274) and the usage view (:404-409) also parse history.jsonl twice: once for `aggregateUsage`, once inside `ledgerRunCheck`. `locate()` builds a fresh check per call. Fix: build `Map<id, entry>` once in the closure, compare `id`/`ts` first, and let callers pass the already-read entries.
- L1b. src/commands/agent/catalog-store.ts:67. `readHistory` pushes `JSON.parse(line)` without checking the shape. A `null` line in history.jsonl makes `resolvedModel(null)` throw and breaks every catalog read. Guard with `e && typeof e === "object"`.
- L2. Lasting loss of the user's own verified run (src/commands/agent/catalog-store.ts:211-216). history.jsonl rotates at 20 MB, and `MULTIX_HISTORY_FILE` can change, so the user's own run can drop out of the ledger. Editing their own project review then deletes `verified_usage` from the committed file for every teammate, not just locally. This follows the stated design but should be documented, or the reference should be kept on write and only hidden on read.
- L3. Rewrites redact teammates' text retroactively. Any project-store write re-scrubs every record with the stricter patterns, so a teammate's UUIDs or `token: ...` phrases become `[redacted]` in the committed file, and the diff shows unrelated edits. This is acceptable but worth one line in the PR.
- L4. Partial leak when a key is split by a space or newline (pre-existing). `sk-<24>\n<24>` leaves the second half visible. Word joiner and ZWSP splits are handled. A space-split prefix (`s k-<48>`) is still caught by the long-opaque rule.
- L5. Characters not folded or stripped (not bypasses for accidental pastes; noted for completeness): Cyrillic `ѕ`, U+2010/U+2212/en dash in place of `-`, URL-encoded `%2D`, upper-case `SK-`, `sk_`/`hf-` variants, and the visible-blank U+2800 (Braille blank) and U+1680 are kept. `Authorization: Token <letters only>` is kept because the value must contain a digit, and `Authorization: Digest ... response="<hex>"` is not covered. The PEM pattern is case-sensitive (`-----begin private key-----` is kept). None of these are typical accidental pastes. Homoglyph defence against prompt injection cannot be done by the scrubber anyway; the `user_content` notice is the control for that.
- L6. Text the stripping changes for legitimate use: `\p{Cf}` removes U+200C/U+200D (ZWNJ/ZWJ), which Persian and Indic orthography need and which emoji sequences use (`👨‍👩‍👧` becomes three emoji), and U+FE0F. Tab and CR are deleted rather than turned into a space (`a\tb` becomes `ab`, as on origin/dev). Vietnamese, precomposed or NFD, comes through intact. Consider mapping `\t` to a space.
- L7. False positives to note: CamelCase identifiers of 32+ chars with digits (`MiniMaxHailuo02StandardImageToVideo1080p`), 40-hex commit SHAs, fal request UUIDs, and prose such as `token: limit is 4096` / `secret: the trick` (key=value rule, pre-existing) are all redacted.

## Plan/issue follow-up
- Issue item (1): done apart from M1 (the AWS secret) and the M2 regression. ReDoS (H1/H2) must be fixed before merge.
- Issue item (2): done. Run references survive writes (`KEEP_RUNS`), and reads and edits are checked against the ledger. M3 is a hardening follow-up.
- Docs: the EN and VI pages match the behaviour (scrubbed on store and read, line breaks kept, project runs count only when they are in the local ledger). Also mention that tabs are removed, and that editing a project review whose run is not in the local ledger drops the run from the file (L2).

## Unresolved questions
- Is unbounded raw input before scrubbing a deliberate choice? If not, should an oversized raw field cause the record to be dropped or truncated on read?
- If `cwd == $HOME`, the project store resolves to the same file as the private store (`~/.multix/catalog-notes.json`) and is read twice. This predates the change and is out of scope; a separate issue may be warranted.
