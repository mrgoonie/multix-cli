---
phase: 3
title: Recraft strength + i2i fallbacks
status: completed
priority: P2
effort: 30m
dependencies:
  - 1
---

# Phase 3: Recraft strength + i2i fallbacks

## Overview
Add `--strength <0..1>` flag to `openrouter image-to-image` (Recraft control). Add `OPENROUTER_FALLBACK_MODELS` support to i2i — mirror the existing behaviour from `generate.ts`.

## Requirements
- Functional:
  - When `--strength` provided, validate range `[0,1]` and emit `image_config: { strength }` in payload. Omit when not provided.
  - When env `OPENROUTER_FALLBACK_MODELS` is non-empty (CSV), payload uses `models: [primary, ...fallbacks]` instead of `model: primary` (same precedence as `generate.ts`).
- Non-functional: no breaking changes to existing i2i invocations.

## Architecture
Reuse `payload.ts`. Extend or add a builder there to centralize i2i payload construction:
```
payload.ts
└── buildI2IPayload(opts: {
      prompt, model, refs: string[],
      strength?: number,
      fallbackModels: string[],
    }) -> Record<string, unknown>
```

## Related Code Files
- Modify: `src/providers/openrouter/payload.ts` (add `buildI2IPayload`)
- Modify: `src/providers/openrouter/commands/image-to-image.ts` (add CLI flag, env read, call builder)

## Implementation Steps
1. In `payload.ts`, add `buildI2IPayload`:
   ```ts
   const content: Record<string, unknown>[] = refs.map(url => ({type:"image_url", image_url:{url}}));
   content.push({type:"text", text: prompt});
   const payload: Record<string, unknown> = {
     messages: [{role:"user", content}],
     modalities: resolveModalities(model),
   };
   if (typeof strength === "number") payload.image_config = { strength };
   if (fallbackModels.length > 0) payload.models = [model, ...fallbackModels];
   else payload.model = model;
   return payload;
   ```
2. In `commands/image-to-image.ts`:
   - Add option: `.option("--strength <n>", "Recraft init-image strength 0..1")`
   - Parse + validate: `Number.parseFloat`; throw if `NaN || <0 || >1`.
   - Read `OPENROUTER_FALLBACK_MODELS` via `resolveKey`, split CSV like `client.ts` does.
   - Replace inline payload construction with `buildI2IPayload(...)` call.
   - Log fallbacks (debug) similar to `generate.ts`.
3. Update help description for `image-to-image` command to mention `--strength` and env var.
4. `npm run build`.

## Success Criteria
- [ ] `multix openrouter i2i --help` shows `--strength`.
- [ ] Without `--strength`, payload omits `image_config`.
- [ ] With `--strength 0.7`, payload contains `image_config: { strength: 0.7 }`.
- [ ] Out-of-range `--strength 1.5` exits with clear error before HTTP call.
- [ ] With `OPENROUTER_FALLBACK_MODELS=a/x,b/y`, payload uses `models: [primary, "a/x", "b/y"]` and omits `model`.
- [ ] Without env var, payload uses `model: primary` (current behaviour).

## Risk Assessment
- Risk: non-Recraft models may reject `image_config.strength`. Mitigation: only emit when user explicitly opts in via flag — user owns that choice. Help text notes Recraft-specific.
- Risk: fallback models with mismatched modalities cause runtime errors. Mitigation: existing behaviour for `generate.ts` already accepts this trade-off; document in README.
