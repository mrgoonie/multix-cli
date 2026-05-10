---
phase: 1
title: Refactor & modalities fix
status: completed
priority: P1
effort: 30m
dependencies: []
---

# Phase 1: Refactor & modalities fix

## Overview
Extract shared OpenRouter helpers into `payload.ts`. Invert the modalities heuristic so `["image","text"]` is the default; only known image-only families (`black-forest-labs/`, `sourceful/`) get `["image"]`. Root-cause fix for the `openai/gpt-5.4-image-2` failure.

## Requirements
- Functional: i2i + generate must send correct `modalities` per model family.
- Non-functional: zero behaviour change for Gemini/Flux models. DRY across `client.ts` + `image-to-image.ts`.

## Architecture
```
src/providers/openrouter/
├── payload.ts          (NEW)
│   ├── resolveModalities(model)            -> string[]
│   ├── buildOpenRouterHeaders(apiKey)      -> Record<string,string>
│   └── IMAGE_ONLY_MODEL_PREFIXES (const)
├── client.ts           (use payload helpers; drop inline heuristic)
└── commands/image-to-image.ts (use payload helpers; drop duplicates)
```

## Related Code Files
- Create: `src/providers/openrouter/payload.ts`
- Modify: `src/providers/openrouter/client.ts` (replace inline modalities + headers)
- Modify: `src/providers/openrouter/commands/image-to-image.ts` (replace inline modalities + headers)

## Implementation Steps
1. Create `src/providers/openrouter/payload.ts`:
   - `IMAGE_ONLY_MODEL_PREFIXES = ["black-forest-labs/", "sourceful/"]` (exported readonly).
   - `resolveModalities(model: string): string[]` — `["image"]` if any prefix matches, else `["image","text"]`.
   - `buildOpenRouterHeaders(apiKey: string)` — moved from client.ts (Authorization, Content-Type, optional HTTP-Referer + X-Title).
2. Update `client.ts:buildPayload` and `client.ts:generateOpenRouterImage` to import `resolveModalities` + `buildOpenRouterHeaders`. Remove old inline `model.includes("gemini")` ternary and `buildHeaders` function.
3. Update `commands/image-to-image.ts:runImageToImage` likewise. Remove inline modalities ternary and inline header construction.
4. Run `npm run build` (or `tsc --noEmit`) — ensure compiles cleanly.

## Success Criteria
- [ ] `payload.ts` exports `resolveModalities` + `buildOpenRouterHeaders` + `IMAGE_ONLY_MODEL_PREFIXES`.
- [ ] `client.ts` and `image-to-image.ts` import + use them; no duplicate logic remains.
- [ ] `resolveModalities("openai/gpt-5.4-image-2")` → `["image","text"]`.
- [ ] `resolveModalities("google/gemini-2.5-flash-image")` → `["image","text"]`.
- [ ] `resolveModalities("black-forest-labs/flux-kontext-pro")` → `["image"]`.
- [ ] TypeScript compiles, no new lint errors.

## Risk Assessment
- Risk: model id casing/quirks. Mitigation: prefix match is case-sensitive against OpenRouter's canonical lowercase ids — document in code comment; mention in README phase-04.
- Risk: future image-only families (e.g. new Recraft/Sourceful variants). Mitigation: prefix list is centralized + easy to extend; reference in README.
