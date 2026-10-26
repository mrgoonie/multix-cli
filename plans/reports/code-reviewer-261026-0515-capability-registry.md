# Code review: 05fe25b capability registry (#293)

Reviewer: separate isolated review of commit 05fe25b (parent 5151636). I did not change any code.

## Verdict

The commit can merge after the two medium fixes below. I found no critical or high issues. The registry facts match fal's live OpenAPI schemas. `models --task speech --json` shows the fal speech routes, lists only verified ids and names the missing key. The worker bundle stays runtime-neutral. The project `.env` refuses `MULTIX_CACHE_DIR`.

## Findings

### Medium

**M1. A cache with a future `fetched_at` is treated as fresh forever.**
- Where: `src/commands/agent/model-discovery-cache.ts:114`
- Cause: `now() - Date.parse(fetched_at) < ttlMs` is true whenever the age is negative.
- Failure: The cache can be written while the clock is ahead (VM resume, bad NTP), or the file can be edited or synced from another machine. `--live` then reports `cached` and never refetches until `--refresh`. A removed or renamed model is never flagged `missing`.
- Reproduced: I set `fetched_at` to 2099-01-01. `fal: cached 2099-01-01T00:00:00Z` was served with no fetch.
- Fix: treat the cache as fresh only when `const age = now() - Date.parse(fetched_at); age >= 0 && age < ttlMs`. Optionally also reject a `fetched_at` more than a few minutes ahead of now in `readCache`. Add a test for this.

**M2. A truncated catalog is treated as complete, so verified models get a false `listed: false` / `status: "missing"`.**
- Where: `src/capabilities/model-views.ts:66-84` (the `read` map ignores `source.truncated`) and `src/capabilities/model-discovery.ts:90`.
- Cause: The fal reader stops after 5 pages of 100 entries. Any verified model past entry 500 is then reported as "removed or renamed; do not run it".
- Why it matters soon: live counts today are image-edit 435, image 228, image-to-video 227 and video-edit 223. Image-edit is close to the cap. The first verified model added for those tasks will flap to `missing` once the category grows. This is the same kind of untruthful claim #293 is meant to remove.
- Fix: for a truncated source, report verified models it does not contain as `listed: null`, not `false`. For example, store `truncated` next to the listing in the `read` map and use `found ? true : truncated ? null : false`. Alternatively, page fal with a filter on the verified ids. Add a unit test for this.

### Low

**L1. Cache entries are not validated per item.**
- Where: `model-discovery-cache.ts:51-66`
- Cause: Only `Array.isArray(models)` is checked.
- Failure: A hand-edited or partly corrupt cache entry `{model:42}` prints `? undefined 42  no multix command`, and the JSON output carries the same garbage.
- Fix: in `readCache`, drop entries whose `provider` or `model` is not a non-empty string, or reject the file.

**L2. Catalog strings are printed raw to the terminal.**
- Where: `src/commands/agent/models-command.ts:307,320`
- Cause: The provider's `model`, `status` and `name` values, and the cached error text, are printed without filtering.
- Failure: An escape sequence in upstream catalog data reaches the terminal. Reproduced with a cached status of `"active\u001b[31mRED"`.
- Risk: The sources are fal and OpenRouter over TLS, so the risk is low.
- Fix: strip C0/C1 control characters in text mode.

**L3. `--model <unverified-id> --live` without `--task` silently ignores `--live`.**
- Where: `models-command.ts:350-352`
- Cause: `liveTask` is undefined, so no catalog is read, yet the message tells the user to run `--task <task> --live`. Exit code is 0.
- Fix: raise a `ValidationError` ("--live with an unverified --model needs --task"), or read every supported task.

**L4. Model lookup ignores the provider.**
- Where: `findModelCapability(id)` in `models-command.ts:205,349` and `worker/src/jobs/catalog-view.ts:150`
- Cause: The lookup is by bare id. OpenRouter already lists `google/gemini-3.8-flash-tts`, the same id as the verified fal model.
- Failure: Today only the fal entry is verified, so this is harmless. Once a second provider gets a verified entry with the same id, `--model` and the MCP `model` filter return whichever comes first.
- Fix: honour `--provider` and the MCP/REST `group` parameter in model lookup.

**L5. `MULTIX_MODELS_TTL` can be set from a project `.env` and has no upper bound.**
- Where: `model-discovery-cache.ts:37`, `src/project-env-names.ts`
- Failure: A repository can set `999999999` and pin whatever catalog is cached; I confirmed the project `.env` accepts it. The cache dir cannot be redirected, so this cannot poison the cache, but it can freeze it.
- Also: an empty value (`MULTIX_MODELS_TTL=`) becomes TTL 0 (`Number("")` is 0) instead of the default.
- Fix: cap the TTL (for example at 7 days) and treat an empty string as unset.

**L6. Intentional row changes in default `multix models` output.**
These are corrections; I checked each one against the command's `--help`. Note them in the PR or changelog, because a consumer filtering `--task avatar-video` or `image-edit` loses rows:
- `avatar-video | heygen model-video` was removed. The command's help says "(not an avatar video)". It is now listed under video and image-to-video.
- `image-edit | leonardo variation` was removed. The command only fetches a result by id.
- `heygen run` lost `any_model: true`. It takes an operation, not a model id.
- `fal run` gained `async: true`.
- New rows: image-to-video for minimax, fal video, replicate, runway and heygen model-video; music and transcription for atlas audio; voice for elevenlabs voices design; speech for fal run.

Old row fields were never removed and only `model_scope`/`outputs`/`verified_models` were added. The JSON stays a plain array (inside the `--json` envelope `data`).

### Nit

- `heygen tts` shows `list: multix heygen avatars` for speech; it should point to `heygen voices`. This bug predates the commit (`lister` takes the first match, `models-command.ts:87`). Open a separate issue.
- In text mode `printRows` shows "provider default" for `heygen run`, which is misleading for an operation passthrough.
- A `model` filter in the MCP tool and REST route silently overrides `task`/`group` (`catalog-view.ts:178`). Document this or reject the combination.
- The eleven-v4 registry entry omits the `timestamps` output field that the fal schema returns when `timestamps=true`.
- `--ready --live` drops unverified catalog models that have no task command even when the provider key is set (`models-command.ts:199`). This is acceptable but undocumented.

## Judgement on the legacy schema test (`worker/test/job-tools.test.ts`)

The relaxed test keeps its protective intent:
- It still asserts the same tool set.
- Every non-`properties` key (`required`, `additionalProperties`, `type`, ...) is unchanged, so making a new field required fails it.
- Every legacy property's schema is unchanged.

The only thing it now allows is new optional properties, which a 2025 client never sends. That is the intended compatibility contract.

## What I verified

- `npm run build`, `npm run typecheck` and `npm run lint` are clean.
- Focused vitest runs pass:
  - `tests/unit/capabilities`, `models-command.test.ts`, `fal/commands.test.ts`: 58 tests.
  - `worker/test/job-tools.test.ts`, `rest-api.test.ts`: 29 tests.
  - `npm run check:mcp`: 21 files and 376 tests pass, and the bundle check is clean (no `node:*`, commander, execa or CLI code). `src/capabilities/*` has no `node:` imports.
- `npm run catalog` in `worker/` regenerates `cli-catalog.json` with no diff.
- Default `models --json` from a parent build compared with the new build: 69 rows became 77, with the differences listed in L6.
- `models --task speech --live` against the real catalogs (no keys):
  - The fal `run` row lists only the 5 verified ids and says "needs FAL_KEY".
  - Every verified id is `listed: true, status: active`.
  - The 30+ other fal and OpenRouter TTS models are marked `?` and unverified. OpenRouter speech is marked "no multix command".
  - The second call is served from the cache with source `cached`.
- `--live` across image, image-edit, image-to-video, transcription, video-edit and music: all sources are fresh or unsupported and none were truncated.
- The 5 verified fal models match `fal.ai/api/openapi/queue/openapi.json?endpoint_id=...`. I checked their fields, required fields (`text`; `prompt`; none for gemini → `required_any`), enum sizes (19 output formats, 30 Gemini voices, 38 MiniMax languages), defaults and max lengths.
- `fal run google/gemini-3.8-flash-tts --input '{"text":..,"voice":"Rachel"}' --dry-run --json` returns the three expected `LOG_WARNING`s in the envelope and does not submit.
- Cache handling:
  - A corrupt file is refetched.
  - A future `fetched_at` is served forever (M1).
  - A malformed item is rendered (L1).
  - Writes go to a temp file and then an atomic rename. The temp name includes the pid, so concurrent processes do not clobber each other.
- A project `.env` with `MULTIX_CACHE_DIR` is ignored with a warning, and the cache stays under `$HOME`.
- Worker REST and MCP: `task` is checked against a `z.enum`/`isTask` and returns 400 on bad values; `model` must match `MODEL_ID_RE`. The `usage` string only uses registry values. Key values are never returned. `models` stays in `EXCLUDED_COMMANDS`, so the job container never fetches catalogs.
- The README, SKILL.md and docs-site (EN and VI) claims match the code: cache path, TTL default, env exclusions, and the `listed: null` / `missing` semantics. One exception: none of them mention truncation (M2).

I removed the temporary worktree and the scratch cache.
