# Code review: offline catalog cache honours the 7-day TTL ceiling (#349)

Scope: uncommitted diff vs origin/main (736218e). Files: src/commands/agent/model-discovery-cache.ts (+16/-4),
tests/unit/capabilities/model-discovery.test.ts (+46), README.md, docs-site EN+VI reference/for-ai-agents.md, skill/SKILL.md.

## Verdict
No blocking issues. Fix matches the issue's expected behaviour (past the ceiling -> `unavailable`, so model-views.ts
line 68 excludes the source and `listed` stays null instead of true). Online path is byte-for-byte unchanged
(cache-hit check, fetch, write, fresh result untouched; only the catch branch changed).

Checks run: vitest model-discovery.test.ts 15/15 pass; biome clean on both files; `tsc --noEmit` clean.

## Correctness
- Boundary: `age < MAX_MODELS_TTL_S * 1000` -> a copy exactly 7 days old is unavailable. Consistent with the
  online check `age < ttlMs` (exclusive). OK.
- Future-stamped: `age >= 0` rejects it, mirroring line 128-129. OK, and stricter than before (previously a
  future-stamped copy was served as stale offline). Note: even seconds of clock skew (NTP step back, cache dir shared
  between machines) now makes the offline fallback unavailable. Conservative and defensible; not a blocker.
- `NaN` age (no cache) -> falls through to unavailable, message has no suffix; existing "no cache" test still
  asserts the exact old error string. OK.
- `--refresh` offline with a copy younger than 7 days still returns stale. Unchanged. OK.
- Error text: adds only the cached `fetched_at` string; no path, key, URL query or prompt. Surfaces in --json
  `sources[].error` and the plain listing (models-command.ts:324). Not sensitive.

## Optional (non-blocking)
1. Misleading message for future-stamped copies: suffix says "is too old to use" when the copy is dated in the
   future. Suggest e.g. `age < 0 ? "is dated in the future" : "is too old to use"`, or neutral "is outside the
   7-day limit". The future-stamp test only checks `state`, so it would not catch the wording.
2. `fetched_at` is echoed raw from the file; readCache only requires `Date.parse` to succeed, and V8 parsing is
   lenient, so a hand-edited value is printed verbatim. Normalising with `new Date(Date.parse(...)).toISOString()`
   would keep output predictable. Local, user-owned file; cosmetic.
3. Test: no case at exactly `MAX_MODELS_TTL_S * 1000` (the stated boundary). The first new test jumps from
   ceiling-1s to ceiling-1s+30d. Adding `clock += 1_000` after the stale assertion and expecting unavailable would
   pin the exclusive boundary; the 30-day jump then becomes redundant.
4. Test assertion `lastDay` also could assert `error: "fetch failed"` (no suffix) to prove the suffix appears only
   when the copy is rejected. Minor.

## Docs
- README, EN, VI, SKILL.md: accurate ("up to 7 days old" / "tối đa 7 ngày" / "no cache or one older than 7 days").
  The ceiling is fixed at MAX_MODELS_TTL_S regardless of MULTIX_MODELS_TTL, and the docs do not imply otherwise. OK.
- EN reflow leaves a long line ("...up to 7 days). Offline, a stale copy up to 7 days") but that line was already
  long pre-diff; markdown renders fine.
- No other doc surface mentions the offline fallback (grep README/skill/docs-site).

## Scope / process
Diff is confined to the issue. Commit type should be `fix(models)` (publishes a patch; docs ride along).

Status: DONE
