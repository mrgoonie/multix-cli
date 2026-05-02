# Phase 04 — MiniMax Provider

## Context
- Plan: [plan.md](plan.md)
- Source: `minimax_cli.py`, `minimax_generate.py`, `minimax_api_client.py` — see scout §3.
- Depends on: phase-02.

## Overview
- Priority: P1
- Status: pending
- Goal: port MiniMax image/video/speech/music generation as `multix minimax ...`.

## Key Insights
- Base URL: `https://api.minimax.io/v1`. Bearer auth.
- Video is async — submit task → poll status endpoint until DONE → fetch download URL → save.
- Image is sync — returns URL list → download.
- Speech returns base64 hex audio in JSON — decode and write.
- Music returns hex-encoded audio similarly.
- Defaults per task: image=`image-01`, video=`MiniMax-Hailuo-2.3`, speech=`speech-2.8-hd`, music=`music-2.5`.

## Requirements
Subcommands:
- `multix minimax generate --prompt --model --aspect-ratio --num-images --output -v`
- `multix minimax generate-video --prompt --model --duration {6,10} --resolution {720P,1080P} --first-frame <url> --output -v`
- `multix minimax generate-speech (--text|--prompt) --model --voice --emotion --output-format {mp3,wav,flac,pcm} --output -v`
- `multix minimax generate-music (--lyrics|--prompt) --model --output-format --output -v`

## Architecture
```
src/providers/minimax/
  client.ts          # apiPost(endpoint, payload), pollAsyncTask(taskId), downloadResult
  models.ts          # IMAGE/VIDEO/SPEECH/MUSIC sets, TASK_DEFAULTS map
  schemas.ts         # zod per task
  generators/
    image.ts
    video.ts
    speech.ts
    music.ts
  commands/
    generate.ts
    generate-video.ts
    generate-speech.ts
    generate-music.ts
    index.ts         # registerMinimaxCommands(program)
```

## Related Code Files
Create: `src/providers/minimax/**` files above.
Modify: `src/commands/index.ts` — register.

## Implementation Steps
1. `models.ts`: export model Sets + TASK_DEFAULTS.
2. `client.ts`: `apiPost`, `pollAsyncTask(taskId, {intervalMs=3000, timeoutMs=600_000})`, `downloadFile` wrapper.
3. `generators/*.ts`: one function per task, return `Result`.
4. `commands/*.ts`: parse, call generator, print.
5. Register subgroup `minimax` with 4 subcommands.

## Todo List
- [ ] models.ts
- [ ] client.ts (api-post + polling)
- [ ] generators/image.ts
- [ ] generators/video.ts
- [ ] generators/speech.ts
- [ ] generators/music.ts
- [ ] schemas.ts
- [ ] commands/* + register

## Success Criteria
- `multix minimax --help` lists 4 subcommands.
- Async polling test with mocked fetch resolves on second poll.
- Defaults applied when `--model` omitted.

## Risk Assessment
| Risk | L | I | Mitigation |
|------|---|---|-----------|
| Video poll never completes | M | H | Hard timeout 10 min (configurable); fail with clear error |
| Audio hex decode size large | L | M | Stream-write decoded buffer in chunks |
| Aspect-ratio enum drift from API | M | L | Mirror Python source enum exactly |
| Rate limit (429) | M | M | Surface verbatim; document in README |

## Security Considerations
- `MINIMAX_API_KEY` env-only.
- Redact in logs.
- Validate `--first-frame` URL is http(s) before passing through.

## Next Steps
phase-09 covers tests; phase-10 README documents commands.
