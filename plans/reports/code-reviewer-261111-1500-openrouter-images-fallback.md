# Code review: PR #584 — openrouter /api/v1/images fallback

Head 852297a on `claude/multix-cli-error-68a3f1`, base `main`. Closes #583.

## Scope
- Files: `src/providers/openrouter/images-endpoint.ts` (new, 82), `client.ts` (+20), `commands/image-to-image.ts` (+19/-9), `tests/unit/providers/openrouter/images-endpoint.test.ts` (new, 88). ~211 LOC.
- Verification run here: `vitest tests/unit/providers/openrouter` 108 pass / 2 skipped; `npm run lint` clean; `npm run typecheck` clean; `npm run build` ok; `npm run check:mcp` passes (bundle check clean). `grep -rln openrouter worker/src worker/scripts worker/container` (minus cli-catalog) hits only `provider-secret-names.ts`, `jobs/cli-command-policy.ts`, `skills/builtin-skills.json`: no worker code imports an openrouter module. Worker imports from `src/providers` today: `byteplus/models.js`, `fal/speech-models.js` only.
- Full `npm test`: 9 failures in 6 files (model-job-identity, scene, catalog-store, catalog-command, lyria-realtime, media-quality-ffmpeg, smoke agent-mode SIGHUP), none touching the changed code. Reproduced `model-job-identity` failing identically on base 7922a27 in a temporary worktree using this worktree's node_modules, so these are environmental / pre-existing here, not caused by the PR. (The same file passes in the main checkout at `/Volumes/GOON/www/oss/multix-cli`, which has its own node_modules and `.env`; not investigated further.)
- API shape checked against OpenRouter docs (image-generation guide): request `model`, `prompt`, `aspect_ratio`, `resolution` (512/768/1K/1.5K/2K/4K), `input_references[{type:"image_url",image_url:{url}}]` (http(s) or data URL), optional `n`; response `data[].b64_json` + optional `media_type`. PR payload and parser match. `--image-size` help says "1K, 2K", same tier vocabulary as `resolution`.

## Overall
Correct and narrowly scoped. Fallback only fires on HttpError 404 whose body names `/api/v1/images` or "image generation model"; all other errors keep previous behavior. No key leakage: headers come from existing `buildOpenRouterHeaders`, errors are HttpError (URL and snippet redacted), debug log prints model only. Snippet cap is 500 chars (`fetch-json.ts` SNIPPET_MAX), the real 404 message is ~180 chars, so detection is not truncated. No response size cap on httpJson, so large 4K b64 payloads are not rejected. Data URLs go through `fetchBytes` data: branch (base64 decode), so saving works. One blocker against the brief: the new module is not runtime-neutral (High 1).

## Critical
None.

## High (blocking per review brief)
1. **`images-endpoint.ts` is not runtime-neutral, despite its header claiming so** — `images-endpoint.ts:9` says "Runtime-neutral: no node:* imports". No direct `node:*` import, but transitively: line 14 imports `httpJson` from `core/http-client.ts` (`node:fs`, `node:path`, `node:stream`, `node:stream/promises`), line 15 imports `payload.ts` -> `core/env-loader.ts` (`node:fs`, `node:os`, `node:path`, `dotenv`). It also ignores AGENTS.md "provider HTTP clients take `fetch`, `apiKey` and `baseUrl` as inputs" (uses global fetch, hard-coded URL). `check:mcp` passes only because nothing in `worker/` imports it; the first worker import would fail the bundle check. The brief states this file must stay runtime-neutral, so this is a stated requirement failing.
   Fix: import `fetchJson` (and `FetchLike`) from `core/fetch-json.js` instead of `httpJson`; give `requestOpenRouterImages` `{ apiKey, headers? | referer?/title?, baseUrl?, fetch? }` inputs; build headers in the command layer (or split `buildOpenRouterHeaders` so the env lookup of `OPENROUTER_SITE_URL`/title stays in the caller). Import only the `ParsedImageResponse` type from `payload.ts` (`import type` is erased). Reference pattern: `src/providers/fish/voice-design-client.ts` (`FetchLike` from fetch-json, `baseUrl?`, `fetch?` options). Minimal alternative if the orchestrator accepts non-neutral: delete the false comment line 9; then the requirement is waived, not met.

## Medium
2. **Fallback paths untested where it matters** — test covers only `generate` with numImages=1 and asserts a call to `/images` exists. Not covered: i2i fallback (`image-to-image.ts:166-171`, `input_references` reaching the wire), numImages>1 fallback loop (`client.ts:101-134`), and error propagation when `/images` itself fails. The generate test does not assert the request body. Add one i2i test via the command (or extract `runImageToImage`), and one numImages=2 test asserting saved count and request count.

2b. **Docs now partially inaccurate (Documentation impact N/A is questionable)** — `docs-site/src/content/docs/commands/openrouter.md:24-26` says `--strength` applies to Recraft and `OPENROUTER_FALLBACK_MODELS` "applies to image generation and image-to-image requests"; `skill/image-generation/SKILL.md` (FALLBACK_MODELS paragraph, "applies to BOTH `generate` and `i2i`", and the modalities table) says the same. On the new `/images` path neither fallback models nor strength is sent. Fix: one sentence in the English page, its `vi/` counterpart and the skill: image-only models are retried via `/api/v1/images`, where fallback models and `--strength` are not applied. AGENTS.md lists provider/model capabilities as doc-impacting.

## Low
3. **Repeated doomed chat call per image** — `client.ts:101-134`: with numImages=N on an image-only model each iteration first POSTs chat/completions (404), then `/images`, so 2N requests. Likely not billed (assumption, not verified) but adds latency and noise. Option: a `useImagesEndpoint` flag set on the first detection so later iterations go straight to `/images`, or send `n: numImages` once (docs: providers may return fewer; single-image providers reject n>1, so keep the loop as fallback).
4. **Silent option drops on the fallback path** — `OPENROUTER_FALLBACK_MODELS` is ignored by `/images` (only `model` sent), and i2i `--strength` (`image_config.strength`) is dropped (`image-to-image.ts:167-171`). Consider a `logger.warn` when strength or fallback models are set and the fallback triggers.
5. **Original error masked** — when `/images` also fails the user sees only the `/images` error; the chat 404 that triggered it is lost. Acceptable; optionally prefix "chat/completions rejected model as image-only; /images failed: ...".
6. **Extension vs media_type** — `media_type` may be `image/webp`, `image/jpeg` or `image/svg+xml`, but both paths save as `.png` (pre-existing pattern in chat path; `client.ts` save loop and i2i save loop). Not introduced here; candidate for a separate issue.
7. **Undocumented `url` branch** — `images-endpoint.ts:60-61` accepts `data[].url`, which docs do not define; it would be fetched by `fetchBytes` without URL validation. Same trust level as the chat path's http URLs; fine, just note it is speculative.
8. Detection keyword "image generation model" on any 404 is slightly broad; false positive only reroutes to `/images`, whose error is then surfaced. Acceptable.

## Edge cases checked
- numImages=0: loop runs once, break `>= 0` true; same as before.
- `/images` returns more images than requested: save loop clamps to `numImages`. i2i saves all returned (same as chat path).
- `usedModel` stays the requested model on fallback (correct; /images has no routing).
- Non-HttpError (network/timeout): not retried via `/images`. Correct.
- Job container (`worker/container/Dockerfile:28`) symlinks `/app/dist/cli.js` as `multix`, and `worker/src/jobs/cli-command-policy.ts` references openrouter commands, so remote MCP jobs running `openrouter generate`/`i2i` get the fallback once the container is rebuilt. No job spec or R2 output layout change, so no container/Worker compatibility concern.

## AGENTS.md conventions
- Conventional commit `fix(openrouter): ...`, `Closes #583`, `Documentation impact` section present, but N/A is questionable: see Medium 2b.
- No new model added to `model-registry.ts`. Good.
- Runtime-neutral convention: see High 1.

## Recommended actions
1. Make `images-endpoint.ts` actually runtime-neutral (`fetchJson`, injected fetch/baseUrl/headers), or the orchestrator explicitly waives it and the false comment is deleted.
2. Add i2i fallback test and numImages>1 fallback test asserting request bodies.
3. Update `commands/openrouter.md` (+ `vi/`) and `skill/image-generation/SKILL.md` on dropped fallback models / strength for `/images`.
4. Optional: skip chat after first detection; warn on dropped strength/fallback models.

## Metrics
- Lint: 0 issues. Typecheck: 0 errors. Build ok. Openrouter unit tests: 108 pass. check:mcp: pass. Full suite: 9 unrelated failures, reproduced on base.

## Unresolved questions
- Should `/images` fallback honor `OPENROUTER_FALLBACK_MODELS` (retry each model in order), or is single-model acceptable?

Status: DONE_WITH_CONCERNS
Summary: Fallback logic, 404 detection, payload/response shape and key handling are correct; lint, typecheck, build, openrouter tests and check:mcp pass. The new module is not runtime-neutral as the brief requires; tests skip i2i / multi-image fallback; docs on fallback models and strength are now partly wrong.
Blocking findings:
- High, `src/providers/openrouter/images-endpoint.ts:9,14,15`: transitively imports node:* (via `core/http-client.ts` and `payload.ts` -> `core/env-loader.ts`) while claiming runtime-neutral. Fix: use `fetchJson` from `core/fetch-json.js`, inject `fetch`/`baseUrl`/headers, `import type` only from payload.ts; or have the orchestrator waive and delete the comment.
