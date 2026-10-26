# Re-review: scene tag split fix (#347), commit 3977bac

PR #354, branch `claude/gracious-heisenberg-t89z7p`, base `dev`. Scope: `git diff 6932a54 3977bac` (script-parser.ts, scene-manifest.ts, scene.test.ts, docs-site scene.md EN+VI). Merge commits ignored.

## How I checked
- Ran three versions side by side: current `chunkText`, the one at 6932a54, and the pre-fix one at 4f80a84 (6932a54~1). Each output was checked with the current `partErrors`.
- Ran a fuzz of 40,000 random lines (English words, CJK runs, full-width stops, ASCII punctuation, tags of 7 to 26 chars, long words, URLs, limits 20 to 44). Each line was checked for dropped or duplicated characters, empty or untrimmed parts, and regressions against both older versions.
- Ran a set of targeted inputs.
- `tests/unit/commands/scene.test.ts`: 28/28 pass.
- The probe files have been deleted and the working tree is clean.

## Earlier findings: status
| # | Earlier finding | Status |
|---|---|---|
| H1 | Tag cut off before an over-limit unspaced word (CJK/URL) | **Partly fixed.** Fixed only when the glued text token is itself longer than the limit (the new `cut` path). It is still broken when the token fits the limit on its own but tag + token does not. See New-1. |
| M2 | Punctuation-only parts / wrong message | Message reworded (fine). CJK `。` after a full part fixed by the carry-over. Space-separated punctuation still gives avoidable bare parts. See New-3. The carry-over adds a new regression. See New-2. |
| M3 | Tag can't fall back to the word before it | Fixed by `joinBareParts` (`ab. [sighs heavily and slowly] Fine.` @30 is now valid). |
| L4 | Trailing `<break>` forces a mid-sentence split | Unchanged. It was a product call and the test asserts it. Acceptable. |
| L5 | Glued tag separated from its word | Fixed (`x [laughs]yyyy…` @20 gives `x [laughs]yyyyyyyyyy`). |

## Checked and fine
- **No characters dropped or duplicated.** Across all fuzz inputs, the joined parts match the input when whitespace is ignored. There was no exception, no empty part and no untrimmed part.
- **`joinBareParts` spans/indexOf are correct.** Every part is a trimmed, contiguous slice, and the slices come in order. The carry-over only moves a code point from the end of `current` to the front of the next part, so contiguity holds. `indexOf(p, at)` cannot match early, because only whitespace lies between `at` and the real start, and `p` begins with a non-space character. A join takes the exact text between the parts and is checked against the limit. After a splice, `i = min(i,j) - 1` re-checks the merged span. Each splice shrinks the array, so the loop ends.
- **The carry-over cannot leave an empty part.** The `kept.length > 1` guard keeps `current` non-empty, and `push()` drops parts that are only whitespace.
- **The carry-over and the limit.** `moved + piece` goes over the limit only when `piece` is a run of at least `maxChars` (20 or more) full-width stops with no letters. No valid split exists for that line anyway. Not a defect.

## New findings, ranked

### New-1 (High): regression vs dev still present. A tag before an unspaced run that fits the limit on its own is cut off, and `plan` rejects the line
src/commands/scene/script-parser.ts:289-292. In the word loop, a text token that fits the limit on its own but not after the tags already in `current` goes to `startText`. That `push()`es a `current` holding only the tag. `joinBareParts` cannot repair it, because tag + run is over the limit by construction. The new test only covers a run that is longer than the limit (24 chars at limit 20), which takes the `cut` path.

Failing inputs. All of them were valid on dev (4f80a84) and are rejected now:
- `[sighs]今日はとても疲れたので早く帰りたい。` @20 gives `["[sighs]", "今日はとても疲れたので早く帰りたい。"]`, which fails with `part 1: has no spoken text`. dev gave `["[sighs]今日はとても疲れたので早く", "帰りたい。"]`.
- `Fine. [sighs heavily and slowly]3.53.5Fine.` @30 gives `["Fine.", "[sighs heavily and slowly]", "3.53.5Fine."]`, rejected.
- `[sighs heavily and slowly]yyyyyyyyyyyyyyyyyyyyyyyyy` @31, rejected. dev split the run in place.

This is the most common shape for Japanese or Chinese text: a tag followed by a clause shorter than `max_chars`. About 2,000 of the 40,000 fuzz lines hit it.

Fix: cut in place when `current` has no spoken text yet:
```ts
else if (charCount(t.text) > maxChars || !hasSpokenText(current)) cut(t.text);
else startText(t.text);
```
Add a test with a tagged CJK clause whose length is between `limit - tagLength` and `limit`.

### New-2 (Medium): new regression in 3977bac. The carry-over can take the only spoken character, leaving the previous part with only tags
src/commands/scene/script-parser.ts:260-266. `carry` checks `kept.length > 1` and that the last character is spoken. It does not check that what stays behind still has spoken text. When `current` is `<tag><one char>` (or `<tag> <one char>`), moving that character leaves a part with only a tag.

- `[whispering softly]嘘。本当だよ。` @20 gives `["[whispering softly]", "嘘。本当だよ。"]`, which fails with `part 1: has no spoken text`. Both 6932a54 and dev gave the valid `["[whispering softly]嘘", "。本当だよ。"]`.
- `[sighs heavily and slowly] x。」。」.xとても疲れた ab` @28, rejected. 6932a54 accepted it.

Fix: carry only when the part left behind keeps spoken text, for example `const carry = !hasSpokenText(piece) && hasSpokenText(kept.slice(0, -1).join("")) && hasSpokenText(kept.at(-1) ?? "")`.

### New-3 (Medium): `plan` refuses lines with an easy valid split when punctuation stands alone as a word (French spacing, spaced ellipsis at the end of a line)
src/commands/scene/script-parser.ts:272-285, together with the new rule in `partErrors` (scene-manifest.ts:274). The carry-over only handles a full-width stop token inside a word. A punctuation-only *word* (one after a space) goes through `start(joined(word))` or a sentence-level `push()`. That leaves it bare whenever the line ends or the next sentence does not fit after it. `joinBareParts` only merges whole parts and never moves the last word of the previous part. dev accepted these lines, sending the lone mark as its own request. They now fail `plan`, even though a valid split exists:
- `Tu es vraiment sûrs ?` @20 gives `["Tu es vraiment sûrs", "?"]`, rejected. `["Tu es vraiment", "sûrs ?"]` is valid. French puts a space before `? ! : ;`.
- `I was going to say ...` @20 gives `["I was going to say", "..."]`, rejected. `["I was going to", "say ..."]` is valid.

Fix: when a word with no spoken text does not fit, start the new part with the previous word plus that word, the same way `startText` carries a character, provided the result fits. Or have `joinBareParts` move the last word of part `i-1` over when neither whole-part join fits. Add a test for French `?`.

### Informational (not defects)
- `joinBareParts` tries the previous part first. A cut-off leading audio tag (`[whispers]`) therefore ends the previous request instead of shaping the words after it. The docs describe this ("or with the word before it"). Joining forward rarely fits, because the tag was cut off precisely because tag + next word did not fit. Acceptable.
- A part that is only an emoji (`😀 [laughs]`) is still rejected, because emoji are not `\p{L}`. This is the same open product question as before.

## Unresolved questions
- Should a part that is only an emoji count as spoken text?

Status: DONE_WITH_CONCERNS
Summary: 3977bac fixes M3 and L5, the reworded message, and the CJK stop after a full part, and loses or duplicates no characters (joinBareParts is correct). The earlier High finding is only partly fixed: a tag before a CJK clause that fits the limit is still cut off and rejected, a regression vs dev. The new carry-over adds a second regression, and space-separated punctuation ("sûrs ?", "say ...") gives avoidable rejections.
