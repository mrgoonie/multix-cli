---
phase: 2
title: "OpenAI Image API Generate and Edit"
status: complete
priority: P1
effort: "4h"
dependencies: [1]
---

# Phase 2: OpenAI Image API Generate and Edit

## Context Links

- OpenAI image docs: `https://developers.openai.com/api/docs/guides/image-generation`
- OpenAI image reference: `https://developers.openai.com/api/reference/resources/images`
- Existing image input helper: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/core/image-input.ts`

## Overview

Implement direct OpenAI Image API support for `generate` and `image-to-image` using raw HTTP and base64 image responses.

## Requirements

- Functional: `generate` supports prompt, model, size, quality, output format, output path, driver.
- Functional: `image-to-image` supports one or more `--ref` images and alias `i2i`.
- Functional: `--ref` accepts local paths or URLs; URLs are downloaded and attached as multipart image files for API edit calls.
- Functional: GPT image responses save `b64_json` bytes directly.
- Non-functional: avoid OpenAI SDK. Use existing `fetch`/FormData patterns.
- Non-functional: image API path is stable and separate from experimental Codex driver.

## Architecture

Use a thin `client.ts` for auth and endpoints:

```text
POST /v1/images/generations -> JSON body
POST /v1/images/edits       -> multipart FormData
```

`openai-image.ts` handles payload construction and saving. Command files only parse CLI options, validate, then call helpers.

## Related Code Files

- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/client.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/openai-image.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/commands/generate.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/commands/image-to-image.ts`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/commands/index.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/unit/providers/openai/image-payload.test.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/unit/providers/openai/image-save.test.ts`

## Implementation Steps

### Tests Before

1. Add failing payload tests for generation:
   - model defaults to `gpt-image-2`
   - size supports `1024x1024`, `1024x1536`, `1536x1024`, `auto`
   - output format supports `png`, `jpeg`, `webp`
   - quality supports `low`, `medium`, `high`
2. Add failing edit payload tests:
   - local refs become multipart files, not data URLs.
   - URL refs are fetched to bytes and appended as multipart files.
   - multiple refs are accepted when passed as repeated `image` form fields.
3. Add failing save tests:
   - `b64_json` writes bytes.
   - `--output` writes exact target for single image.
   - unsupported/missing image response fails clearly.

### Refactor

4. Implement `requireOpenAIKey()` in `client.ts`.
5. Implement `postOpenAIJson<T>()`, `postOpenAIForm<T>()`, and binary save helpers if not already covered.
6. Implement `generateOpenAIImage()` for `/images/generations`.
7. Implement `editOpenAIImage()` for `/images/edits`; local refs use `fs.readFileSync`, URL refs use `fetchBytes`.
8. Register `generate`, `image-to-image`, and `i2i`.

### Tests After

9. Add command parse tests for required `--prompt` and `--ref`.
10. Add mocked HTTP tests for success and error responses.
11. Confirm no live key is required.

### Regression Gate

```bash
npm run typecheck
npm test -- tests/unit/providers/openai tests/smoke
```

## Success Criteria

- [x] `multix openai generate --help` and `image-to-image --help` work.
- [x] API image generation saves image files from `b64_json`.
- [x] API image edit accepts local refs and saves edited output.
- [x] Errors include provider/action context, not raw stack only.

## Risk Assessment

- Risk: GPT image models return base64, unlike URL-based providers. Mitigation: dedicated save path and tests.
- Risk: edit endpoint multipart behavior differs from JSON helpers. Mitigation: separate `postOpenAIForm` with mocked FormData tests.
- Risk: OpenAI org verification/rate limits block live use. Mitigation: docs and check output must say key can be configured but API may still need org verification.

## Security Considerations

- Never include image prompt or key in verbose errors beyond intended user output.
- Validate file existence and extensions before upload.
