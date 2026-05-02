# Plan: Port Leonardo.Ai commands into multix CLI

**Mode:** `xia --port` | **Risk:** LOW | **Owner:** main agent

## Source Manifest
- Repo: `git@github.com:mrgoonie/leonardo-cli.git`
- Local clone: `D:/www/oss/leonardo-cli`
- Source tree scope: `src/cli.ts`, `src/api/*`, `src/commands/*`, `src/utils/poll.ts`
- Dropped from source: `src/config/*`, `src/utils/{log,output}.ts`, `src/commands/config.ts` (replaced by multix core)
- License: MIT (compatible)

## Source Anatomy
| Source file | LOC | Role |
|---|---|---|
| `src/cli.ts` | 66 | Commander root, error-code mapping |
| `src/api/client.ts` | 79 | fetch wrapper, `v2:` path prefix → swap base, Bearer auth, `LeonardoApiError` |
| `src/api/types.ts` | 92 | request/response types for image/video/upscale/me/models |
| `src/commands/generate.ts` | 166 | image generate; v1 SD + v2 GPT-image fork; inline poll; download |
| `src/commands/video.ts` | 87 | text-to-video; v1 enum + v2 string models; returns jobId |
| `src/commands/upscale.ts` | 85 | universal upscaler + variation fetch |
| `src/commands/status.ts` | 40 | poll a generationId once |
| `src/commands/me.ts` | 40 | user info / token balance |
| `src/commands/models.ts` | 36 | list image platform models |
| `src/commands/video-models.ts` | 46 | static enum of video models |
| `src/utils/poll.ts` | 43 | generic polling helper |

## Dependency Matrix
| Concern | Source | Multix equivalent | Action |
|---|---|---|---|
| HTTP | bare `fetch` + custom error | `core/http-client.ts` (`httpJson`, `downloadFile`) | EXISTS — wrap thinly |
| API key | layered config + env | `core/env-loader.resolveKey` | EXISTS — drop file config |
| Logger | picocolors + json mode | `core/logger.createLogger` | EXISTS — reuse |
| Output dir | `resolveOutputTarget()` | `core/output-dir.getOutputDir` | EXISTS — adapt |
| Errors | `LeonardoApiError` | `core/errors.ProviderError` + `HttpError` | EXISTS — reuse |
| Poll | `src/utils/poll.ts` | none | NEW — port as `providers/leonardo/poll.ts` |
| Commands registry | flat | `commands/index.ts` registers grouped | EXISTS — add `registerLeonardoCommands` |

## Decision Matrix
| Decision | Source | Multix | Recommendation |
|---|---|---|---|
| Config | JSON + dotenv layered | env-only | env-only (consistency) |
| Output mode | `--json` + human | human | drop `--json` |
| Global flags | `--api-key`, `--base-url` | env | env-only |
| Command grouping | flat | nested | `multix leonardo <sub>` |
| Default model | `leonardo.config.json` | env | `LEONARDO_DEFAULT_MODEL` env |
| Output | `-o file\|dir` + `-d dir` | `--output <path>` + `MULTIX_OUTPUT_DIR` | adopt multix |
| Inline poll | yes (generate) | yes (MiniMax) | keep |

## Target Structure
```
src/providers/leonardo/
├── client.ts             # thin client over core/http-client (Bearer + v2: prefix)
├── poll.ts               # ported from src/utils/poll.ts
├── models.ts             # default model + video-models enum + env defaults
├── types.ts              # API types (subset)
└── commands/
    ├── index.ts          # registerLeonardoCommands → multix leonardo *
    ├── generate.ts       # image (v1 + v2 GPT-image fork; poll + download)
    ├── video.ts          # text-to-video (v1 enum + v2 string)
    ├── upscale.ts        # upscale + variation
    ├── status.ts         # poll generationId once
    ├── me.ts             # account info
    ├── models.ts         # GET /platformModels
    └── video-models.ts   # static enum
```

## Files to Create
- `src/providers/leonardo/client.ts`
- `src/providers/leonardo/poll.ts`
- `src/providers/leonardo/models.ts`
- `src/providers/leonardo/types.ts`
- `src/providers/leonardo/commands/index.ts`
- `src/providers/leonardo/commands/generate.ts`
- `src/providers/leonardo/commands/video.ts`
- `src/providers/leonardo/commands/upscale.ts`
- `src/providers/leonardo/commands/status.ts`
- `src/providers/leonardo/commands/me.ts`
- `src/providers/leonardo/commands/models.ts`
- `src/providers/leonardo/commands/video-models.ts`
- `tests/leonardo.smoke.test.ts` — happy-path call mocking `globalThis.fetch`

## Files to Modify
- `src/commands/index.ts` — add `registerLeonardoCommands`
- `README.md` — document `multix leonardo *` commands and env vars
- `package.json` keywords — add `leonardo`, `leonardo-ai`

## Env Vars (new)
- `LEONARDO_API_KEY` (required)
- `LEONARDO_BASE_URL` (default `https://cloud.leonardo.ai/api/rest/v1`)
- `LEONARDO_DEFAULT_MODEL` (default Lucid Origin UUID `7b592283-e8a7-4c5a-9ba6-d18c31f258b9`)
- `LEONARDO_VIDEO_MODEL` (default `MOTION2`)

## Implementation Steps
1. **client.ts** — port `LeonardoClient` using `httpJson`. Keep `v2:` path-prefix swap. Throw `ProviderError` on `base_resp`-like failures (or just rely on `HttpError` from `httpJson`).
2. **poll.ts** — port `poll<T>()` verbatim (it's already generic and dependency-free).
3. **models.ts / types.ts** — copy enums and types; gate defaults via env.
4. **commands/me.ts**, **models.ts**, **video-models.ts** — simplest, port first.
5. **commands/status.ts** — single GET, no polling.
6. **commands/upscale.ts** — POST + sibling `variation` GET.
7. **commands/video.ts** — POST with v1/v2 fork; print jobId; suggest `multix leonardo status <id>`.
8. **commands/generate.ts** — most complex; v1/v2 fork, inline poll, download via `downloadFile`. Output: copy first image to `--output <path>` if given, else save all to `getOutputDir()` with `leonardo-<id>-<i>.<ext>` naming.
9. **commands/index.ts** — register all under `multix leonardo`.
10. **src/commands/index.ts** — wire `registerLeonardoCommands(program)`.
11. **README.md** — add Leonardo section.
12. **tests** — smoke test on `me` and `models` mocking `globalThis.fetch`.
13. **build + typecheck + lint + test** — verify CI green.

## Acceptance / Success Criteria
- `npm run build && npm run typecheck && npm run lint && npm run test` all pass.
- `multix leonardo --help` lists: `generate, video, video-models, upscale, variation, status, me, models`.
- `multix leonardo me` (with `LEONARDO_API_KEY` set) returns user info.
- `multix leonardo generate "a cat"` polls then writes to `multix-output/leonardo-<id>-01.<ext>`.
- All v1 and v2 endpoints (incl. GPT-image) reachable.
- No regression to existing `multix gemini|minimax|openrouter|media|doc` commands.

## Rollback
- Single-commit feature; revert via `git revert <sha>`.
- No DB / external state; no breaking change to existing public exports.

## Risks
| Risk | Mitigation |
|---|---|
| Leonardo API shape drift | port types as `interface ... { [k: string]: unknown }` permissive; smoke-test only the endpoints we hit |
| GPT-image string-check brittleness | comment + isolated branch; easy to extend |
| Polling timeout defaults differ from source (480s) | preserve 480s default; allow `--wait-timeout` flag |
| Concurrent download failures | already handled in source via `.catch` returning 0 bytes |

## Unresolved Questions
- Add `--json` machine-readable mode now or wait for multix-wide flag? **Default: wait.**
- Add `image-to-video` (v1 endpoint exists in source code as `i2v` enum but no CLI subcommand in leonardo-cli either). **Default: skip — out of scope for the port.**
- Add `multix leonardo config` parity? **Default: skip — env-only is the multix way.**
