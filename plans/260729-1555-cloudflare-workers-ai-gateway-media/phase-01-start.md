---
phase: 1
title: "Cloudflare contract catalog and safe transport"
status: completed
priority: P1
effort: "3h"
dependencies: []
---

# Phase 1: Cloudflare contract catalog and safe transport

## Overview

Create the small reusable Cloudflare boundary before commands. It selects direct or Gateway REST, preserves the model payload, and makes secret-safe failure behavior testable.

## Requirements

- Direct URL: `/client/v4/accounts/{account}/ai/run/{model}`; Gateway URL: `/client/v4/accounts/{account}/ai/run` with `{ model, input }` and `cf-aig-gateway-id`.
- Require account ID/token; choose gateway only when gateway ID is non-empty. Add `cf-aig-collect-log-payload: false` unless explicit configuration enables it.
- Curate only `@cf/black-forest-labs/flux-1-schnell` and `@cf/myshell-ai/melotts`. Validate all CLI/configuration model choices against their media kind.
- Capture JSON and binary responses without serializing a `FormData` body or logging headers/body.

## Related code files

- Create: `src/providers/cloudflare/models.ts` — model catalog, defaults, validators, format helpers.
- Create: `src/providers/cloudflare/types.ts` — Cloudflare envelope and media response types.
- Create: `src/providers/cloudflare/client.ts` — configuration resolution, transport construction, safe fetch/result decoding.
- Create: `tests/unit/providers/cloudflare/client.test.ts` — direct/Gateway/header/error tests.
- Create: `tests/unit/providers/cloudflare/models.test.ts` — catalog and override validation tests.
- Reuse: `src/core/errors.ts` and `src/core/http-client.ts` only when their JSON-only behavior fits.

## Tests first

1. Write fetch-stub tests asserting direct URL/body and Gateway URL/envelope/header for the same model input.
2. Add cases for absent account/token, blank gateway ID, unsupported model/media combination, non-2xx, `success:false`, malformed JSON, and expected binary content type.
3. Assert debug/error output contains no token, `Authorization`, payload text, or raw headers; test `collect-log-payload` default false and explicit true.

## Implementation steps

1. Add typed static catalog and pure option/configuration validators. Do not query a remote model list.
2. Implement one request function returning safe JSON-or-bytes results. It must attach `Authorization` internally and redact error context to method, transport kind, model, and status.
3. Use direct native input untouched; use Gateway’s documented `{model,input}` wrapper only. Keep response decoding shared for image and TTS.
4. Run focused unit tests, then `npm run typecheck`.

## Success criteria

- [ ] Exact direct/Gateway request differences are covered by unit tests.
- [ ] Gateway metadata observability works while payload logging defaults off.
- [ ] No secret reaches normal, verbose, or thrown error text.

## Risks and rollback

Cloudflare model schemas evolve. The explicit two-ID catalog limits breakage; remove/replace only after updating evidence and tests. This phase adds no command registration, so reverting its files is isolated.
