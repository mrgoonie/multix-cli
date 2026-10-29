# Re-review: #436 review scrubber and run check (uncommitted diff vs HEAD)

Probes are in /tmp/claude-0/-workspace/eb7e4c35-d0fa-56dc-aa42-cccdb5b18f7a/scratchpad/probe/:
- perf.mjs: timing
- leak.mjs and leak-head.mjs: secret shapes, new code vs HEAD
- fp.mjs: false positives
- url.mjs: old vs new redactUrlsInText
- run.mjs: ledger run check
- nfkc.mjs: NFKC invisibles

The source was bundled with esbuild, and HEAD was extracted with `git archive`. No source files were modified.

## Verification
- `npx vitest run` on the 3 changed test files: 155 passed. `tests/unit/core`: 380 passed, 6 skipped.
- `npm run typecheck`: clean. `biome check` on the changed files: clean.

## Prior findings status
| ID | Status | Evidence |
|---|---|---|
| H1/H2 ReDoS | Fixed | 36 adversarial inputs of about 100k chars each (newlines, spaces, `a-` x60k, `a1-`, `?a`, `#a`, PEM headers, `authorization:`+spaces, e-mail dot/at chains, JWT dots, base64 runs, `sk-` runs, bidi, U+FDFA). Every one runs in 1-33 ms, and halving the input roughly halves the time, so the cost is linear. |
| M1 AWS secret | Fixed | Forms tested: `AWS_SECRET_ACCESS_KEY=<40>`, `aws_secret_access_key=` and a bare 40-char key with `/` are all `[redacted]`. A 40-hex commit SHA is kept. |
| M2 dash-grouped | Fixed for random keys | Random mixed-case 5x8 and 3x12 keys are redacted. `kling-v2-1-master-...-1080p` and `veo-3.0-...` are kept. A key whose dash-separated groups are all lower-case letters or digits still passes; see L1. |
| M3 one run, several reviews | **Not fixed** | It now depends on record order, and the attacker controls the order; see M1 below. |

## High

### H1. Regression: a secret `key=value` pair glued after another `word:` or `word=` pair is no longer redacted
In `reviews.ts`, the new key/value rule `(?<![\w-])([\w-]+)\s*[:=]\s*\S+` matches every `word:` or `word=` pair and consumes `\S+`. When the name is not a secret word, the callback returns the match unchanged, but the regex has already consumed the value. A `password=` or `token=` inside that value is therefore never tested. HEAD's `\b[\w-]*(password|...)\s*[:=]` started at each word boundary, so it caught these.

Repro (`leak.mjs` against `leak-head.mjs`, with the password built by concatenation):
```
curl -d user=bob&password=<PW>   new: unchanged            HEAD: curl -d user=bob&[redacted]
Note:password=<PW>               new: unchanged            HEAD: Note:[redacted]
params:token=<PW>                new: unchanged            HEAD: params:[redacted]
```
The form-body and `Note:` shapes are normal things to paste into a review.

Fix: do not consume the value when the name is not a secret. Two options:
- Use an `exec` loop that, for a non-secret name, sets `lastIndex` just past the name and separator.
- Match `([\w-]+)(\s*[:=]\s*)(\S+)` and, when the name is not a secret, return `name + sep + scrubPairs(value)`. This is still linear, because each character is re-entered only once more.

Add regression tests for `a=b&password=x` and `Note:password=x`.

## Medium

### M1. Prior M3 is still open: a teammate can take over the victim's run, and the victim's own edit then deletes it from the file
`ledgerRunCheck` gives a run to the first review in the file that references it. A project store is attacker-controlled. The victim's legitimate review already publishes `{history_id, ts}` in that store, so a teammate can copy it into a review placed earlier in the array. Confirmed with `run.mjs`:
```
A0 victim alone:                       r_victim:VERIFIED
A1 attacker copied ref, placed first:  r_attacker:VERIFIED r_victim:unverified
B malformed record placed first:       r_victim:unverified
E victim edits own review (no --job):  persisted r_attacker:has_run r_victim:no_run
```
- **A1:** the forged review shows "verified run" on the victim's machine, which is exactly what M3 described. The victim's own review loses its verification.
- **B:** `loadReview` calls `isLocalRun` before `cleanReview`. A record that is later dropped as malformed (here `score: 99`) still claims the run, so it blocks the victim's review even though it never appears.
- **E:** `carriedOver` re-reads with the order-dependent check. On the victim's own machine, it then permanently removes the victim's real run from the file.

The new test "lets one run back one review only, the first that claims it" locks this behaviour in.

Fix:
- When more than one loaded review references a run, treat all of them as unverified (no first-come winner). The attacker can then only deny verification, never take it.
- Claim a run only after `cleanReview` succeeds.
- In `carriedOver`, decide whether to keep the run from ledger membership alone, not from the uniqueness check.
- Optionally, make the save-time `verifiedUsage` in `catalog-command.ts` refuse a run already referenced by another review in the same scope (see L4).

### M2. `redact.ts` `QUERY_TAIL` change exposes value-less query and fragment segments in broken URLs
The new key class stops at `?` and `#`, so the match now starts at the *last* `?` or `#` before the `=`. Any earlier segment stays visible. `url.mjs` diffs 5 of 13 hand-written cases, plus about 7k of 200k fuzz inputs, for example:
```
path?a?b=c                      old: path?[redacted]        new: path?a?[redacted]
x#frag?sig=1                    old: x?[redacted]           new: x#frag?[redacted]
see https://x.y/a b?TOKEN?sig=1 -> new keeps "?TOKEN"
```
Well-formed URLs are unaffected, because `URL_IN_TEXT` and `redactUrl` handle them first. The gap is the fallback path for URLs broken by a space. That path is shared by `logger.ts`, `errors.ts`, `fetch-error.ts`, `error-classify.ts` and `agent-runtime.ts`, so the change reaches beyond reviews.

The bounded scheme `{0,31}` causes a second, harmless difference: a scheme longer than 32 chars now keeps its host and path but still redacts the query.

Linear fix that keeps the old semantics:
```ts
/[?#][^\s"'<>\\]*/g
```
with the callback `t => !t.startsWith("?[redacted]") && t.includes("=") ? "?[redacted]" : t`. The greedy match consumes the whole tail once.

## Low
- **L1. Model-id exemption is broad.** Any 32+ char run whose dash-separated parts are all lower-case words or `[a-z]?\d+[a-z]?` passes, so `deadbeef-12345678-cafebabe-87654321-facefeed` and `abcdefgh-12345678-ijklmnop-23456789` are kept. This is unlikely for random keys. Possible fix: also require at least one part that is not hex-like.
- **L2. Bare base64 secrets of lengths other than 40 leak.** Examples are a 44-char HMAC with a trailing `=` and an 88-char Azure storage key whose segments between `+` and `/` are under 32 chars (`leak.mjs`: `b64_44` and `azure88` are unchanged). HEAD has the same gap, so this is not a regression. Open a follow-up issue.
- **L3. Over-redaction in prose.**
  - `TOKEN: none needed` becomes `[redacted] needed`.
  - 64-hex sha256 values, 32-hex Fish voice ids (`src/providers/fish/models.ts`) and Leonardo model UUIDs (`DEFAULT_LEONARDO_MODEL_ID`) are redacted. That includes `--model-version <leonardo uuid>`, because `version` is scrubbed.
  - Of 772 id-like literals in `src/capabilities` and `src/providers`, 5 change; all of them are hex or UUID.
- **L4. Save and read disagree.** Saving a second review with the same `--job` prints "tied to run h_..." (no uniqueness check at save time), but every read shows it as unverified.
- **L5. Uniqueness is per scope.** A private review and a project review can share one run, and both read as verified in `readAll` (`run.mjs` D). This is probably acceptable for the user's own records, but it contradicts the docs wording "each run backs one review".
- **L6. Env-var names ending in `_KEY` without `api`, such as `FAL_KEY=` and `OPENAI_KEY=`, are not matched by `SECRET_NAME`.** fal keys are still caught by their UUID and hex shape. Short, unprefixed values after these names leak.
- **L7. Whole-store load cost is unbounded (pre-existing).** `readStore` has no file-size or record-count cap on read. A malicious 5000-record store at the 8x raw limit is about 260M chars. Scrubbing is linear at about 0.27 us/char, so roughly a minute per catalog command. This is out of scope here; open a follow-up issue.

Checked and fine: NFKC never produces a character that `INVISIBLE` would strip (brute force over all code points; maximum expansion 18x, which stays linear). The PEM, JWT, `Authorization`, GitHub fine-grained, Stripe and `ya29.` shapes are redacted, and a URL's userinfo is dropped by `redactUrl`.

## Recommended actions
1. Fix H1 and add regression tests.
2. Make run claims ambiguity-unverified, claim only after successful validation, and stop `carriedOver` from removing the run when the only problem is ambiguity (M1).
3. Restore the old `QUERY_TAIL` semantics with the linear callback form (M2).
4. Open follow-up issues for L2 and L7.

Status: DONE_WITH_CONCERNS
Summary: The ReDoS fixes and the AWS and dash-grouped key fixes hold up (linear on every adversarial input tried). The new key/value rule regresses redaction of glued `password=` and `token=` pairs. The run check is still exploitable through record order (prior M3 not fixed), and the `QUERY_TAIL` change exposes earlier query segments of broken URLs.
Merge verdict: CHANGES REQUIRED

---

# Round 3: commit 1dbcf5b (diff f96162b..1dbcf5b)

New and updated probes are in /tmp/claude-0/-workspace/eb7e4c35-d0fa-56dc-aa42-cccdb5b18f7a/scratchpad/probe/:
- perf.mjs, leak.mjs and url.mjs (rerun)
- walker.mjs: pair walker and prose
- dated.mjs: dated model ids
- run3.mjs: run check
- cap.mjs: store caps

No source files were modified and no processes were left running. I ran `npm run build`, which writes `dist/`; it was stale, and `dist/` is gitignored.

## Verification
- `npm run typecheck` and `biome check src tests`: clean.
- `vitest run tests/unit/catalog tests/unit/core tests/unit/commands/catalog-command.test.ts`: 702 passed, 6 skipped. Before `npm run build` the result was 701 passed, with 1 failure in the catalog smoke test, which was only the stale `dist/`.

## Status of round-2 findings
| ID | Status | Evidence |
|---|---|---|
| H1 glued pairs | **Fixed** | `user=bob&password=…`, `Note:password=…`, `params:token=…`, `a=b-token=…`, `a=xpassword=…`, `x:y:z:api_key=…` and `user=bob;password=…` are all redacted. Zero-width-split and fullwidth `password` are also redacted. The walker is linear: 100k-char inputs such as `key:`+spaces, `key:` x30k, `a: ` x40k and spaced names run in 4-17 ms. |
| M1 shared runs | **Fixed** | `run3.mjs` A1: an attacker's copy placed first now leaves both reviews unverified, in `readAll` and in `readStore("project")` alike. B: a malformed record placed first no longer burns the run (`r_victim:VERIFIED`). E: the victim's own edit keeps the run in the file (`r_victim:has_run`). E4: the victim can still remove the review. |
| M2 QUERY_TAIL | **Fixed** | 200k fuzz inputs give 0 diffs against HEAD. The only remaining differences are the 2 deliberate long-scheme cases (more than 32 chars: host and path are kept, the query is still redacted). `?` x100k and `?[redacted]` x9k + `=` run in about 5-9 ms. |
| L1 model-id exemption | Fixed, **but regressed real ids** | `deadbeef-12345678-…` and `abcdefgh-12345678-…` are now redacted. See R3-M1. |
| L4 save-time refusal | Fixed | C2: saving a project review with a run already used by a private review is refused. C3: re-saving the same review is allowed. |
| L5 cross-store uniqueness | Fixed | `readAll` runs `checkRuns` over both stores. |
| L6 `*key` names | Fixed (`FAL_KEY=`, `OPENAI_KEY=`) | Causes over-redaction; see R3-L1. |
| L7 store caps | Implemented, **but introduces a lock-out** | See R3-H1. |
| L2 / L3 | Tracked in #474 / accepted | — |

## R3-H1. Normal writes can push a store past 8 MiB; it then disappears from every read and cannot be edited or trimmed through the CLI
`writeStore` enforces `LIMITS.records`, but not `MAX_STORE_BYTES`. A store reaches the byte cap well before the record cap: at the text limits, one review is about 6.4 KB of pretty-printed JSON (more for multi-byte Vietnamese or CJK text). The next read then hits the cap and fails in three ways:
- A checked read skips the whole file. Everything disappears from view, not just the last write.
- `upsertReview` and `addNote` throw "trim it before writing to it".
- `removeRecord` cannot even find a record, because `locate` reads `unchecked`, which returns `empty()` for an over-size file. The user can recover only by hand-editing JSON.

Repro (`cap.mjs`, private store written only through the store API):
```
records 1308 bytes 8387146 visible 1308
upsert ok; bytes now 8392261 > cap: true          <- the write itself is accepted
visible after: 0                                  <- all 1309 reviews hidden
remove fails: No review with id r_…               <- cannot trim via the CLI
edit fails: … over the 8388608 … trim it before writing to it.
```

Fix:
- In `writeStore`, compute the serialized size and refuse the write that would exceed `MAX_STORE_BYTES`, the same way the record cap is refused.
- Let `locate` and `removeRecord` work on an over-cap file, so the documented "trim it" is possible from the CLI. For example, removal could read the file up to a higher hard ceiling.

Add a test that fills a store to just under the cap and asserts that the next upsert is refused, not hidden.

## R3-M1. Regression from the L1 fix: real dated model ids of 32+ chars are redacted in review text
`MODEL_ID_PART` now caps digit parts at `\d{1,4}`, so a 6- or 8-digit date suffix makes a model id fall through to the 32+ "opaque string" rule. All of the following are kept by the round-2 heuristic and by HEAD's prose behaviour for ids:
```
eleven-v3-conversational-20260930        (src/budget/pricing-catalog.ts)  -> [redacted]
voxtral-mini-transcribe-3-0-20261020                                      -> [redacted]
voxtral-small-24b-2507-stt-20260813                                       -> [redacted]
doubao-seedance-1-0-pro-fast-251015      (BytePlus naming)                -> [redacted]
```
"Model ids must stay" was an acceptance criterion. Possible fix: also accept a part that reads as a date, `^\d{6}$|^\d{8}$` with a plausible month (`YYMMDD` / `YYYYMMDD`, month 01-12). That still rejects `12345678`, and it keeps rejecting the hex-group keys from L1. Add these ids to the model-id regression test.

## Low
- **R3-L1. `key:` over-redaction in prose (from the L6 fix).** Every name ending in "key" now counts as a secret, together with the next word. Examples:
  - `Key: fast and cheap` -> `[redacted] and cheap`
  - `Primary key: offering id` -> `Primary [redacted] id`
  - `hotkey: Ctrl+K works` -> `[redacted] works`
  - `Monkey: no` -> `[redacted]`
  - `image-key=abc123` -> `[redacted]` (a Leonardo image id, which `history-store.ts` deliberately exempts)

  `Token: 3 credits` and `secret: there is none` behave the same, but those were already covered before. Suggestion: treat a bare `key` as secret only when it is joined to a prefix (`[_-]key$`, `apikey`) or when the value looks token-like (8+ chars containing a digit). Keep `FAL_KEY` and `*_API_KEY`.
- **R3-L2. Assignments other than `:` or `=` hide the value (pre-existing, present in HEAD).** `password => <PW>` and `password == <PW>` become `[redacted] <PW>`. The separator is one `[:=]`, and `\S+` then consumes the remaining operator characters, so the value survives. JSON-quoted pairs such as `{"password": "<PW>"}` still leak because of the closing quote after the name. Suggest a follow-up issue together with #474.
- **R3-L3. A copied reference blocks re-asserting your own run.** After a teammate copies the victim's run reference, the victim cannot re-save with `--job <own run>` (`run3.mjs` E2 is refused with "already backs project review r_attacker"). Editing without `--job` keeps the run, so this is only a minor usability issue, consistent with the "deny, never take" design. The error message could say that the other review may be a copy.

## Readers and modes
`readStore` has no callers outside `catalog-store.ts`, and every mode is used as intended:
- `write` under the lock in `upsertReview`, `addNote` and `updateLocated`;
- `unchecked` in `locate`, `refuseSharedRun` and `readAll`;
- `checked` only as the default.

I found no misuse.

Status: DONE_WITH_CONCERNS
Summary: All round-2 findings are fixed (glued pairs, run takeover, QUERY_TAIL, save-time and cross-store uniqueness), and scrubbing stays linear. Two regressions came in with the fixes: writes can grow a store past the 8 MiB read cap, which then hides all records and blocks edits and removal (R3-H1), and dated 32+ char model ids are now redacted (R3-M1).
Merge verdict: CHANGES REQUIRED

---

# Round 4: uncommitted changes on 0b685a9

New probes are in /tmp/claude-0/-workspace/eb7e4c35-d0fa-56dc-aa42-cccdb5b18f7a/scratchpad/probe/:
- trim.mjs: removing records from over-cap stores
- keyleak.mjs: key-name leaks, current code vs the original HEAD
- keyperf.mjs and dos.mjs: cost of `key:` chains

I also reran cap, dated, leak, walker, fp, perf and url. I made no source edits and left no processes running; the scratch store directories have been deleted. typecheck and biome are clean. After `npm run build`, `vitest run tests/unit/catalog tests/unit/core tests/unit/commands/catalog-command.test.ts` gives 716 passed and 6 skipped.

## Fix status
| ID | Status | Evidence |
|---|---|---|
| R3-H1 | **Fixed** | cap.mjs: the save that would push the store past 8 MiB is refused ("would be 8392261 bytes … remove records before saving more"). trim.mjs: on an 8.46 MB store, `rm` works and edits are refused. After 15 removals the store is under the cap and an edit saves again. `rm` also works on a store over the 5000-record cap. On a store over 64 MiB, `rm` is refused with "move it first", and `readAll` warns and skips the store. |
| `trim` reach | **No bypass** | `"trim"` is used only by `locate` (read-only, with no run check) and by `updateLocated(…, trimming=true)`, which only `removeRecord` passes. `note edit` calls `locate`, but its write goes through `replaceNote` → `"write"` mode, which still refuses an over-cap store. `writeStore(…, true)` is called only on a store that just had a record spliced out. |
| R3-M1 | **Fixed** | dated.mjs: none of the 24 dated ids, including `eleven-v3-conversational-20260930` and `doubao-seedance-1-0-pro-fast-251015`, are redacted. The `deadbeef-…` and `abcdefgh-12345678-…` keys are still redacted. Registry literals: 5/772 changed, all of them the accepted L3 cases. |
| R3-L1 | **Fixed for prose** | `Key: fast and cheap`, `Primary key: offering id`, `hotkey: Ctrl+K`, `Monkey: no` and `image-key=abc123` are kept. `api_key`, `API_KEY:`, `apikey`, `x-api-key`, `FAL_KEY`, `fal-key`, `OPENAI_KEY`, `AccessKey`, `SecretKey`, `privatekey` and `authkey` are redacted, and so is `Key: <16+ char token>`. **No leak compared with the original HEAD.** Compared with round 3, `key=<10-char password>`, `API Key: <10-char password>` and `my key: <password>` are kept again. HEAD kept those as well, so this is the accepted trade-off. |

## R4-H1. Regression from the R3-L1 fix: chained bare `key:` names make scrubbing quadratic, so a committed project store stalls every catalog command
`redactSecretPairs` now runs `PAIR_VALUE` (`\S+`) and then `TOKEN_LIKE` (`.*\d`) on the value of every bare `*key` name before deciding. When the value is rejected, `lastIndex` stays just after the name, so in `key:key:key:…` each of the n/4 names rescans the whole rest of the run. In round 3 a non-secret name skipped the value without reading it.

```
keyperf.mjs  "key:" chain   4000 chars 11 ms | 8000 34 ms | 16000 126 ms   (x4 per x2: quadratic)
             "hotkey:" / "monkey:a" chains: same shape
walker.mjs   "key:" x30000 (120k chars): 6926 ms   (round 3: 3.9 ms)
dos.mjs      project store, 100 reviews whose text is "key:" x4000 (1.6 MB, under every cap):
             readAll -> 12.4 s, 0 reviews kept
```
Each record is dropped after scrubbing because the text is over 2000 characters, but the scrubbing cost has already been paid. `RAW_FACTOR` allows 16000 raw characters per text field, so about 520 such records fit under the 8 MiB cap: roughly 60 s for every catalog command that reads the store. This is the same class as the original H1/H2 ReDoS.

Fix: decide from a bounded prefix of the value, and still consume the full value only when redacting. For example:
```ts
const PAIR_PEEK = /\S{1,64}/y;   // decision only
PAIR_PEEK.lastIndex = PAIR_NAME.lastIndex;
const peek = PAIR_PEEK.exec(text);
if (!peek || !secretPair(name, peek[0])) continue;
PAIR_VALUE.lastIndex = PAIR_NAME.lastIndex; PAIR_VALUE.exec(text);   // consume
```
`TOKEN_LIKE` only needs 16 characters. Add a timing guard test with `"key:".repeat(4000)` next to the existing linear-time tests.

Status: DONE_WITH_CONCERNS
Summary: R3-H1, R3-M1 and R3-L1 are fixed, the `trim` mode is reachable only from removal, and the key-name change leaks nothing compared with the original HEAD. However, the R3-L1 fix makes scrubbing quadratic on chained bare `key:` names (16k chars: 126 ms; a 1.6 MB committed store: 12.4 s per catalog read).
Merge verdict: CHANGES REQUIRED
