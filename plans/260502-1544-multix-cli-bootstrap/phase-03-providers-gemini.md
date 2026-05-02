# Phase 03 — Gemini Provider

## Context
- Plan: [plan.md](plan.md)
- Source: `gemini_batch_process.py` (1380 LOC) — see scout §2.
- Depends on: phase-02.

## Overview
- Priority: P1
- Status: pending
- Goal: port Gemini analyze/transcribe/extract/generate (image+video) to TS, exposed as `multix gemini ...`.

## Key Insights
- Source script auto-detects task by extension and routes generation to MiniMax/OpenRouter when model id implies it. We split that routing back out — `multix gemini` only handles Google direct; cross-provider routing happens via `--provider` at top-level wrapper command (deferred / kept simple: user picks command).
- Models default: `gemini-3.1-flash-image-preview` (image), `gemini-2.5-flash` (analysis), Imagen 4 family for production image gen.
- Gemini Files API: upload → poll until ACTIVE → reference fileUri in generateContent call.
- Native fetch + Bearer (`Authorization: Bearer $GEMINI_API_KEY`) or `?key=` query param. Use header style.

## Requirements
Functional subcommands:
- `multix gemini analyze --files <...> [--prompt] [--model] [--format text|json|csv|markdown] [--output] [-v]`
- `multix gemini transcribe --files <...> [--model] [--prompt] ...`
- `multix gemini extract --files <...> --prompt <str> [--format json] ...`
- `multix gemini generate --prompt <str> [--model] [--aspect-ratio] [--num-images] [--size 1K|2K|4K] [--output] [-v]`
- `multix gemini generate-video --prompt <str> [--model] [--resolution 720p|1080p] [--reference-images <...>] [--output] [-v]`

Aspect ratios: `1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9` (zod enum).

Defaults match Python source exactly (see scout).

Non-functional:
- Each command file <200 LOC. Shared logic in `src/providers/gemini/client.ts`.

## Architecture
```
src/providers/gemini/
  client.ts          # GeminiClient: uploadFile, generateContent, generateImage, listModels
  models.ts          # constants: IMAGE_MODEL_DEFAULT, IMAGEN_MODELS, defaults per task
  task-resolver.ts   # inferTaskFromFile(ext), getDefaultModel(task)
  schemas.ts         # zod input schemas per command
  result-formatter.ts # text|json|csv|markdown rendering of analyze/transcribe results
  commands/
    analyze.ts
    transcribe.ts
    extract.ts
    generate.ts
    generate-video.ts
    index.ts        # exports register(program: Command)
```
Data flow: command parses argv → zod validate → `GeminiClient` calls `httpJson` → result-formatter writes to stdout / `--output`.

## Related Code Files
Create: all `src/providers/gemini/**` files above.
Modify: `src/commands/index.ts` — import and call `registerGeminiCommands(program)`.
Read for context: scout §2 lines for argv parity.

## Implementation Steps
1. `models.ts`: export model id constants and Sets.
2. `task-resolver.ts`: extension → task map (audio/video/image/pdf).
3. `schemas.ts`: zod schemas per task.
4. `client.ts`: methods around Gemini REST endpoints (`/v1beta/models/{model}:generateContent`, `/v1beta/files`). Use `httpJson` from core. File upload via multipart.
5. `result-formatter.ts`: render based on `--format`.
6. Each `commands/*.ts`: parses options, calls client, prints result.
7. `commands/index.ts`: `registerGeminiCommands(program)` adds `gemini` subcommand group with the 5 subcommands.
8. Wire into `src/commands/index.ts`.

## Todo List
- [ ] models.ts
- [ ] task-resolver.ts
- [ ] schemas.ts
- [ ] client.ts (upload, generate, image, video)
- [ ] result-formatter.ts
- [ ] commands/analyze.ts
- [ ] commands/transcribe.ts
- [ ] commands/extract.ts
- [ ] commands/generate.ts
- [ ] commands/generate-video.ts
- [ ] register in root cli

## Success Criteria
- `multix gemini --help` lists 5 subcommands.
- `multix gemini generate --prompt "test" --dry-run` (or with mocked fetch in tests) returns success Result.
- File-upload + generate flow exercised in integration test (mocked).

## Risk Assessment
| Risk | L | I | Mitigation |
|------|---|---|-----------|
| Veo (video) endpoints not stable | H | M | Mark generate-video experimental in --help; surface server errors verbatim |
| Gemini Files API polling timeout | M | M | Configurable `--upload-timeout`, default 120s |
| Large file uploads exceed memory | L | H | Stream multipart; never buffer whole file |
| Aspect-ratio/size combos rejected by API | M | L | Zod enum at CLI; let API errors propagate verbosely |

## Security Considerations
- API key only via env (`GEMINI_API_KEY`); never accept via flag.
- Redact key in verbose logs.
- Reject local file paths outside cwd? No — user expects to read arbitrary local files; document in README.

## Next Steps
After phase-09 tests pass, phase-10 documents flag matrix in README.
