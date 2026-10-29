# Code review: plain-decimal parsing for capped counts and durations

Commit: 5f860a3 `fix(mcp): accept only plain decimals for capped counts and durations`
Files: worker/src/jobs/run-option-caps.ts (+7/-1), worker/test/run-argv-builder.test.ts (+10)

## Verdict

The fix closes the reported bypass. For any string the new regex accepts, `Number(raw) >= Number.parseInt(raw, 10)`,
because parseInt stops at the `.` and Number rounds monotonically. So the cap now never sees a value smaller
than the one a parseInt consumer sends. The other CLI parsers (Number, a `^\d+$` check, or the raw string passed
to the provider) read a plain decimal as the same value. One weaker gap remains: positivity is checked on the
fractional value, not on the integer the CLI uses (Medium). It is not a cap bypass. There are no blocking
issues.

Verification: `npx vitest run test/run-argv-builder.test.ts` in worker/ passed 67/67. `biome check` is clean on
both files. With the old code, both new cases would pass the cap (100e-2 -> 1, 60e-1 -> 6), so the tests do
prove the fix.

## 1. Parser parity per capped option

| Command(s) | Option | CLI parser | Parity with cap |
|---|---|---|---|
| gemini/minimax/openrouter/fal/byteplus generate, image-to-image | --num-images | `parseInt(..,10) \|\| 1` (gemini/minimax also clamp) | sound (Number >= parseInt) |
| leonardo generate, image-to-image | --num | `opts.num ? parseInt : default` | sound; "0.5" -> 0 sent (see M1) |
| openai generate | --num-images | `^\d+$` then parseInt (no trim) | CLI is stricter |
| replicate image | --num-outputs | `parsePositiveInt` = Number + isInteger | identical |
| fish voice-design | --count | Number + isFinite | identical |
| atlas image/video | --num-images, --duration | `Number(String(v).trim())` for integer/number schema fields; raw string for string fields | identical / provider parses a plain decimal |
| byteplus video, image-to-video, reference-to-video | --duration | parseInt | sound; "0.5" -> 0 (M1) |
| minimax generate-video | --duration | parseInt, then enum {6,10} | CLI is stricter |
| leonardo/openrouter image-to-video | --duration | `if (d) parseInt` | sound; "0.5" -> 0 sent (M1) |
| cloudflare generate-video | --duration | `^\d+$` (no trim) | CLI is stricter |
| gemini *-video | --duration | trim, strip trailing `s`, `^\d+$` | CLI is stricter ("8s" is refused by the cap, as it was before) |
| replicate video, runway video | --duration | Number + integer (runway: `^\d+$` on trim) | identical |
| heygen model-video | --duration | `numberInRange(Number, integer)` | identical |
| fal video | --duration | raw string passed to fal | the provider parses a plain decimal; whitespace is passed as given |

Inputs checked empirically against the regex (node):

- Rejected: `+5`, `0x10`, `Infinity`, `1e-7`, `1_0`, non-ASCII digits (`\d` without the `u` flag is ASCII only), `5.`, `.5`, `0`, `0.0`.
- Accepted: `" 5 "`, `" 5"`, `"5\n"` (trimmed for the test). Every consumer trims too: parseInt, Number and the Omni
  parser trim, and `^\d+$` without a trim fails closed. Fal receives the raw string, and its own
  int/float parse gives the same value.
- `007` is accepted as 7 by every parser.
- `4.99999999999999999999`: Number gives 5 and parseInt gives 4. The cap errs strict, which is safe.
- Very long digit strings round to Infinity or above the cap and are refused.

Duplicate option keys (`"num-images"` and `"--num-images"`) collapse into one Map entry, so only one value reaches
argv. None of the capped options is variadic or repeatable, and positionals come after `--`. No second path
around the cap was found.

## 2. Compatibility for valid callers

- JSON numbers: `scalar()` uses `String(n)`. Integers and ordinary decimals stringify as plain decimals and still
  pass. Existing tests already cover this: `num-images: 2`, `duration: 8`.
- `String(n)` uses exponent form only for `n >= 1e21` (over any cap, so refused anyway) or `n < 1e-6` (for example
  `1e-7`). Before this change `1e-7` passed and parseInt turned it into 1. It is now refused with "must be a positive
  number", which is inaccurate for a positive input. This is negligible.
- `"+5"` was accepted before (Number and parseInt both give 5) and is now refused. This is a minor
  fail-closed regression.
- Catalog defaults on the count path (`1`, `2`) are all plain decimals (checked against
  worker/src/cli-catalog.json), so defaulted runs are unaffected. The duration fallback still uses `Number()` on trusted catalog
  defaults (`5`, `6`, `8`), which is fine.

## Findings

### Medium

**M1. Positivity is checked on the fractional value, not on the integer the CLI uses.** `0 < n < 1`
(for example `"0.5"`) passes `positiveNumber`, but parseInt consumers send 0:
- leonardo `--num` sends `num_images: 0`
- leonardo and openrouter image-to-video send `duration: 0`
- byteplus video sends `duration: 0`

This is not a bypass of the upper bound. However, the duration cap rests on the assumption that the provider
receives a value inside (0, max]. If a provider reads 0 as "use the model default" or "auto" (Seedance uses -1
for auto), the run's length is set by the provider, not by the cap. I did not verify how any provider handles 0,
so this is plausible but unproven. Fix: require `n >= 1`, which matches the meaning of a count or of seconds:

```ts
if (!PLAIN_NUMBER_RE.test(raw.trim()) || n < 1)
```

Another option is `^\d+$` for counts, since every count consumer is integer-only.

### Low

- **L1.** The error message "must be a positive number" is now also shown for positive inputs that are refused
  for their form (`+5`, `1e-7`, `100e-2`). A message such as "must be a plain decimal number" would point callers
  to the fix.
- **L2.** Test gaps. Only the two exponent cases were added. The test does not pin:
  - acceptance of a padded value (`" 2 "`)
  - refusal of `0x10`, `Infinity` and `+5`
  - the decimal case (`"4.9"` accepted while the cap is above 4.9)
  - the M1 boundary (`"0.5"`)

  Two or three more rows in the existing `it.each` table would cover these.
- **L3.** The doc comment on `PLAIN_NUMBER_RE` says "the CLI reads counts and durations with parseInt". Several
  commands use Number, `^\d+$`, or pass the raw string (see the table). The invariant the regex guarantees is
  "every CLI parser reads at most the value the cap saw". That would be a more accurate comment.

## Scope / quality

- The change is minimal and stays within the one function. It adds no new abstraction and widens no types.
- `Number.isFinite` was dropped. That is fine: the regex excludes `Infinity` and `NaN`, and an overflow to Infinity is
  refused by the `>` cap comparison.

## Unresolved questions

- How do byteplus (Seedance), leonardo, openrouter and fal handle `duration: 0` or `num_images: 0`? Do they
  default, or refuse? This decides whether M1 is a cap gap or only a provider error.

Status: DONE_WITH_CONCERNS
