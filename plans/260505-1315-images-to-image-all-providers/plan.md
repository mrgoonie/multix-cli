# Image-to-Image Across All Providers

**Branch:** `feat/images-to-image-all-providers`
**Worktree:** `/Volumes/GOON/www/oss/multix-cli-images-to-image`
**Date:** 2026-05-05

## Mission
Add `image-to-image` subcommand to every provider. Input: 1+ reference images (path or URL) + prompt. Output: 1 generated/edited image.

## Decisions (locked)
- **Command name:** `image-to-image` (per user)
- **MiniMax:** ship with `subject_reference`-only caveat in help text
- **BytePlus:** use official `image` array param (already present in `types.ts`)
- **Architecture:** promote `image-input.ts` to `src/core/`, size limits passed as args
- **Phasing:** single PR (small CLI, low risk of one bad provider blocking — already brainstormed 2-PR alt and rejected)

## Per-Provider Capability Matrix
| Provider   | Model / Endpoint                          | Multi-ref | Sync? | Param shape |
|------------|-------------------------------------------|-----------|-------|-------------|
| byteplus   | seedream-4-0 / seededit-3-0 (`image[]`)   | Yes (N)   | Sync  | array of URL/data-url |
| gemini     | gemini-2.5-flash-image (Nano Banana)      | Yes (~3)  | Sync  | inline parts |
| openrouter | google/gemini-2.5-flash-image, flux-kontext | 1 typical | Sync | OR multimodal `image_url` parts |
| leonardo   | image2image / Phoenix (init_image)        | 1         | **Async** | upload init image → id |
| minimax    | image-01 + subject_reference              | 1 (caveat) | Sync | `subject_reference[]` |

## Phases
1. **phase-01** — Promote `image-input.ts` to `src/core/`
2. **phase-02** — `gemini image-to-image`
3. **phase-03** — `byteplus image-to-image`
4. **phase-04** — `openrouter image-to-image`
5. **phase-05** — `leonardo image-to-image` (async, reuse `--wait`/`--download`)
6. **phase-06** — `minimax image-to-image` (with caveat)
7. **phase-07** — Tests, README provider matrix, build verify

## Shared CLI Flags
```
--prompt, -p <text>          required
--ref <path|url>             repeatable; providers capping at 1 error if N>1
--output, -o <path>          optional; default: getOutputDir()/...
--model, -m <name>           provider-specific default
--wait                       leonardo only; poll until ready
--download                   leonardo only; download after wait
```

## Risks
- Gemini ~7MB inline cap → preflight size check
- Leonardo async UX → mirror existing video command pattern (already exists per recent commits)
- MiniMax subject_reference is character preservation, not free-form edit → bold in `--help`
- MIME sniff bytes (don't trust extension)
- 429 / rate limits → existing http-client retry

## Success
- All 5 providers expose `image-to-image` subcommand
- `npm run build` clean, `npm test` passes
- Smoke test at least one provider end-to-end with real API key
- README provider matrix updated

## Open Questions (none — all locked above)
