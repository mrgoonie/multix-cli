# Scout Report: OpenAI Provider Patterns

## Existing Reusable Patterns

- Provider layout:
  - `src/providers/{provider}/client.ts`
  - `src/providers/{provider}/models.ts`
  - `src/providers/{provider}/commands/index.ts`
  - provider command files under `commands/`
- Registration:
  - `src/commands/index.ts` imports `registerXCommands` and calls it in `registerCommands`.
- Env loading:
  - `src/core/env-loader.ts` loads `process.env`, `cwd/.env`, then `~/.multix/.env`.
- HTTP:
  - `src/core/http-client.ts` has `httpJson`, `downloadFile`, `fetchBytes`.
  - Multipart/binary patterns exist in `src/providers/elevenlabs/client.ts`.
- Output:
  - `src/core/output-dir.ts` supplies `MULTIX_OUTPUT_DIR`.
  - Providers save primary output then copy to `--output` when supplied.
- Image input:
  - `src/core/image-input.ts` resolves URL or local path to data URL.
  - OpenAI edits need multipart files, so use the same validation idea but attach bytes. Local refs come from `fs.readFileSync`; URL refs can use `fetchBytes`.
- Tests:
  - Smoke tests spawn compiled `dist/cli.js`.
  - Unit tests mock `globalThis.fetch` via `tests/helpers/mock-fetch.ts`.
  - Existing provider tests live under `tests/unit/providers/{provider}`.
- Release:
  - `.github/workflows/publish.yml` is tag-driven, runs lint/typecheck/build/test, then `npm publish --provenance`.

## Current Overlaps

- Existing plan `plans/260505-1315-images-to-image-all-providers/plan.md` introduced shared i2i pattern and `src/core/image-input.ts`.
- Existing provider release memory says new providers should include help-surface smoke tests and provider registration plus `check.ts`.

## Constraints

- Worktree is currently detached HEAD.
- No `docs/` directory in this checkout; README and plan files are source of truth.
- Keep file sizes under 200 LOC where practical; split helper modules rather than monolithic command files.

## Recommended Files

- `src/providers/openai/client.ts`
- `src/providers/openai/models.ts`
- `src/providers/openai/openai-image.ts`
- `src/providers/openai/openai-audio.ts`
- `src/providers/openai/codex-image-driver.ts`
- `src/providers/openai/commands/{index,generate,image-to-image,generate-speech,transcribe}.ts`
- `tests/unit/providers/openai/*`
- `tests/smoke/*`

## Unresolved Questions

None.
