# Brainstorm: BytePlus Provider (Seedream + Seedance 2.0)

## Problem Statement
Add `multix byteplus` provider exposing BytePlus ModelArk models:
- **Seedream 4.0** — image generation (text-to-image, multi-image input/edit)
- **Seedance 2.0** — async video generation (t2v, i2v, reference-to-video)

## API Facts (research)
- Base URL: `https://ark.ap-southeast.bytepluses.com/api/v3`
- Auth: `Authorization: Bearer <key>`
- Image: `POST /images/generations` (OpenAI-compat) — sync, returns image URL/b64. Model `seedream-4-0-250828`. Sizes 1K–4K, JPEG, watermark optional. Rate limit 500 IPM, ~$0.03/image.
- Video: `POST /contents/generations/tasks` (or equivalent) — async, returns `id`. Poll `GET /contents/generations/tasks/{id}` until `succeeded`/`failed`. Models: `seedance-2.0-fast` / `seedance-2.0` / `seedance-2.0-pro`. Resolutions 480p/720p/1080p/2K. Duration 4–15s. Aspect ratios 21:9/16:9/4:3/1:1/3:4/9:16. Audio toggle. Negative prompt, seed, style.
- Reference-to-video: `references[]` array (≤12: 9 img + 3 vid + 3 audio), each `{type, role, url}`.

## Scope (confirmed)
1. `multix byteplus generate` — Seedream image (incl. multi-image input)
2. `multix byteplus video` — Seedance text-to-video (async, default poll+download)
3. `multix byteplus image-to-video <imagePath|url>` (alias `i2v`) — supports local path → upload-or-base64, and URL passthrough
4. `multix byteplus reference-to-video` — multimodal refs (≤12)
5. `multix byteplus status <taskId>` — poll/download a task

## Architecture
Mirror `src/providers/leonardo/` (closest match: image sync + video async poll).

```
src/providers/byteplus/
├── client.ts              # Bearer client, base URL resolver
├── models.ts              # Model IDs, defaults, env constants
├── types.ts               # Request/response types
├── poll.ts                # Task polling (reuse leonardo poll pattern)
├── image-input.ts         # Local-path → base64 / URL passthrough helper
└── commands/
    ├── index.ts           # Subcommand registry → cli.ts
    ├── generate.ts        # Seedream image
    ├── video.ts           # Seedance t2v
    ├── image-to-video.ts  # Seedance i2v (alias i2v)
    ├── reference-to-video.ts  # Seedance multimodal
    └── status.ts          # Task poll/download
```

### ENV Vars
| Var | Purpose |
|---|---|
| `BYTEPLUS_API_KEY` (primary) / `ARK_API_KEY` (fallback) | Auth |
| `BYTEPLUS_BASE_URL` | Override base (default `https://ark.ap-southeast.bytepluses.com/api/v3`) |
| `BYTEPLUS_IMAGE_MODEL` | Default Seedream model |
| `BYTEPLUS_VIDEO_MODEL` | Default Seedance model (default `seedance-2.0`) |

`resolveKey()` chain: `BYTEPLUS_API_KEY` → `ARK_API_KEY`.

### Polling Behavior
- Default: poll until terminal (succeeded/failed), then download to `MULTIX_OUTPUT_DIR`
- `--async` flag → return `taskId` immediately, exit
- `multix byteplus status <id>` → poll once or wait + download (`--download`)
- Backoff: 3s → 15s exponential, timeout default 600s (overridable `--wait-timeout`)

### Image Input Strategy (i2v)
- Detect URL via `^https?://` → pass through
- Local path → read file, base64-encode inline in `references[].data` or use `image_url` field per ARK spec
- Reuse helper across i2v + reference-to-video

## Integration Points
- Register `byteplus` subcommand in `src/cli.ts` (mirror leonardo registration)
- Update `src/commands/check.ts` to detect `BYTEPLUS_API_KEY` / `ARK_API_KEY`
- Setup hints in `src/commands/check-helpers/setup-hints.ts`
- README.md provider list + commands section + env table

## Trade-offs / Risks
- **Doc gaps**: Official BytePlus docs paywall some endpoints; exact video task endpoint path needs first-call verification. Mitigation: code defensively, log raw responses on `-v`, allow `BYTEPLUS_BASE_URL` override.
- **Reference-to-video** is complex (12 refs × 3 types). KISS: ship MVP with `--ref-image`, `--ref-video`, `--ref-audio` repeatable flags + `--role <subject|environment|style|...>` per ref. Defer fancy DSL.
- **Base64 payload size**: large images bloat requests. Warn `>10MB` and recommend URL.
- **Region**: `ap-southeast` may have latency for some users. Document `BYTEPLUS_BASE_URL` override (volcengine.com for China).

## Success Criteria
- `multix check` detects key
- `multix byteplus generate --prompt "..."` produces JPEG in `multix-output/`
- `multix byteplus video --prompt "..."` polls, downloads MP4
- `multix byteplus i2v ./photo.jpg --prompt "..."` works with local file
- `multix byteplus status <id> --download` works after `--async` submission
- Build passes `npm run build`; new tests for client + image-input helper

## Next Steps
- Generate detailed implementation plan via `/ck:plan`
- Phase split suggestion:
  1. Client + models + types + env wiring + check integration
  2. Seedream image generate
  3. Seedance video (t2v) + poll + download
  4. Seedance i2v (with local/URL input helper)
  5. Reference-to-video
  6. Status command + README updates + tests

## Unresolved Questions
- Exact official video endpoint path on ARK (`/contents/generations/tasks` vs OpenAI-compat path)? → resolve at first integration test
- Does Seedream support `aspect_ratio` directly or only `size` (WxH)? → check on first call, accept both flags
- Watermark default — opt-out (`--no-watermark`)?
