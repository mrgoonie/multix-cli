# Re-review: PR #120 `fix/mcp-worker-followups` (closes #103), head f612dcf

Reviewer context: isolated, read-only. Worktree `agent-aa3244d682d53f525`. HEAD f612dcf was confirmed through `.git/worktrees/.../logs/HEAD`, which shows the rebase onto `origin/main` and then the fix commit.

Bash was dead in this session, so nothing ran locally. Evidence comes from three places:
- source at HEAD;
- the check runs for f612dcf (6/6 success: CI on Node 20/22 × ubuntu/windows, MCP Worker, Documentation site);
- live Atlas schemas: seedance-2.5 t2v, wan-3.0-prime r2v, gemini-omni video-extend and midjourney v8.2 i2v.

Prior report: `code-reviewer-261011-2343-mcp-worker-followups-pr120.md`.

## Prior findings: verification

| ID | Status | Evidence |
|---|---|---|
| H1 no-schema fails open | **Fixed** | `atlascloud.ts:81-85` rejects every video call when there is no spec. Test `mcp-tools.test.ts:387-409` covers 3 variants (no duration, duration, duration + resolution), each asserting no POST. |
| M1 unrecognised length shapes | **Fixed (for length)** | `atlascloud-video-policy.ts`: <ul><li>A non-numeric seconds or frame field is rejected (`:194-198`).</li><li>Other names matching `/duration\|seconds\|frames/` are rejected (`:181-188`).</li><li>`anyOf`/`oneOf` is unwrapped only when there is a single non-null member (`:51-62`).</li><li>String durations (`"8s"`) are parsed (`:43-48`).</li><li>Frame counts are capped through the schema fps, assuming 1 fps when none is declared (`:143-168`).</li><li>The final check falls back to schema defaults (`:240-265`).</li></ul> Tests at `:411-533` assert no POST on each rejection. |
| M2 Cloudflare error mapping | **Fixed** | <ul><li>Rebased onto main.</li><li>`toFetchError(cause, origin, {provider:"Cloudflare"})` (`video-client.ts:99`).</li><li>A plain Workers `Error` becomes a transient `HttpError(0)` (unit test `:67-80`).</li><li>A header `TypeError` becomes a `ConfigError` without the token (`:82-93`).</li></ul> |
| L1 zero/negative length | **Fixed** | `snap` lower bound is `max(min ?? 1, 1)` (`policy.ts:94`). A default ≤ 0 uses the fallback (`:123`). Test at `:513-533`. |
| L2 redirect leaks ids | **Fixed** | The `HttpError` is rebuilt with the origin (`video-client.ts:89-92`). Test at `:95-105`. |
| L3 size fields | **Fixed** | `size`/`video_size`/`width`/`height` and non-string `resolution` defaults are checked (`policy.ts:267-298`). Tests at `:535-570`. |
| L4 CLI positional hint | **Fixed** | `/^(--\|\[)/` (`model-input.ts:237`). |
| L5 768p default | **Fixed** | The PR body states the allowlist widening for checked-in vars. |
| L6 test gaps | **Fixed** | All four listed cases now have tests. |

## Critical
None.

## High
None.

## Medium

### M1. Resolution and size defaults hidden behind an unreadable shape are skipped, not rejected
- **Where:** `worker/src/providers/atlascloud-video-policy.ts:240-242`, used at `:267-298`.
- **What happens:** `effective()` returns `body[field] ?? unwrap(prop)?.default`. `unwrap` returns `undefined` for an ambiguous `anyOf`/`oneOf` (two or more non-null members), and the outer `default` is dropped with it.
  - Example: `resolution: {anyOf:[{type:"string",enum:["720p","4k"]},{type:"string"}], default:"4k"}`.
  - With no caller resolution, the check `continue`s, the request is sent, and Atlas fills `4k`.
- **Property `$ref`s are not resolved either:** `parseModelSpec` resolves only the top-level `$ref` (`model-input.ts:47`). A `resolution: {$ref: ...}` whose default lives in components is skipped the same way, and so are `size`, `width` and `height`.
- **Length fields are not affected:** they fail closed, because an unreadable seconds or frame field is rejected by `isNumeric` in `lengthRequests`.
- **Why it matters:** this contradicts the file header ("Shapes this code cannot interpret fail closed") and the docs (`guides/mcp-server.md:194-195`, "An unreadable value is rejected"; the VI page says the same).
- **Likelihood:** low. No sampled catalog model uses these shapes; every sampled `resolution` is a flat string enum with a default. It is still the spend boundary, and the shape this PR explicitly set out to handle.
- **Fix:** in `effective`, when `spec.properties[field]` exists but `unwrap` fails, or the property has `$ref`, `allOf` or a nested member `default`, throw the same "would render at" error. Alternatively, fall back to the raw `prop.default` and reject when it is absent and the shape is ambiguous.
- **Test:** add a case for an ambiguous `anyOf` resolution with `default: "4k"` that asserts `isError` and no POST.

## Low

### L1. The length-like name check misses some plausible names
- **Where:** `policy.ts:38`, `:181-188`.
- **What is missed:** `/duration|seconds|frames/` does not match `frame_count`, `num_frame`, `frame_num`, `clip_length` or `video_len`. A numeric field with one of those names and a long default passes unchecked.
- **Risk:** none of these names appears in the sampled catalog.
- **Fix:** reject any unknown **numeric** property matching `/frame|second|duration|length/i`. Limiting it to numeric keeps it from tripping `return_last_frame` (boolean), which seedance-2.5 has, or the `first_frame`/`last_frame` image strings.

### L2. Size and dimension checks compare each side against the long side only
- **Where:** `policy.ts:289`, `:297`.
- **What happens:** `1920*1920`, or `width: 1920` with `height: 1920`, passes under a `1080p` allowlist. That is about 1.8× the pixels of 1080p.
- **Fix:** also cap the short side at the allowlist's short side, or compare pixel area.

### L3. The no-schema error points at a remedy that does not apply
- **Where:** `atlascloud.ts:83`; docs `mcp-server.md:167-168`.
- **What happens:** "operators can pin vetted models with MULTIX_MCP_ALLOWED_MODELS". Pinning does not bypass the no-schema rejection. It only removes the "model not in catalog" trigger.
- **Fix:** reword it to "only retry helps; pin models to avoid uncatalogued ids".

### L4. The rebuilt `HttpError` still carries the full gateway path in `cause`
- **Where:** `video-client.ts:91`.
- **What happens:** `cause.message` and `cause.rawUrl` hold the account and gateway ids. `cause` is non-enumerable, so `JSON.stringify` and the Worker logger (`redaction.ts`, which logs a built line) do not emit it. Only a future `console.error(err)` or cause-chain printer would.
- **Note:** informational. Dropping `{ cause }` here is an option.

## Edge cases checked (non-issues)
- **Workers-style and undici rejections:** both map to a transient `HttpError(0)` with the origin only. Timeout or abort keeps a clear message. The header fault maps to `ConfigError` with no value echoed.
- **Requested duration on an enum it does not match:** `checkConstraints` rejects it before submit. The cap holds because zod plus `mcp-server` cap the value before the adapter.
- **`-1` "smart" enums (wan-3.0, seedance-2.5):** excluded by `snap`. `"1080p-esr & 60fps"` is lower-cased, not in the allowlist, and rejected.
- **Frame model with an fps of `"auto"` or a non-numeric fps:** treated as worst case (1 fps), so it fails closed.
- **Live schemas sampled today:** seedance-2.5 t2v, wan-3.0-prime r2v, gemini-omni video-extend and midjourney i2v trip neither the length-like regex nor the non-numeric rejection, so there is no regression for these legitimate models.
- **Error texts:** they contain the model id, field names and allowlist only. No keys, account ids or gateway ids.
- **Tests:** every new rejection test asserts `calls.some(POST) === false`. The success tests assert the exact submitted body.

## Verdict
**Fix first (small).**
- M1 is a few-line change plus one test, and it makes the stated fail-closed guarantee true for resolution and size.
- L1–L4 can go to a follow-up issue.
- If the maintainer accepts M1 as theoretical (no catalog model uses the shape), the PR is otherwise mergeable.

## Unresolved Questions
- **Out-of-scope cost multipliers:** live schemas carry `generate_audio` (default true), `enable_thinking`, `thinking_level: high` and `motion`, and video-extend bills the input video as well. Is the spend guard meant to stay limited to length and resolution? If so, the docs should say that other price multipliers are not capped.
- **Output count:** should a video model with `num_outputs`/`num_videos` and a default above 1 also be capped or rejected?

Status: DONE_WITH_CONCERNS
Summary: Fix first (small). All prior findings (H1, M1, M2, L1–L6) verified fixed. New: Critical 0, High 0, Medium 1 (resolution/size defaults behind ambiguous anyOf or `$ref` shapes are skipped instead of rejected), Low 4.

---

## Round 3: head c198fbe (rebased on main f1213a1)

HEAD was confirmed via the worktree reflog (amend → c198fbe). All 6 check runs passed. Read-only; nothing ran locally.

| Item | Status | Evidence |
|---|---|---|
| M1 unreadable resolution/size shape | **Fixed** | `unwrap` returns undefined for `$ref`/`allOf` (`policy.ts:61`). `effective` (`:262-279`) handles each shape: <ul><li>body value: used;</li><li>readable prop: its default;</li><li>ambiguous union with an outer default: that default;</li><li>otherwise: reject.</li></ul> Tests at `mcp-tools.test.ts:573-581` (multi-member `anyOf`, `default:"4k"`) and `:598-631` (union with no default, `$ref`, `allOf`, `oneOf` width) each assert no POST. A caller-supplied resolution still works with a `$ref` schema (`:633-646`). |
| L1 length-like names | **Fixed** | `/frame\|second\|duration\|length\|_len$/i` (`:46`). It rejects a name when the prop is numeric, a numeric string, or unreadable (`:190-200`). Tests at `:480-491` (frame_count, num_frame, clip_length, video_len, numeric-string) assert no POST. The non-numeric pass-through is tested at `:510-524`. |
| L2 two-sided box | **Fixed** | `maxBox` returns long and short sides. `fits` checks both orientations for `size` and for the width/height pair (`:317-342`). Tests at `:568-572` cover `1920*1920` and a 1920/1920 pair. |
| L3 message | **Fixed** | `atlascloud.ts:83`: "...the request is not sent. Retry later, when the model schema is available." The EN and VI docs drop the pinning remedy (`:165-168`). |
| L4 cause | **Fixed** | The redirect `HttpError` is rebuilt without `cause` (`video-client.ts:89-93`). Other paths keep only the fetch rejection, which has no URL. |
| Docs: price multipliers | **Done** | Spelled out in EN `:201-206` and VI `:204-210` (`generate_audio`, `enable_thinking`/`thinking_level`, `motion`, output count). EN and VI match. |
| Rejection tests assert no submit | **Yes** | Every new rejection case checks `calls.some(POST) === false`. |

### False-positive / false-negative check against live schemas
I checked these live schemas:
- seedance-2.5 t2v;
- wan-3.0-prime r2v;
- gemini-omni video-extend;
- midjourney v8.2 i2v;
- wan-2.2 i2v;
- wan-2.2-turbo infinite i2v;
- vidu start-end 2.0;
- veo3.1 t2v;
- grok-imagine extend;
- kling v3.0 turbo i2v.

Results:
- **Only match:** `return_last_frame` (seedance), a boolean, so it is correctly ignored.
- **No `max_length`-style or `frame_rate` fields** on any sampled video model, so there is no false positive today.
- **Theoretical cost of the broader pattern:** a numeric `max_length`, `prompt_length` or `frame_rate` would now be rejected. That is fail-closed and the message is clear, so it is acceptable.
- **Every sampled length uses `duration`** (integer, enum or min/max), so there is no false negative.
- **Veo's top-level `allOf`** (1080p/4k requires duration 8) is a schema-level rule, not a property-level one, so the new `allOf` rejection does not hit it. With cap < 8 and resolution 1080p, Atlas would reject the request. That costs no money.

### New findings (Round 3)

**L5. A single-member union wrapping a `$ref` still slips through**
- **Where:** `policy.ts:59-71`.
- **What happens:** `unwrap` checks `$ref`/`allOf` only on the outer prop, not on the merged member.
  - `resolution: {anyOf:[{$ref:"#/components/schemas/Res"},{type:"null"}]}` with no outer default returns `{ $ref }`. `effective` then returns `undefined` and the check is skipped. A default that lives in the referenced component goes unchecked.
  - The same shape on an unknown length-like name (for example `clip_length`) gives `isNumeric` false, so it is not rejected.
  - Known seconds and frame fields are unaffected, because they need `isNumeric`.
- **Likelihood:** this is the pydantic `Optional[Enum]` shape. Pydantic normally puts the default on the outer level, which is handled. Not seen in the catalog.
- **Fix:** after merging, return `undefined` if the result has `$ref` or `allOf`, or call `unwrap` recursively. Add one test.

**L6. The "pass it explicitly" hint on unreadable size fields is a dead end**
- **Where:** `policy.ts:276-278`.
- **What happens:** the hint works for `resolution`. The tool has no `size`, `width` or `height` argument, so for those fields the caller cannot act on it. Cosmetic.

**Docs nit.** EN `:186` and VI `:189` say "numeric field", but an unreadable shape on a length-like name is rejected too. Cosmetic.

### Round 3 verdict
**Merge.** Every finding from rounds 1–2 is fixed and tested, CI is green, and the docs (EN and VI) match the code. L5 is a two-line hardening for a theoretical schema shape. It can go in now or as a follow-up issue; it does not block. L6 and the docs nit are cosmetic.

Status: DONE
Summary: Round 3 verdict is merge. Round 2's open items (Medium 1, Low 4) are all fixed. New: Critical 0, High 0, Medium 0, Low 2 (a nested `$ref` in a single-member union is skipped; a dead-end hint for size fields), plus one docs nit.
