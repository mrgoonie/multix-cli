# Code review: #474 bare base64 secrets and pair forms in scrubText

Scope: uncommitted diff against HEAD 60afbdd. Files: `src/catalog/reviews.ts` (+74/-26), `tests/unit/catalog/reviews.test.ts` (+55), docs-site catalog.md (EN and VI).
Method: both versions (HEAD and the worktree) bundled with esbuild into the probe-474r scratch directory. Each probe ran on both and the outputs were compared. Fake keys were built by concatenation or by `crypto.randomBytes`, and none were printed.
Gates: the reviews tests pass (168/168), `biome check` reports no issues on the changed files, and `tsc --noEmit` is clean. The Worker does not import `reviews.ts`, so `check:mcp` is not needed.

## Linearity: no super-linear behaviour found
29 adversarial generators ran at 50k, 100k and 200k characters. Every one grew by about 2x per doubling, and the worst took 66 ms at 200k (`"A=".repeat`). The generators covered:
- quote, whitespace and separator chains (`a" :`, `a"` followed by 30 spaces, `token` with 100 spaces and `=`)
- unclosed and nested quoted values (`token: "x `, `hotkey: "hotkey: "`)
- `Key: '` with 70 non-token characters, `key="`, `key='"`, `"key":"`, and alternating quote styles
- `=>`, `==`, `x= =`, `token==`
- long word runs with and without a separator
- base64 runs, `ab/` chains, 44-character runs with `==`, `=` runs, `A=` chains, `+/` chains, and 44-character runs joined by `-`
- `password: "\n` chains

`PAIR_NAME` can start only at the start of a run (TOKEN_START), and any backtracking stays inside that run. The quoted peek is capped at 64 characters, and a full value scan always advances `last`. The base64 pattern is lookbehind-anchored and consumes each run and its padding exactly once.

## High

### H1. About 1–2% of real 32- and 64-byte base64 keys still leak, through the "path" exclusion
`looksLikeBase64Secret` rejects a run when any segment split on `+` or `/` is 3 or more lower-case letters. That check includes the first and last segments, and splits on `+`, which no path uses. Random keys trip it often. Repro (`probe-474r/rand.mjs` and `rand2.mjs`, 200k `crypto.randomBytes` keys each, input `use <key> now`):
- 32-byte keys (44 characters, `=`): 2232 of 200000 not fully redacted (1.1%). 2116 hit the lower-case segment rule and 116 have no digit.
- 64-byte keys (88 characters, `==`, the Azure storage shape): 3325 of 200000 (1.7%), all from the lower-case segment rule.
- 40-character AWS shape: about 1.2%. This rate predates the PR.
Masked examples of output (x = key character, `[xxxxxxxx]` = a segment the long-opaque step redacted alone):
`xxx/xxxxxxxxxxxxxxxxxx+xxxxxxxxxxxxxxxxxxxx= ` and `[xxxxxxxx]/x/xxx/xxxxxxxxxxxxxxxxxxxxxxxxxxx==`. Either the whole key leaks, or most of it.
Padding is decisive evidence: a path never ends in `=`/`==` and almost never contains `+`. Suggested fix: run the path test only for unpadded runs and only on `/`-separated **interior** segments, for example `padding.length === 0 && body.split("/").slice(1, -1).some(p => /^[a-z]{3,}$/.test(p))`. With that rule, padded keys always redact and the H-L3 path false positive still needs its own guard. Add a seeded randomized test, for example 2,000 keys from a fixed PRNG, that asserts every key is redacted.

## Medium

### M1. An escaped quote inside a JSON value leaks the rest of the secret and leaves broken JSON
`QUOTED_VALUE = /[^"\n]*/y` stops at `\"`.
Repro: `{"password": "abc\"def123rest"}` becomes `{"[redacted]"def123rest"}`. The tail of the password survives and the quotes no longer balance. HEAD did not redact this pair at all, so this is not a regression, but it falls inside the form the PR claims to cover. Fix: `/(?:[^"\\\n]|\\.)*/y`, and the same for `'`. It stays linear because there is no nested quantifier ambiguity.

### M2. Quoted name with an unquoted value: the output has an unbalanced quote and loses its structure
The name's closing quote is inside `m[0]` and gets dropped, then `\S+` swallows the `,`/`}` after the value.
Repros:
- `{"token": null, "x": 1}` becomes `{"[redacted] "x": 1}`
- `{"token": 12345}` becomes `{"[redacted]`
- `{'token': "abc"}` (mixed quotes) becomes `{'[redacted]"}`
HEAD left these unchanged, because a quote could not follow the name. The brief names unbalanced quotes as a concern. Fix: emit `[redacted]${m[2]}` when the name is quoted and the value is not, and stop an unquoted value at `,`, `}` or `]` when the name was quoted.

### M3. Quoted prose under a name ending in "key" is now redacted (false-positive regression)
`TOKEN_LIKE` (16 or more characters with a digit and a letter) and the 64-character peek rule now see the whole quoted value, spaces included, so any sentence with a digit counts as a token:
- `hotkey: "Ctrl+Shift+4 to capture"` becomes `[redacted]` (HEAD kept it; the unquoted form `hotkey: Ctrl+K` is in the keep list)
- `{"key": "Use 2 passes for best results at 1080p"}` becomes `{"[redacted]"}`
- `"monkey": "We saw 3 of them at the zoo"` becomes `"[redacted]"`
- `"key": "<any 64+ character description>"` becomes `"[redacted]"`, even with no digit
Fix: for quoted values under the plain-`key` branch, apply `TOKEN_LIKE` and the 64-character rule only when the value contains no whitespace. `SECRET_NAME` and `KEY_NAME` keep accepting any value.

## Low

- **L1. Escaped JSON (stringified logs) still leaks completely.** `{\"password\": \"hunter 2x\"}` comes out unchanged. `(["']?)` cannot step over `\"`. This predates the PR, but it is the most common way JSON gets pasted from logs. Allow an optional `\\?` before each quote in `PAIR_NAME`, or open a follow-up issue.
- **L2. Apostrophe or backtick inside a quoted value leaks the tail.**
  - `'password': 'it's 2x secret'` becomes `'[redacted]'s 2x secret'`.
  - `"token": \`two words\`` becomes `"[redacted] words\``. Backtick quotes are not supported.
- **L3. Base64 false positive on capitalised paths.** `/Users/Ann/Desktop/Shots2026/Final/Take12ABC` (44 characters with `/`) becomes `[redacted]`. The 40-character window already had this risk; the new windows triple it. `Ab1+Cd2+…+Uv1=` style tag lists are redacted too. The path guard should look at `/`-joined capitalised words, or accept the cost and document it.
- **L4. Over-redaction from `=>` and `==` and from unclosed quotes.**
  - `items.map(token => token.trim())` becomes `items.map([redacted]` (HEAD: `items.map([redacted] token.trim())`).
  - `if (token == null) return;` becomes `if ([redacted] return;`.
  - `Price per token: 'about $0.002, I would …` removes the rest of the line (HEAD removed one word).
  These lose data but do not leak. Consider stopping an unclosed quoted value at the peek length, or at whitespace when no closing quote is within N characters.
- **L5. A name containing a space is missed.** `{"api key": "hunter2x"}` is kept: only `key` is captured, and without a digit `TOKEN_LIKE` does not fire. Not a regression.
- **L6.** A 32-byte key with no digit (about 0.06%) is not redacted, because the digit requirement applies even when the run is padded.

## Regressions of the cases #488 covered
None found. Every existing keep and redact test passes. Old and new behaviour match on fal paths, model ids, hex SHAs, URLs (`?[redacted]`), `a => b`, `x == y`, `ratio=16:9`, `seed==42` and `max_tokens: 4096`, and `AccountKey=…==;` is still redacted.

## Tests
The added tests are behavioural, not placeholders. They lack:
- a randomized-key property test, which would have caught H1
- cases for escaped quotes and for a quoted name with an unquoted value (M1, M2)
- a negative case for quoted prose under a name ending in `key` (M3)

## Docs
The EN and VI text matches the implementation. The VI wording is accurate.

Status: DONE_WITH_CONCERNS
Summary: All new patterns stay linear (verified 50k to 200k) and #488 behaviour is preserved. However, about 1–2% of real 32- and 64-byte base64 keys still leak through the lower-case-segment path rule. Quoted forms also leak after escaped quotes, emit unbalanced quotes for a quoted name with an unquoted value, and newly redact quoted prose under "key" names.
Merge verdict: CHANGES REQUIRED

## Round 2 (author fixes, uncommitted diff)
Gates: the reviews tests pass (193/193), biome is clean and `tsc --noEmit` is clean. I re-bundled `new.mjs` and reran `rand`, `rand2`, `func`, `time`, plus the new probes `r2.mjs` and `t2.mjs`.

**Linear time:** all 35 generators scale at about 2x per doubling, with a maximum of 63 ms at 200k. The new generators cover escape runs `\\…`/`\"…`, `token => f(` chains, `token == null` chains, `=> a.a.a…` and `"token": nul,` chains.

| Finding | Result |
|---|---|
| H1 | **Fixed.** 0 of 200k padded 32-byte keys and 0 of 200k padded 64-byte keys leak. With the padding stripped, 51 (32-byte) and 44 (64-byte) of 100k still leak (about 0.05%). |
| M1 | **Fixed.** `{"password": "abc\"def123rest"}` becomes `{"password": "[redacted]"}`. |
| M2 | **Fixed.** `{"token": null, "x": 1}` becomes `{"token": "[redacted]", "x": 1}`. `{"token": 12345}`, compact JSON and mixed quotes all stay balanced. |
| M3 | **Fixed.** The `hotkey`, `key` and `monkey` prose cases are kept. `"Key": "abcd1234efgh5678"` is still redacted. |
| L4 | **Fixed for code.** `items.map(token => token.trim())` and `if (token == null) return;` are kept. However, the code skip opens a new leak (R2-M1 below). |

### R2-M1 (Medium): the code skip after `=>`/`==` lets real secrets through
`CODE_VALUE` treats `[\w.$]*[()]` and a leading `=` as code. Secrets in exactly the forms #474 adds pass through unredacted:
- `password => Hunter2(x)` is kept as is
- `token == Abc.def(1)xyz9` is kept
- `token => $ecret)99` is kept
- `secret == =s3cr3tVal` is kept
- `password => this.is.my.pw()` is kept

The same values after `=` or `:` are still redacted. HEAD also leaked `=>`/`==` values (it consumed only `>`/`=`), so this is not a regression against HEAD. Still, these are the target forms, and the round-1 diff redacted them. Over-redacting a code snippet in a review costs little; leaking a secret into a committed store does not.

Suggested fix: treat a value as code only when it is a bare keyword (`null`, `true`, …) or an identifier or member chain directly followed by `(`. That chain must contain no digit and cannot start with a capital letter followed by mixed case and digits, which the `TOKEN_LIKE` shape catches. Pattern: `^[a-z_$][A-Za-z_$]*(?:\.[A-Za-z_$]+)*\(`. Drop the leading `=` alternative and the bare `)` match. Add the four repros above as must-redact tests.

`token == f( password=hunter2x` and `token => ( api_key: abc123` still redact the following secret, because the walker resumes at the value. No leak there.

### R2-L1 (Low): base64 runs swallow a URL's host suffix (the case the author reported)
`https://host.example.com/u/<38-character id>` becomes `https://host.example.[redacted]`. The run `com/u/<id>` is 43 characters, contains `/`, has fewer than 3 slashes, and so counts as a secret. The id alone would have been redacted by the long-opaque step anyway. The only extra loss is `com/u/`.

Suggested fix: add `.` to the lookbehind, `(?<![A-Za-z0-9+\/.])`. A real key glued after a `.` is rare.

The related `/Users/Ann/Desktop/Shots2026/Final/Take12ABC` false positive (L3) remains; it is capitalised and has no lower-case interior segment. Lower-case paths are kept.

### Still open, accepted or minor
- L1: escaped JSON `{\"password\": \"…\"}` still leaks completely. This predates the PR; suggest a follow-up issue.
- L2: an apostrophe inside a single-quoted value leaks its tail: `'token': 'it's 2x'` becomes `'token': '[redacted]'s 2x'`.
- New and cosmetic: `"password": "trail\` becomes `"password": "[redacted]"\`, leaving a stray backslash. Nothing leaks.
- The decisions to keep the quoted name and drop the digit rule were accepted by the coordinator; I am not challenging them.

Status: DONE_WITH_CONCERNS
Summary: H1, M1, M2 and M3 are verified fixed, and every pattern stays linear. The new code skip after `=>`/`==` leaks secrets that contain parentheses or start with `=`, such as `password => Hunter2(x)` (R2-M1). The URL host-suffix loss is a low-severity cosmetic issue.
Merge verdict: CHANGES REQUIRED
