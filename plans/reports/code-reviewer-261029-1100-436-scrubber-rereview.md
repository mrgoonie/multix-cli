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
