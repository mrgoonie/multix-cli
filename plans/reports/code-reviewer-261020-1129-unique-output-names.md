# Code review: unique output file names (issue #260)

## Scope
- Change: `outputStamp()` in `src/core/output-name.ts` (epoch ms + 8 hex chars from `globalThis.crypto.getRandomValues`), used at 29 provider naming sites; README, docs-site (EN and VI), and skill/SKILL.md updated; new unit test `tests/unit/core/output-name.test.ts`.
- 38 files, +102/-34.
- Note: the author committed this during the review as `d4e41f7 fix(core): add a random suffix to timestamp-based output file names` on branch `claude/gracious-heisenberg-p0rpxs`. The working tree is now clean. I reviewed the same content as `git diff HEAD~1`.

## Verdict
The change is correct and safe to merge. No blocking issues. One docs sentence overstates what the change covers (Medium). There are also some optional points.

## Checks run
| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` (Biome, 458 files) | pass, 0 issues |
| `npm run build` | pass |
| `npm test` | 82 files passed, 4 skipped; 1417 tests passed, 12 skipped |
| `npm run check:mcp` | pass (worker typecheck/tests, wrangler dry-run, `check-bundle: 1 file(s) clean`) |
| `npm run verify:docs` | not run (docs-site deps not installed) |

## (1) Leftover `Date.now()`-only names and other names that can collide
- No `Date.now()` output name is left in `src/`. The remaining `Date.now()` calls are deadlines and elapsed-time measurements. One is the `.part` temp name in `src/core/http-client.ts:175`, which already includes the pid and a random value.
- Every former `const ts = Date.now()` hoisted batch stamp (byteplus image, gemini/minimax/openrouter i2i, openai image) now uses `outputStamp()`. Files in one batch still share a single stamp and differ by index. That is correct.
- In the per-item loops (`gemini/commands/generate.ts`, `minimax/generators/image.ts`, `openrouter/client.ts`), `outputStamp()` is called once per file. In `gemini generate`, the suffix `_${i}` is the *request* index, so several images from one response used to share `_${i}` and could overwrite each other within one process. The per-file stamp also fixes that. Do not move the stamp out of the loop there.
- `heygen tts`: `res.request_id ?? outputStamp()` is fine. The request id is unique per call, and `.replace(/[^\w.-]+/g, "-")` keeps the `-` in the stamp.
- Names built from job or prediction IDs (fal, leonardo, replicate, runway, atlascloud, heygen video/translation, byteplus `status`, openrouter `video-status`, elevenlabs dub, cloudflare video) are fixed for a given job. Two runs only produce the same name when they re-download the same job, which is the intended behavior. Several use an 8-char ID prefix (`taskId.slice(0, 8)`, `generationId.slice(0, 8)`, `requestId.slice(0, 8)`), so in theory two different jobs could collide. With about 32 bits of UUID that is negligible, and it was already the case before this change. No action needed.
- Out of scope, already known: `multix doc convert` writes the fixed name `document-extraction.md`, or `<basename>-extraction.md` / `stdin-extraction.md` with `--auto-name`. This is documented (README:707, docs-site media-and-documents.md:82-84). Two parallel runs still overwrite each other. Per AGENTS.md, open a separate issue if this matters rather than widening this PR.

## (2) Import placement and paths
- All 29 imports use correct relative depths (`../../core/` from `providers/<p>/*.ts`, `../../../core/` from `providers/<p>/{commands,generators}/*.ts`). Each sits directly after the `output-dir.js` import, which keeps Biome's import order (lint is clean).
- `src/core/index.ts` re-exports `outputStamp`. That is harmless and matches the `getOutputDir` export.
- `cloudflare/commands/generate-speech.ts` imports `outputStamp` directly, while `media-output.ts` builds the image name internally. This asymmetry already existed and is fine.

## (3) Runtime neutrality and the worker
- `output-name.ts` has no imports and uses `globalThis.crypto` (Web Crypto). That global exists in Node 20+ and in Workers. With `lib: ["ES2022"]`, it type-checks through `@types/node`.
- The worker imports only `src/core/{errors,fetch-json,redact}.js` from the CLI package. No module touched here is in the worker graph. Every touched provider file already imported `node:fs`/`node:path` (`elevenlabs/client.ts` and `openrouter/client.ts` are Node-bound command-layer clients), so this change adds no new runtime-neutrality breach. `check:mcp` bundle check is clean.
- Job container: `worker/container/job-outputs.mjs` lists `out/` and uploads by `safeOutputName`. It does not parse names. The new names contain only `[A-Za-z0-9_.-]`. Its `found.sort()` ordering is still chronological across milliseconds (13-digit ms). Within one ms, the random suffix decides the order, which is cosmetic only.

## (4) Code that parses the old format
- None found. No regex like `gemini_omni_\d+`, `_\d{13}`, or similar exists in `src/`, `worker/`, `tests/`, or the docs. Resume uses the interaction ID (`video-status <id>`), not the record file name. `tests/unit/providers/gemini/omni-flow.test.ts:155` matches on `startsWith("gemini_omni_") && endsWith(".json")`, which still works. In `omni-flow.ts`, the `.json` record and the `.mp4` share `base`, so they stay paired.

## (5) Docs accuracy
- **Medium:** `docs-site/src/content/docs/reference/output-and-troubleshooting.md:20-22` (and the VI copy) says "Default file names end in a millisecond timestamp plus a random suffix". This is not accurate:
  - Many default names do not *end* with the stamp: `gemini_generated_<stamp>_0.png`, `minimax-i2i-<stamp>-1.png`, `openai-<task>-<stamp>-1.png`, `byteplus-image-<stamp>-1.jpg`.
  - Many outputs have no stamp at all: ID-based names (fal, leonardo, replicate, runway, atlascloud, heygen video, elevenlabs dub, `*_thumb`) and the fixed `document-extraction.md` for `doc convert`. So "parallel runs ... do not overwrite each other's files" is not true for `doc convert`.
  - Suggested wording: "Timestamp-based default file names include a millisecond timestamp and a random suffix (for example `veo_generated_1760955000000-3f9a1c07.mp4`), so parallel runs that share an output directory do not overwrite each other's files. Job-based names use the provider's job or request ID."
- The README, gemini.md (EN/VI), and SKILL.md changes to `gemini_omni_<timestamp>-<random>.json` are accurate.
- The VI translation matches the EN meaning.

## Low
- `tests/unit/core/output-name.test.ts`: the 1000-draw uniqueness test has a birthday-collision chance of about 1.2e-4 per run (1000^2 / 2 / 2^32). This is a theoretical flake. Lower it to 100 draws (about 1e-6), or keep it as is. The `vi.restoreAllMocks()` in `finally` is correct.
- The regex `^\d{13}-` breaks in the year 2286. Not relevant.
- The test proves the format and that the suffix differs within one ms. It does not prove that call sites use the helper; the grep above covers that.

## Edge cases checked
- Two processes in the same ms: about 2^-32 collision chance per pair, which is acceptable. Writes use `writeFileSync` without `wx`, so uniqueness is probabilistic rather than enforced. That is adequate for this threat model (local output dir, no adversary).
- `globalThis.crypto` missing: not possible on supported Node (>=20) or Workers.
- Sorting and listing by consumers: no code depends on the name format.

## Recommended actions
1. (Medium) Reword the "Default file names end in..." sentence in both output-and-troubleshooting pages (EN + VI) as above.
2. (Optional) Open a separate issue for the fixed `doc convert` default name if parallel doc extraction into a shared output dir is a supported use case.
3. (Optional) Lower the uniqueness test to 100 draws.

## Plan follow-ups
- No plan file. Issue #260 acceptance criteria (no same-ms overwrite for timestamp-named provider outputs, including Omni `.json` records) are met in code.
- Before PR: move the issue label to `in review` / `done` per AGENTS.md, and attach the test/check output above.

## Unresolved questions
- Is `doc convert`'s fixed default name meant to be in scope for #260? I assumed not, because the issue names provider sites.

Status: DONE_WITH_CONCERNS
Summary: The fix is complete and correct. No `Date.now()`-only output names remain, imports are correct, the worker/runtime-neutrality checks pass (`check:mcp` clean), and no code parses the old format. Typecheck, lint, build, and the full test suite pass.
Concerns/Blockers: The docs sentence "Default file names end in a millisecond timestamp plus a random suffix" overstates coverage (index suffixes, ID-based names, fixed `doc convert` name) and should be reworded. Non-blocking.
