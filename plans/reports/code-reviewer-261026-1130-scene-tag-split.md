# Code review: scene tag split fix (#347) and main-into-dev merge

Branch `claude/gracious-heisenberg-t89z7p`. Commits: `4f80a84` (merge of main into dev), `6932a54` (fix for #347).

## Scope
- Merge: README.md, docs-site commands.md (EN+VI), docs-site/src/pages/llms.txt.ts, src/commands/agent/models-command.ts, src/commands/agent/provider-group-keys.ts, src/commands/index.ts, src/capabilities/command-capabilities.ts
- Fix: src/commands/scene/script-parser.ts, src/commands/scene/scene-manifest.ts, tests/unit/commands/scene.test.ts, docs-site scene.md (EN+VI)
- How I checked: ran the new `chunkText`, the pre-fix `chunkText` (from 4f80a84) and a patched variant side by side on about 25 inputs, each checked with the new `partErrors`. The throwaway files lived under tests/ and are deleted; the working tree is clean.

## Gates (run on HEAD 6932a54)
- `npm run lint`: clean (555 files)
- `npm run typecheck`: clean
- `npm run build`: ok
- `npm test`: 112 files passed (8 skipped), 1976 tests passed (22 skipped)
- `npm run check:mcp`: ok, bundle clean
- `npm run catalog` in worker/: no diff, so the merged worker/src/cli-catalog.json matches the CLI

## Merge 4f80a84: nothing lost from either side
- README.md: both the `multix speech` and `multix scene` sections are kept, in order, with a blank line between them.
- commands.md EN and VI: both the Speech and the Scene rows are kept.
- llms.txt.ts: the resolved string is main's version plus dev's "Speech commands" line. The Scene line is present. No other line differs between the two sides.
- models-command.ts: dev's `TASK_BY_COMMAND`/`TASK_BY_LEAF` tables are dropped in favour of main's registry. Compared with the merge base, the only change dev made to them was `"speech generate": "speech"`. That mapping now sits in command-capabilities.ts as `fixed(["speech"], ["audio"])`, and `speech models` is in `UTILITY_COMMANDS`. Nothing else was lost.
- provider-group-keys.ts: both the `speech` (five keys in one row) and `scene` rows are present.
- index.ts: both imports and both `register*Commands(program)` calls are present (lines 48 and 50).
- skill/SKILL.md (merged automatically) mentions both speech and scene.

Verdict: the merge is correct.

## Findings for 6932a54, ranked by severity

### High 1: regression. A tag at the start of an over-limit word that has no spaces (CJK, URL) is now cut off on its own, and `plan` rejects a line it used to accept
src/commands/scene/script-parser.ts:239-245. In the token-by-token loop, a text token that does not fit calls `push()` before it is cut by code point. If the current part holds only the tag, that tag becomes its own part. Japanese and Chinese have no spaces, so a whole sentence is one "word". `--max-chars` can be as low as 20.

Input `[sighs]今日はとても疲れたので早く帰りたいと思います。`, limit 20:
- old: `["[sighs]今日はとても疲れたので早く", "帰りたいと思います。"]`, which passes partErrors.
- new: `["[sighs]", "今日はとても疲れたので早く帰りたいと思い", "ます。"]`, which fails with `part 1: has only tags and no spoken text`, so `plan` throws.

The same happens with `はい。[sighs]今日は…。` (part 2) and with `[whispers] https://example.com/<30 chars>`. The fix creates the very isolation it was meant to remove, and its commit message claims "the one remaining case (a tag plus its word over the limit)", which hides this one. No test covers it.

Suggested fix: do not push before cutting a text token by code point unless the current part already has spoken text, for example:
```ts
for (const t of word) {
  if (add(t.text)) continue;
  if (!t.tag && charCount(t.text) > maxChars) {   // cut in place, after any tags already in `current`
    for (const ch of Array.from(t.text)) addOrStart(ch);
    continue;
  }
  push();
  if (!t.space) addOrStart(t.text);
}
```
I checked this variant: both CJK inputs above give the old, valid two-part split. It also fills the current part before cutting a plain long word (for example `Read https://e…`). If that is not wanted, add a `!spoken(current tokens)` guard. Add a test with a tagged CJK sentence longer than the limit.

### Medium 2: new false positive. A part that is only punctuation is rejected with a message that names tags that are not there, and tagless CJK lines now fail `plan`
src/commands/scene/scene-manifest.ts:273 counts any part without `\p{L}\p{N}` as "has only tags". chunkText can still produce such parts. The full-width end `。` (plus closing quotes) is a separate token, so the token loop leaves it on its own when the part before it is exactly full.
- `今日はとても疲れたので早く帰りたいと思い。` (21 code points, no tag), limit 20: parts `["今日は…思い", "。"]`, giving `part 2: has only tags and no spoken text`. Before the fix, `plan` accepted this line. It did send a paid request for `。` alone.
- `aaaa bbbb ...... cccccccc`, limit 9: `"......"` is isolated and gets the same "only tags" message.
- `Done. 😀 [laughs] Ok sure fine.`, limit 10: `"😀 [laughs]"` is rejected, because an emoji is not `\p{L}`.

Rejecting a part with nothing to say is defensible. But the message is wrong when there are no tags, and the CJK case is avoidable. Either carry the last code point(s) of the cut run into the part with the trailing punctuation, or attach runs with no spoken text in the token loop the way `attachTags` does. Reword the message to "has no spoken text (only tags or punctuation)".

### Medium 3: `plan` rejects a line that could have been split validly (a tag can't fall back to the word before it)
script-parser.ts:239-245 together with `attachTags`. A mid-line tag is always bound to the word after it. When tag plus that word is over the limit, nothing tries putting the tag with the word before it.
- `ab. [sighs heavily and slowly] Fine.`, limit 30: gives `["ab.", "[sighs heavily and slowly]", "Fine."]` and is rejected. `["ab. [sighs heavily and slowly]", "Fine."]` (30 and 5) is valid.

Same root cause as finding 1. With realistic limits this is rare outside CJK, so it may be acceptable, but the docs claim at docs-site/src/content/docs/commands/scene.md:195 ("so it is never sent as a request of its own") holds only because `plan` refuses these lines. Say so in the docs, or try the word before the tag first.

### Low 4: a tag at the end of a line now causes a split in the middle of a sentence instead of at the sentence end
`attachTags` in `sentencesOf` merges a tag-only last sentence into the sentence before it.
- `Hello there my friend. <break time="1s"/>`, limit 30: new gives `["Hello there my", "friend. <break…/>"]`, old gave `["Hello there my friend.", "<break…/>"]`.

The new test asserts this, so it is deliberate. A `<break>` at the very end of a line has no effect. Dropping it, or allowing a trailing pause tag to stay in the last part, would keep sentence-end splits. This is a product call, not a bug.

### Low 5: a tag glued to the word after it can be separated from that word
- `x [laughs]yyyy…(30)`, limit 20: new gives `["x [laughs]", "yyyy…", …]`, old gave `["x", "[laughs]yyyy…", …]`.

No part is tag-only, so partErrors accepts it. But the tag now ends part 1 instead of shaping the word it was attached to. This comes from finding 1's loop (the tag is added to the current part, and then the long token is cut after a push).

## Checked and fine
- No characters dropped or duplicated: on every probe, the parts joined back equal the input when whitespace is ignored. `attachTags` keeps token order, including the trailing `splice`/`flat` path.
- Multiple tags, a tag between sentences (`Hello there my friend. [laughs] Yes.`), CJK `你好。[笑]再见。`, a tag glued to the word before it (`three.[laughs]`), a trailing tag after a long word, and leading tags all work when the limit leaves room.
- A single part that is only `[laughs]` stays valid (`parts.length > 1` guard). A tag-only line under the limit is never split.
- A tag longer than the limit is still one part over the limit and is reported as before.
- Tests: the new assertions check real outputs. There is no test for CJK or for a punctuation-only part (findings 1 and 2).

## Recommended actions
1. Fix the token loop so it does not push a part that holds only tags before cutting a text run by code point (finding 1). Add a CJK test with a leading tag.
2. Keep trailing punctuation with the part before it when cutting by code point, and reword the partErrors message (finding 2).
3. Optionally try the word before a tag when tag plus the next word does not fit (finding 3), or soften the doc claim.

## Unresolved questions
- Should a trailing tag-only sentence (a `<break>` at the end of a line) be allowed to cost a sentence-boundary split (finding 4)?
- Should a part that is only punctuation or emoji be rejected or merged? Either is defensible, but the current message is wrong.

Status: DONE_WITH_CONCERNS
Summary: The merge is correct and all gates pass. The #347 fix introduces a regression: a tag before an over-limit word with no spaces (CJK, URL) is now isolated and `plan` rejects the line, and partErrors wrongly reports parts that are only punctuation as "only tags".
