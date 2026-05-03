---
phase: 3
title: "Seedance text-to-video"
status: completed
priority: P1
effort: "4h"
dependencies: [1]
---

# Phase 3: Seedance text-to-video

## Overview
`multix byteplus video --prompt "..."` — async Seedance 2.0 t2v. Default: poll task until terminal, download MP4. `--async` returns taskId immediately.

## Requirements
- Submit task → returns `id`
- Poll status with backoff until `succeeded` / `failed` / `cancelled`
- Download MP4 to `MULTIX_OUTPUT_DIR/byteplus-video-{ts}.mp4`
- Configurable: model, resolution, duration, aspect_ratio, audio, seed, negative_prompt
- `--async` flag → print taskId and exit
- `--wait-timeout` (ms) configurable, default 600000

## Architecture
**Endpoint** (per ARK ModelArk video API): `POST {base}/contents/generations/tasks`.
Request body shape (verify on first call; this is the dominant pattern in BytePlus docs):
```json
{
  "model": "seedance-2.0",
  "content": [
    {"type": "text", "text": "prompt --rs 1080p --dur 8 --rt 16:9 --wm true"}
  ]
}
```
ARK passes generation params as flags inside the prompt text (e.g. `--rs`, `--dur`, `--rt`, `--cf`, `--seed`, `--wm`). Alternative: top-level `parameters` object — capture both styles in `types.ts` and pick at runtime.

Polling: `GET {base}/contents/generations/tasks/{id}`. Response includes `status` (`queued`|`running`|`succeeded`|`failed`|`cancelled`) and on success `content.video_url`.

**Reuse `poll()` from `src/providers/leonardo/poll.ts`** directly (decision: validation session 1). Wrap with done/failed predicates — no new poll file.

## Related Code Files
<!-- Updated: Validation Session 1 - reuse leonardo poll(); flag-in-prompt body default -->
**Create:**
- `src/providers/byteplus/generators/video.ts` — `submitVideoTask`, `waitForVideoTask` (wraps leonardo `poll()`), `downloadVideo`, `buildVideoTaskBody`
- `src/providers/byteplus/commands/video.ts` — Commander subcommand

**Modify:**
- `src/providers/byteplus/commands/index.ts` — register `video`
- `src/providers/byteplus/types.ts` — `VideoTaskRequest`, `VideoContentItem`, `VideoTaskStatus`

## Implementation Steps
1. Build `buildVideoTaskBody({ model, prompt, resolution, duration, aspectRatio, audio, seed, negativePrompt, paramsMode })`:
   - When `paramsMode === "flags"` (default, env `BYTEPLUS_VIDEO_PARAMS_MODE` unset or `flags`): append `--rs <res> --dur <n> --rt <ratio> --cf <bool> --seed <n>` to the prompt text inside `content[0].text`. Negative prompt prefix: `negative: "..."` or per ARK convention.
   - When `paramsMode === "structured"`: emit top-level `parameters` object with the same keys.
2. Build `submitVideoTask(client, body) → { id }` — POST to `/contents/generations/tasks`.
3. Build `waitForVideoTask(client, id, { intervalMs, maxAttempts, logger })` that calls `poll()` from `leonardo/poll.ts`:
   - `fetch`: `GET /contents/generations/tasks/{id}`
   - `done`: `status === "succeeded"`
   - `failed`: `status === "failed" || status === "cancelled"`
   - Defaults: `intervalMs=4000`, `maxAttempts=120` (≈8 min) — match leonardo defaults.
4. Build `downloadVideo(url, outputPath, logger)` — stream to disk via existing http-client util or `node:https`.
5. Commander wiring: `video --prompt <p> --model <m> --resolution <480p|720p|1080p|2k> --duration <4-15> --aspect-ratio <r> --audio --no-audio --seed <n> --negative <text> --async --wait-timeout <ms> --output <path> -v`. `--wait-timeout` translates to `maxAttempts = ceil(timeout / intervalMs)`.
6. Success path prints: model, taskId, elapsed, output path. `--async` path prints just taskId + hint to run `multix byteplus status <id>`.
7. Error path: 4xx → ConfigError-like surface; `PollFailedError` → log full task payload at `-v`; `PollTimeoutError` → suggest `--async` mode.

## Success Criteria
- [ ] `multix byteplus video --prompt "ocean waves" --duration 5` produces an MP4 in `multix-output/`
- [ ] `--async` returns taskId in <2s
- [ ] `--wait-timeout 30000` aborts cleanly with timeout error
- [ ] Failed tasks surface error reason
- [ ] Polling backs off (3s → 4.5s → ... cap 15s)
- [ ] Build + tests pass

## Risk Assessment
- **Endpoint/body shape uncertainty**: official ARK video API may use either flag-in-prompt OR structured `parameters`. Mitigation: feature-flag both, default to flag-in-prompt (most common in docs); add `BYTEPLUS_VIDEO_PARAMS_MODE=flags|structured` env override.
- **Polling cost**: aggressive polling burns rate limits. Backoff curve protects.
- **Download size**: 1080p MP4 can be 50MB+. Stream rather than buffer in memory.
