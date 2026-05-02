# Phase 07 — Document Converter

## Context
- Plan: [plan.md](plan.md)
- Source: `document_converter.py` (395 LOC) — see scout §6.
- Depends on: phase-02, reuses `src/providers/gemini/client.ts` from phase-03 (Files API).

## Overview
- Priority: P2
- Status: pending
- Goal: port to `multix doc convert ...` — convert PDFs/DOCX/images/etc to Markdown via Gemini.

## Key Insights
- Reuses Gemini Files API + generateContent with a fixed "convert to markdown" prompt.
- Default model `gemini-2.5-flash`.
- Default output: `./multix-output/document-extraction.md` (changed from Python's `docs/assets/...` to keep packaged scope).
- `--auto-name` derives output filename from input basename.

## Requirements
Subcommand:
- `multix doc convert --input <files...> [--output <path>] [--auto-name] [--model <str>] [--prompt <str>] [-v]`

Supports PDF, JPEG/PNG/WEBP/HEIC, DOCX/XLSX/PPTX, HTML, TXT (Gemini multimodal handles all).

## Architecture
```
src/commands/doc/
  convert.ts          # parse → upload via Gemini client → request markdown → write
  default-prompt.ts   # exported const
  schemas.ts
  index.ts            # registerDocCommands(program)
```
Reuses: `GeminiClient` from `src/providers/gemini/client.ts`.

## Related Code Files
Create: `src/commands/doc/**`.
Modify: `src/commands/index.ts` — register.

## Implementation Steps
1. `default-prompt.ts`: copy verbatim default prompt from Python source.
2. `schemas.ts`: zod input schema.
3. `convert.ts`: for each input file → upload → call `generateContent({model, prompt, fileUri})` → collect text → write `--output` (or auto-named or default).
4. Multi-file behaviour: when multiple inputs and not `--auto-name`, concatenate with `\n\n---\n\n` separators into single output.
5. Register `doc` group with `convert` subcommand.

## Todo List
- [ ] default-prompt.ts
- [ ] schemas.ts
- [ ] convert.ts
- [ ] register

## Success Criteria
- `multix doc convert -i sample.pdf` (mocked) writes markdown to default output path.
- `--auto-name` produces `<basename>.md`.
- Multi-input concatenation works.

## Risk Assessment
| Risk | L | I | Mitigation |
|------|---|---|-----------|
| Large PDF exceeds Gemini file-size limit | M | M | Surface API error; suggest `multix media optimize` |
| HEIC unsupported on some Gemini regions | L | L | Pass through; let API decide |
| Output overwrites existing file silently | M | L | Print "wrote: <path>" and warn if exists w/o --force? KISS: just overwrite + log |

## Security Considerations
- `GEMINI_API_KEY` env-only.
- Validate input files exist before upload.

## Next Steps
phase-09 mocked tests; phase-10 README usage examples.
