# Phase 02 — Shared Core

## Context
- Plan: [plan.md](plan.md)
- Scout: [scout-260502-1544-source-scripts.md](../reports/scout-260502-1544-source-scripts.md)
- Blocks: phases 03-08.

## Overview
- Priority: P0
- Status: pending
- Goal: shared utilities all providers/commands depend on.

## Key Insights
- Python source uses a layered env-resolver (process.env → skill .env → skills/.env → claude/.env). For standalone npm we collapse to: process.env → cwd `.env` → `~/.multix/.env`. Process env always wins.
- All providers return `{status, ...}` dicts — mirror with discriminated union `Result<T> = {status:"success", ...T} | {status:"error", error:string}`.
- Output dir defaults to `./multix-output/` (override `MULTIX_OUTPUT_DIR`); created lazily.

## Requirements
Functional:
- `loadEnv()` — single call at CLI start; respects priority.
- `resolveKey(name)` — returns `string | undefined`.
- `getOutputDir()` — ensures dir exists, returns absolute Path.
- `httpJson({url, method, headers, body, timeoutMs})` — undici-based, throws `HttpError` with status+body snippet.
- `downloadFile(url, dest)` — streams, `mkdir -p` parent.
- `logger` — verbose-aware (`info|warn|error|success|debug`); colour via simple ANSI (no chalk dep — KISS).
- `MultixError` base class + `ConfigError`, `ProviderError`, `ValidationError`.

Non-functional:
- Zero runtime deps beyond `dotenv`, `undici`, `zod`, `execa` (already added).
- Each module <150 LOC.

## Architecture
```
src/core/
  env-loader.ts          # loadEnv(), resolveKey()
  output-dir.ts          # getOutputDir()
  http-client.ts         # httpJson(), downloadFile(), HttpError
  logger.ts              # createLogger({verbose})
  errors.ts              # MultixError + subclasses
  result.ts              # Result<T> type + helpers ok()/err()
  index.ts               # barrel
```
Data flow: CLI invokes `loadEnv()` once → command handlers call `resolveKey()` + `getOutputDir()` → providers use `httpJson` + return `Result`.

## Related Code Files
Create: `src/core/env-loader.ts`, `output-dir.ts`, `http-client.ts`, `logger.ts`, `errors.ts`, `result.ts`, `index.ts`.
Modify: `src/cli.ts` — call `loadEnv()` before `parseAsync`.

## Implementation Steps
1. `errors.ts`: `class MultixError extends Error { constructor(msg, public code: string) }`; subclasses set code.
2. `result.ts`: type + `ok(data)` / `err(message)` constructors.
3. `env-loader.ts`: read `process.env` first (snapshot), then `dotenv.config({path: .env})` if exists, then `~/.multix/.env`. Never overwrite already-set vars.
4. `output-dir.ts`: `getOutputDir()` returns `process.env.MULTIX_OUTPUT_DIR ?? path.resolve("multix-output")`; mkdir recursive sync on first call (memoize).
5. `http-client.ts`:
   ```ts
   export async function httpJson<T>(opts: {...}): Promise<T>
   ```
   uses `fetch` from undici, `AbortSignal.timeout(timeoutMs)` default 120_000, throws `HttpError(status, snippet, url)`.
   `downloadFile(url, dest)` — pipe `response.body` to `fs.createWriteStream`.
6. `logger.ts`: factory; ANSI codes constants; methods become no-ops at non-verbose level for `debug`.
7. `index.ts`: re-export all public API.
8. Wire `loadEnv()` into `src/cli.ts` early.

## Todo List
- [ ] errors.ts
- [ ] result.ts
- [ ] env-loader.ts
- [ ] output-dir.ts
- [ ] http-client.ts
- [ ] logger.ts
- [ ] core barrel
- [ ] cli.ts: call loadEnv()

## Success Criteria
- `import { resolveKey, httpJson, getOutputDir } from "./core/index.js"` typechecks.
- Unit tests (in phase-09) cover env precedence + Result helpers.
- No file >150 LOC.

## Risk Assessment
| Risk | L | I | Mitigation |
|------|---|---|-----------|
| dotenv overwrite already-set env | M | H | Use `override:false` (dotenv default) |
| Stream backpressure on big downloads | L | M | use `pipeline()` from `node:stream/promises` |
| Windows path edge cases for output dir | M | L | Use `path.resolve` + `fs.mkdirSync({recursive:true})` |

## Security Considerations
- Never log full API keys — `logger` exposes `redact(str)` helper that masks all but first 6 / last 4.
- HTTP error snippet truncated to 500 chars to avoid leaking large response bodies.

## Next Steps
Unblocks all provider/command phases. After all consumers land, phase-09 adds test coverage.
