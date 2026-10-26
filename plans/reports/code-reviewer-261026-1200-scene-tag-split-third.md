# Third review: scene tag split fix (#347), commit d6e8d86

PR #354, branch `claude/gracious-heisenberg-t89z7p`, base `dev`. Scope: the scene changes in `git diff 3977bac d6e8d86` (script-parser.ts, scene-manifest.ts, scene.test.ts). The other files in that range came in through the two merge commits and were not reviewed.

## How I checked
- Ran three versions side by side, each checked with the current `partErrors`: the current `chunkText`, the one at 3977bac, and the one on dev (4f80a84).
- Ran a fuzz of about 400k lines across 6 runs. The lines mixed English, Vietnamese, French with spaces before `? ! : ;`, Japanese/Chinese without spaces (including astral CJK such as 𠀋), ElevenLabs v3 audio tags and SSML breaks. Tag density was 5-25% per word, and the limits were 20, 25, 30, 40, 50, 60, 80, 100, 150, 200 and 300.
- Checked every output for:
  - parts that are not in-order, trimmed slices of the input;
  - characters dropped or duplicated between parts;
  - tags cut across parts;
  - parts over the limit (other than a single tag that is longer than the limit);
  - empty parts;
  - parts that start or end on half of a surrogate pair;
  - exceptions and hangs.
- For each rejected line, a brute-force splitter checked whether a valid split exists. It splits at spaces, and at any code point for CJK lines.
- Tried a candidate fix for F1 in a scratch copy and compared the fuzz statistics.
- `tests/unit/commands/scene.test.ts`: 28/28 pass. `npm run lint` and `npm run typecheck` are clean.
- All probe files (tests/zz-*.tmp.test.ts, src/commands/scene/zz-old.tmp.ts) are deleted. The working tree is clean.

## Checked and fine
- **Characters and tags.** No invariant failed across the whole fuzz. There were no dropped, duplicated or reordered characters, no cut tags, no empty or untrimmed parts, no part over the limit except a single tag longer than the limit, no split surrogate pairs, no exceptions and no hangs.
- **`attachTags`.** `joinBack` splices from the last spoken run to the end of `out` and appends the new tokens. Pending is always empty when it is called inside the loop, so order is kept. A space run is never `bare` (`!run[0]?.space`). In `wordsOf`, a punctuation-only word now joins the word before it, together with the space between them (`sûrs ?`, `say ...`, `wait —`). A tag joins the word after it, as before.
- **`maskTags` / `joinBareParts` index math.**
  - Each tag is replaced by a string of the same UTF-16 length (`m.length`), so the indices from `search` and from the `k` loop are valid on `prev`. Whitespace inside a tag is masked, so the move never starts inside a tag.
  - In the CJK branch, scanning down from the end picks the last spoken code point. Low surrogates and tag bodies are skipped, so `from` lands on the high surrogate of an astral character. `k > 0` keeps `kept` non-empty.
  - `kept` is trimmed and checked for spoken text. `moved` starts on a non-space character and is checked against the limit.
  - The two join branches shrink `spans`, and the move branch never moves `i` back, so the loop ends.
- **`chunkText`.** The new `cut` condition (no spoken text in `current` and no trailing space) fixes the tag before a CJK clause shorter than the limit. The `carry` guard fixes the case where the only spoken character was taken away. Every earlier failing input now gives the expected split.
- **`partErrors` sorted compare.** This is a multiset comparison, which is correct: `chunkText` never reorders, so the order between SSML and audio tags in `markupIn` should not matter. It cannot hide a dropped or duplicated tag.
- **No regression against 3977bac.** One flagged case in 320k lines was a sample of a dense line.
- **About 5% of fuzz lines that dev rejects are now valid.**

## Findings

### F1 (Medium): the new "move the last word" branch moves a word with no spoken text, so French lines with a tag after ` ?` are still rejected although a simple split exists
Location: src/commands/scene/script-parser.ts:247 and :262.

`masked.search(/\s\S*$/u)` takes the last space-separated chunk of the previous part. With French spacing that chunk is the bare `?` (or `:`, `;`, `!`). It can also be a trailing tag. The guard on line 262 checks only that `kept` has spoken text, not `moved`. So the split is applied, and the bare part just changes from `[tag]` to `? [tag]`. The `?` is also torn off its word, which is the problem this commit set out to fix.

Failing inputs. Each has one tag and is rejected, but a valid split exists. Each is also rejected on dev and on 3977bac, so this is a missed fix rather than a regression:
- `Tu es vraiment sûr ? [soupire profondément] Absolument pas.` @30 gives `["Tu es vraiment sûr", "? [soupire profondément]", "Absolument pas."]` (`part 2: has no spoken text`). Valid: `["Tu es vraiment", "sûr ? [soupire profondément]", "Absolument pas."]`.
- `Tu viens ce soir ? [rit doucement] Évidemment !` @25 gives `["Tu viens ce soir", "? [rit doucement]", "Évidemment !"]`.
- `On y va ? [chuchote doucement] Maintenant.` @25 and `Tu es là ? [soupire longuement] D'accord, très bien.` @25 fail the same way.

This only shows when tag + next word does not fit, so in practice at limits up to about 35 with ordinary tags.

Suggested fix: start the move at the last space after which spoken text remains.
```ts
let space = -1;
for (let k = masked.length - 1; k >= 0; k--)
  if (/\s/u.test(masked[k] ?? "") && hasSpokenText(prev.slice(k + 1))) { space = k; break; }
```
I tried this in a scratch copy:
- All four inputs above give the valid split.
- In 160k fuzz lines, no line got worse, and the invariants still held.
- Rejected lines that have a valid split went from 82 to 69 (French, seed 1).

Add a test with `sûr ? [tag]` at a limit where tag + next word does not fit.

### Informational (no change requested)
- **Dense lines rejected that dev accepted.** These were already rejected at 3977bac and are not new in d6e8d86. A word between two tags, at limits 20-30, is rejected, while dev accepted it by putting the first tag at the end of the previous part. Example: `... you never okay [laughs] well [sarcastically] unbelievable?` @25 gives `["you never okay", "[laughs] well", "[sarcastically]", "unbelievable?"]`, while dev gave `[..., "you never okay [laughs]", "well [sarcastically]", "unbelievable?"]`. The move branch refuses here because `kept` would be `[laughs]` alone, and it does not chain to the word before. This is the dense case the brief marks as known. In the fuzz it happened in about 1 line in 5,000 at 8-12% tag density, and never at limits of 40 or more.
- **A tag can end the part before its words.** In an unspaced line, a mid-line tag whose following clause does not fit ends the previous part instead of starting the next one. Example: `这是一个非常长的句子[sighs]我们需要把它分开来处理才行。` @20 gives `["这是一个非常长的句子[sighs]", "我们需要把它分开来处理才行。"]`, while dev gave `"...[sighs]我们需", "要把..."`. The line is valid, and a `[sighs]` falls at the same point in the joined audio. A delivery tag such as `[whispers]` would not shape the next part, though. This is the same trade-off the earlier reviews accepted (L5 / joining back first).
- **Glued English tag.** `[whispering softly]Unbelievable, honestly.` @30 now cuts inside the word (`...Unbelievabl` | `e, honestly.`), the same as dev, instead of being rejected. A cut word beats a rejection, and a tag glued to an English word is unusual.

## Unresolved questions
- None new. The emoji-only part question from the earlier review is still open.

Status: DONE_WITH_CONCERNS
Summary: d6e8d86 fixes all three findings from the second review. No defect was found in character, tag or index handling. One medium gap: the new move branch moves a bare `?`/tag instead of the last spoken word, so plausible French lines are still rejected at low limits.
