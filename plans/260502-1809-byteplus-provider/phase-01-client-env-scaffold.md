---
phase: 1
title: "Client & env scaffold"
status: completed
priority: P1
effort: "2h"
dependencies: []
---

# Phase 1: Client & env scaffold

## Overview
Foundation: HTTP client, model registry, type defs, env wiring, and `check` integration. Nothing user-visible yet beyond `multix check` recognizing the new key.

## Requirements
- Bearer auth client supporting `BYTEPLUS_API_KEY` (primary) + `ARK_API_KEY` (fallback)
- Configurable base URL via `BYTEPLUS_BASE_URL` (default `https://ark.ap-southeast.bytepluses.com/api/v3`)
- Reusable for Seedream (sync) + Seedance (async task)
- `multix check` reports presence/absence of BytePlus key

## Architecture
Mirror `src/providers/leonardo/{client.ts,models.ts,types.ts}`. Two layers:
- **Transport** (`client.ts`): wraps `core/http-client.ts`'s `httpJson`, injects `Authorization: Bearer`, applies query/body, GET/POST/DELETE helpers.
- **Config** (`models.ts`): default model IDs, base URL, defaults object (similar to `LEONARDO_DEFAULTS`).

Key resolution chain inside `requireBytePlusKey()`: `resolveKey("BYTEPLUS_API_KEY") ?? resolveKey("ARK_API_KEY")` — throw `ConfigError` with both env names in message if neither set.

## Related Code Files
<!-- Updated: Validation Session 1 - registration moved to commands/index.ts; check.ts refactor + Leonardo backfill -->
**Create:**
- `src/providers/byteplus/client.ts` — `BytePlusClient`, `requireBytePlusKey`, `bytePlusBaseUrl`, `createBytePlusClient`
- `src/providers/byteplus/models.ts` — model IDs, defaults, base URL constant
- `src/providers/byteplus/types.ts` — image + video request/response types
- `src/providers/byteplus/commands/index.ts` — `registerBytePlusCommands(program)` no-op stub

**Modify:**
- `src/commands/index.ts` — import + call `registerBytePlusCommands` next to `registerLeonardoCommands`
- `src/commands/check.ts` — refactor inline `resolveKey` calls to a provider-list array `[{name, envPrimary, envFallback?, optional, link}]`; add BytePlus entry (envPrimary `BYTEPLUS_API_KEY`, envFallback `ARK_API_KEY`, optional true); also add missing Leonardo entry (envPrimary `LEONARDO_API_KEY`, optional true)
- `src/commands/check-helpers/setup-hints.ts` — append BytePlus hint, link `https://console.byteplus.com/auth/api-keys`

## Implementation Steps
1. Create `src/providers/byteplus/models.ts`:
   - `DEFAULT_BYTEPLUS_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3"`
   - `DEFAULT_BYTEPLUS_IMAGE_MODEL = "seedream-4-0-250828"`
   - `DEFAULT_BYTEPLUS_VIDEO_MODEL = "seedance-2.0"`
   - `BYTEPLUS_VIDEO_MODELS` array: `seedance-2.0-fast`, `seedance-2.0`, `seedance-2.0-pro`
   - `BYTEPLUS_DEFAULTS` object reading `process.env.BYTEPLUS_IMAGE_MODEL` / `BYTEPLUS_VIDEO_MODEL`
2. Create `src/providers/byteplus/types.ts`:
   - `ImageGenerationRequest`, `ImageGenerationResponse` (OpenAI-compat shape)
   - `VideoTaskRequest` (model, content[]), `VideoTaskResponse` (id), `VideoTaskStatus` (status, video_url, error)
   - `ContentItem` discriminated union for `text` | `image_url` (used Phase 3-5)
3. Create `src/providers/byteplus/client.ts`:
   - `requireBytePlusKey()` — chain `BYTEPLUS_API_KEY` → `ARK_API_KEY`, error message lists both
   - `bytePlusBaseUrl()` reading `BYTEPLUS_BASE_URL`
   - `BytePlusClient` class with `request<T>(path, opts)`, `get`, `post`, `delete` (clone leonardo shape minus v2 path swap)
   - `createBytePlusClient()` factory
4. Create empty `src/providers/byteplus/commands/index.ts` exporting `register(program: Command)` that no-ops (filled in later phases).
5. Wire registration in `src/commands/index.ts`: import `registerBytePlusCommands`, call it next to `registerLeonardoCommands(program)`. (Do NOT touch `cli.ts` — it already calls `registerCommands` once.)
6. Refactor `check.ts`: replace inline `resolveKey` calls with a `PROVIDERS` array iterated in a loop. Each entry: `{ name, envPrimary, envFallback?, optional, link }`. Add BytePlus + missing Leonardo entries. Existing log/exit semantics preserved (exit 1 if zero non-optional and zero optional keys present? — keep parity with current behavior: exit 1 only if NO provider key at all).
7. Update setup-hints.ts to print BytePlus hint when missing.
8. Run `npm run build` — must compile clean. No runtime test yet.

## Success Criteria
- [ ] `npm run build` passes
- [ ] `multix check -v` lists BytePlus row showing key status
- [ ] `multix byteplus --help` shows empty subcommand group (no commands yet)
- [ ] `BYTEPLUS_API_KEY=foo multix check` and `ARK_API_KEY=foo multix check` both detect key
- [ ] No new lint errors

## Risk Assessment
- **check.ts refactor blast radius**: changing inline checks to a list affects existing gemini/openrouter/minimax flows. Mitigation: preserve exact log messages; smoke-test `multix check` with each existing key set/unset combination after refactor.
- **Config naming collision**: ARK_API_KEY may also be set for unrelated Volcengine SDKs. Acceptable — user opted into shared name.
- **Leonardo backfill** is bundled here, not a separate plan. Keep diff minimal — add entry only, no behavior change for leonardo users.
