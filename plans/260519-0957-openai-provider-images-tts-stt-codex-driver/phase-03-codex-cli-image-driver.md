---
phase: 3
title: "Codex CLI Image Driver"
status: complete
priority: P1
effort: "3h"
dependencies: [1, 2]
---

# Phase 3: Codex CLI Image Driver

## Context Links

- Local command evidence: `codex login status` returns `Logged in using ChatGPT` on this machine.
- Local command evidence: `codex exec` supports `--image`, `--cd`, `--output-last-message`, `--json`, `--ephemeral`.

## Overview

Add an experimental image-only driver that uses authenticated Codex CLI subscription access when `OPENAI_API_KEY` is absent. This is a fallback, not the primary provider.

## Requirements

- Functional: `--driver auto|api|codex` works for image commands.
- Functional: `api` requires `OPENAI_API_KEY`.
- Functional: `codex` requires `codex` on PATH and `codex login status` showing ChatGPT auth.
- Functional: `auto` chooses API first, then Codex.
- Functional: first implementation task must run a manual Codex image capability spike; if Codex cannot create an image file reliably, ship API provider and keep Codex driver disabled behind a clear unsupported error until re-planned.
- Non-functional: do not read or parse `~/.codex` credential files.
- Non-functional: Codex path is experimental and must validate output file exists.

## Architecture

`codex-image-driver.ts` owns all process spawning through `execa`:

```text
resolveImageDriver()
  -> api if OPENAI_API_KEY
  -> codex if authenticated
  -> setup error

runCodexImageGeneration()
  -> temp workspace
  -> codex exec -C <tmp> --output-schema <schema> --output-last-message <json> [-i refs]
  -> require image at requested path
```

Prompt must require Codex to create exactly one image file at a provided absolute path and return a small JSON final message. Because this is an agent CLI, the implementation must validate file existence and size instead of trusting final text. The JSON shape should be enforced with a temp `--output-schema`, but schema success is only diagnostic; filesystem validation is authoritative.

## Related Code Files

- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/codex-image-driver.ts`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/commands/generate.ts`
- Modify: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/src/providers/openai/commands/image-to-image.ts`
- Create: `/Users/duynguyen/.codex/worktrees/fffd/multix-cli/tests/unit/providers/openai/codex-image-driver.test.ts`

## Implementation Steps

### Tests Before

1. Add failing tests with mocked `execa`/process runner:
   - missing `codex` gives setup error.
   - `codex login status` without ChatGPT auth fails.
   - `auto` prefers API when key exists.
   - Codex capability status can be `available`, `unsupported`, or `unknown`.
   - Codex runner includes `--output-schema`.
   - Codex driver rejects missing output file.
   - Codex driver rejects zero-byte output file.
   - Codex runner receives sanitized env, not full `process.env`.
2. Add command tests for `--driver codex` and `--driver auto`.
3. Run one manual spike before coding the full driver:

```bash
tmp="$(mktemp -d)"
codex exec --ephemeral --cd "$tmp" --output-last-message "$tmp/result.json" \
  "Create a simple 64x64 PNG at $tmp/out.png and reply with JSON containing path and status."
test -s "$tmp/out.png"
```

If this spike fails in the target environment, update this phase to disable the Codex driver for release rather than building a fake wrapper.

### Refactor

4. Create injectable process runner interface to avoid real Codex calls in unit tests.
5. Implement `checkCodexAuthenticated()` using only `codex login status`.
6. Implement `buildCodexImagePrompt()` with:
   - explicit output absolute path
   - one-image requirement
   - no codebase edits
   - JSON final response contract
7. Write temp JSON schema and pass `--output-schema <schema>` to `codex exec`.
8. Run Codex with sanitized env:
   - keep `PATH`, `HOME`, `CODEX_HOME` if set, `TMPDIR`, and minimal locale vars.
   - do not pass API keys, dotenv-derived provider keys, or arbitrary process env.
9. Implement `runCodexImageGeneration()`:
   - create temp directory
   - call `codex exec --ephemeral --cd <tmp> --output-schema <schema> --output-last-message <file>`
   - pass `--image <ref>` for image-to-image refs
   - copy/rename generated output into normal multix output path if needed
   - validate file type by extension and byte size
10. Integrate driver selection into image commands.

### Tests After

8. Add mocked success path for generate and image-to-image.
9. Add optional manual test note, not CI requirement:

```bash
multix openai generate --driver codex --prompt "simple red square icon" --output /tmp/multix-codex-test.png
```

### Regression Gate

```bash
npm run typecheck
npm test -- tests/unit/providers/openai/codex-image-driver.test.ts tests/unit/providers/openai/driver-selection.test.ts
```

## Success Criteria

- [x] Codex auth detection uses command status only.
- [x] `--driver auto` is deterministic and documented.
- [x] Manual Codex image spike either passes and is recorded, or driver is disabled with clear unsupported error.
- [x] Codex driver cannot report success without a real non-empty image file.
- [x] Unit tests do not spawn real Codex.

## Risk Assessment

- Risk: Codex CLI may not expose image generation in non-interactive `exec`. Mitigation: capability spike gates the driver; do not ship a broken wrapper.
- Risk: Codex CLI is not an image API and output contract may drift. Mitigation: mark experimental, use `--output-schema`, validate files, and keep API driver primary.
- Risk: Codex prompt might edit repo files. Mitigation: run in temp dir, `--ephemeral`, explicit "do not modify repository" prompt, output path only.
- Risk: subscription terms/limits can vary. Mitigation: do not claim free/unlimited in docs; say "uses existing Codex login if available".

## Security Considerations

- Do not expose or read Codex tokens.
- Do not pass sensitive env vars into Codex process. Use sanitized env with only `PATH`, `HOME`, `CODEX_HOME`, temp, and locale basics.
