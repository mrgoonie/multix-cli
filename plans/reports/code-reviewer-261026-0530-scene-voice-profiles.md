# Code review: `multix scene` (commit 528f418, issue #297)

## Scope
- Files: src/commands/scene/{index,scene-manifest,scene-render,script-parser,speech-adapters,voice-profile}.ts, src/providers/gemini/generators/speech.ts, worker/src/jobs/cli-command-policy.ts, worker/src/cli-catalog.json, tests/unit/commands/scene.test.ts, tests/smoke/scene.test.ts
- LOC: about 2.9k added
- Checks run: `npm run build` ok, `npm run typecheck` ok, `npm run lint` ok (493 files clean), scene unit and smoke tests 14/14 pass, all unit tests 1419 pass, `npm run check:mcp` 375 pass and the bundle is clean.
- Probes: I wrote a throwaway vitest probe and ran the CLI by hand against `dist/cli.js` with the fake-fetch preload. No real provider was called and no source file was edited.

## Overall
The happy path, preflight ordering, request shapes and the Gemini refactor are correct. The DoD fixture holds when lines are only edited, not inserted. There are still defects in four areas:
- Export trusts the manifest on disk.
- Receipt accounting is wrong whenever takes are shared between lines.
- Take ids collide when a provider returns identical bytes.
- The sentence chunker drops text without any error.

## Critical
None.

## High

### H1. `scene export` can write files outside `--out` when the manifest is tampered with (VERIFIED)
- Where: `src/commands/scene/index.ts:440-460` builds the destination; `index.ts:496-501` copies the files; `scene-manifest.ts:119-127` (`readManifest`) checks only `schema`.
- How it fails: the destination is `` `${s.id}/${rest}_${line.speaker}${ext}` ``, and every part of it comes straight from `multix-scene.json` without validation. `take.path`, the source, is also unvalidated. I set `scenes[0].id = "../../escaped"` and ran `scene export --out <P>/out`. It wrote `<P>/../escaped/001_hiro.mp3`.
- Why it matters: `speaker` can also contain `/`, and the extension comes from `take.path`. Anyone who ships a scene project, for example through a shared git repo, can therefore write a file whose content they control (any file in the project with a matching sha256) to any path with any extension when the victim runs `scene export`. `approve`, `reject` and `status` also work on the unvalidated manifest. `replan` reads `s.script` from any path it names.
- Fix:
  - Validate on read in `readManifest`: scene id against `SCENE_ID`, speaker against the profile `ID` regex, and line id against `^<scene>/\d{3}(\.\d+)?$`.
  - Require `take.path` to resolve inside `<project>/takes/`.
  - In export, assert `path.resolve(outDir, stem.file).startsWith(outDir + path.sep)`.

### H2. Spend and character receipts are counted twice when a take is shared between lines (VERIFIED)
- Where: `scene-manifest.ts:286-291` attaches takes by line id and by cache key; `scene-manifest.ts:401-407` (`summarize`) adds up every take on every line.
- How it fails: plan carries a line's old takes by line id (a position) and also brings in every take with the same cache key from any line. Inserting one line at the top of a 3-line scene means each later line gets its own take plus its old neighbour's. The probe showed per-scene `cost_usd` going from 3 to 6, `characters_rendered` from 14 to 28 and `takes` from 3 to 6, although only 3 requests were ever paid for. Identical lines (same speaker and text with no context, such as "Ừ.") also share takes across lines and scenes, and each copy is counted. This breaks the DoD item "accurate receipts".
- Fix: deduplicate by `take.path` or `take.sha256` across the whole manifest in `summarize`. Better, record receipts once per request (a top-level `takes` table keyed by path, referenced from lines). Stop carrying takes by position when the cache key differs; keep at most the selected or approved history for that line.

## Medium

### M1. `--new-take` with identical bytes overwrites the existing take, losing its approval and its receipt (VERIFIED)
- Where: `scene-render.ts:469-470` (`id = t_<sha12 of bytes>`) and `scene-render.ts:527-529` (replace on id match).
- How it fails: a deterministic provider (ElevenLabs with `settings.seed`, or any cache) returns the same bytes. The new take gets the same id and replaces the old object. The probe showed the approved take become `candidate`, the line go from approved to rendered, and the previous take's `cost_usd` (0.5) replaced by the new receipt (null). The second request was paid for but leaves no separate receipt. The unit test at `scene.test.ts:260` changes the bytes on purpose and so never hits this.
- Fix: make take ids unique per request (digest plus timestamp or counter). If the bytes match an existing take, keep that take's status and append the new usage to a receipts list instead of replacing it.

### M2. The chunker drops text without any error (VERIFIED)
- Where: `script-parser.ts:96`. The regex is `/[^.!?…。！？]+(?:[.!?…。！？]+["'”’)\]]*|$)\s*/gu`, used with `match`.
- How it fails: punctuation that does not follow a non-punctuation run is never matched, and `String.match` skips it.
  - `chunkText("…Anh đến muộn rồi. …", 25)` returned `["Anh đến muộn rồi.", ...]`; the leading "…" is gone.
  - `'He said "Stop!". Then she left…'` lost the ".".
  - The model is paid to read the altered text, and the manifest stores the altered text. This happens only when a line goes over `max_chars` or the model limit. Breaking up a `<break time="1.5s"/>` tag is a related risk.
- Fix: tokenise so that the concatenated parts equal the input, for example with `/[^.!?…。！？]*[.!?…。！？]+["'”’)\]]*\s*|[^.!?…。！？]+$/gu`. Then assert `parts.join("")` (up to whitespace) equals `text`, and throw otherwise. Do not split inside `<...>` or `[...]`.

### M3. Concurrent commands lose manifest updates and paid takes (by code reading, not executed)
- Where: `scene-manifest.ts:140-147` (atomic rename, but no lock) and `scene-render.ts:545` (writes the whole manifest after each line).
- How it fails: running `scene render --scene s01` and `--scene s02` in parallel is a natural way to speed things up, as is running `approve` while a render is going. Each process holds a full in-memory copy and writes it whole, so the last writer wins. Paid takes from the other process disappear from the manifest; their files stay orphaned in `takes/`. The next render pays for them again.
- Fix: take an exclusive lock file (`multix-scene.json.lock` with O_EXCL and a stale-PID check) for the length of any command that writes. Alternatively, re-read and merge per line before each write.

### M4. A take that fails verification still counts as rendered and is exported
- Where: `scene-render.ts:490-493` sets `verification.ok`, `scene-manifest.ts:193-199` (`lineStatus`) and `index.ts:447-450` (export).
- How it fails: an empty body, or an error JSON returned with status 200, still becomes the selected take. The line becomes `rendered`, the scene is `complete`, and export copies the file. `UNREADABLE_MEDIA` from ffprobe does not even set `ok` to false.
- Fix:
  - Do not select a take whose `verification.ok` is false.
  - Count `UNREADABLE_MEDIA` as not ok.
  - Make export refuse such takes unless `--allow-missing` is passed.

### M5. `scene plan <subset>` silently drops all other scenes, with their approvals and receipts
- Where: `index.ts:249-253` and `scene-manifest.ts:327`.
- How it fails: `scene plan s04.txt` on an existing project rebuilds the manifest from s04 alone. s01 to s03, with their takes, approvals and cost receipts, are removed. `removed` is reported, but the manifest is written anyway. Re-adding those scenes later finds no previous takes, because they are no longer in `previous`, so they are paid for again. The help text says "all of them", but this is a destructive default for a command described as "local, no cost".
- Fix: merge the named scripts into the existing scene list (`--replace` for today's behaviour), or refuse to drop scenes that have takes unless `--prune` is passed.

### M6. Commit ships a `feat` without docs
- AGENTS.md requires `README.md`, docs-site (English and Vietnamese) and `skill/SKILL.md` for user-facing commands. None are in the commit.
- `docs-site/src/content/docs/{,vi/}commands/scene.md` exist untracked in the worktree. A `feat` merge publishes to npm.

## Low
- **L1. `invalidated` overstates changes after an insertion (VERIFIED).** At `scene-manifest.ts:319-326`, after inserting a line, every shifted line is reported as "Changed since last render" although its take is reused. Positional ids (`s01/003`) also renumber the export stems, which breaks editor timelines. Compare by cache key and the selected take instead.
- **L2. Identical lines in one run send duplicate paid requests (VERIFIED).** "Yes" / "No" / "Yes" made 3 requests (`scene-render.ts:518`). Before sending, reuse a take rendered earlier in the same run with the same `cache_key`.
- **L3. Receipts drop tokens.** `usageSince` (`scene-render.ts:427-441`) discards `summary.tokens`, so Gemini receipts read "unknown" even though the provider reported token usage. `settleTelemetry` has a 2 s timeout, so a slow usage read can be credited to the next take.
- **L4. `voice add <id>` reads the file before validating `id`.** `index.ts:134-140` does `fs.existsSync(file)` and `JSON.parse` on `voices/<id>.json` before `assertValidProfile`. `../../x` reads outside the project, and parse errors can show part of the file. It does not write. Validate `id` first.
- **L5. `voice add --force` drops clone consent.** Without `--cloned`, it removes the existing `clone.consent` block and bumps the version, which erases the consent record. Carry `clone` over, or require `--cloned` when the old profile had it.
- **L6. `--new-take` silently un-approves a line.** It selects the new candidate (`scene-render.ts:530`), so the line drops from approved to rendered and `export --approved-only` reports it missing even though an approved take exists. Either document this or keep the approved take selected.
- **L7. Settings that may be ignored or wrong are accepted.**
  - OpenAI `speed` is accepted for `gpt-4o-mini-tts`; OpenAI documents it for tts-1 and tts-1-hd. It is sent and becomes part of the cache key.
  - ElevenLabs `seed` accepts non-integers.
  - Gemini reports `sample_rate` as `TTS_PCM_SAMPLE_RATE` even when the interactions path returns a RIFF file at a different rate.
- **L8. `writeManifest` cost grows with project size.** It rewrites the whole manifest with full text after every line, which is O(lines²) I/O on large projects. A failed write leaves `*.tmp` behind. There is no fsync.

## Verified OK
- **Preflight order:** all profiles and lines (markup, direction, style, voice and format) are checked in `planScenes`, and keys in `preflight`, before the first request. `--dry-run` stops at the first fetch, with no manifest written beforehand.
- **Request shapes:**
  - OpenAI `/audio/speech`: `input`, `voice`, `response_format`, `instructions`, `speed`.
  - ElevenLabs `text-to-speech/{voice}?output_format=`: `voice_settings` with `speed`, `seed` at top level, `language_code`, `previous_text` and `next_text`.
  - Gemini: delegates to the existing builders.
- **Retries and fallback:** no retries; Gemini key rotation happens only on 429 or RESOURCE_EXHAUSTED, which are not billed. No fallback to another provider.
- **Gemini refactor:** behaviour preserved. `generateGeminiSpeech` still returns `{status:"error"}` for the same failures, and existing speech tests pass. The only change is that post-processing exceptions are now also caught.
- **Secrets:** none in manifests or profiles (`findSecrets`, and `params` carry no keys). Log lines show ids and character counts, never text.
- **Worker:** scene commands are excluded in the worker policy, and `check:mcp` is clean.
- **Vietnamese text:** NFC normalisation and code-point counts are correct.

## Recommended actions (in order)
1. H1: validate the manifest on read and confine export paths.
2. H2 and M1: fix take identity and receipt deduplication.
3. M2: fix the chunker regex and assert nothing is lost.
4. M3: add a manifest lock.
5. M4: gate selection and export on verification.
6. M5: make `plan` merge by default.
7. M6: commit the docs, README and `skill/SKILL.md`.

## Unresolved questions
- ElevenLabs `language_code` on `eleven_v3`: does the API accept it, or does it return 400? The adapter sends it.
- Gemini TTS input limit: 4000 code points is assumed. If the limit is in bytes or tokens, Vietnamese text could go over it.
- Should audio tags be allowed on Gemini TTS models that document bracketed markup? They are blocked today.

## Resolution (follow-up commit)

- H1 fixed: `readManifest` rejects scene/line/speaker ids and take ids/paths that could leave the project; export also asserts every stem stays inside `--out`.
- H2 fixed: takes follow their cache key; takes carried by line position are only stale history (keys no line uses); `summarize` counts each take file once.
- M1 fixed: take ids get a `_N` suffix when a new request returns identical bytes.
- M2 fixed: the sentence splitter is lossless (and falls back to the whole text if it ever is not).
- M3 fixed: `plan`, `render`, `approve`, `reject` hold `multix-scene.lock` (stale locks from exited processes are taken over).
- M4 fixed: any verification warning makes the take unusable; it is kept with its receipt and the line fails with `VERIFICATION_FAILED`. Test fakes now return valid WAV.
- M5 fixed: `plan <scripts>` adds to the planned scripts; `--replace` gives the old behaviour.
- M6 fixed: docs committed separately (EN/VI site pages, README, SKILL.md).
- L1 partly: shifted lines keep their audio and are no longer reported as invalidated; ids still renumber (documented).
- L2 fixed: identical lines in one run share one request.
- L4 fixed: `profilePath` validates the id. L7: ElevenLabs `seed` must be an integer.
- Not changed: L3 (token-based Gemini cost needs a price table), L5/L6 (intended: `--force` replaces the whole profile; a new take is a new candidate), L8 (rewrite after every take is the crash-safety guarantee).
