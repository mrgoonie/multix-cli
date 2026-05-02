# Phase 06 — Media Optimizer

## Context
- Plan: [plan.md](plan.md)
- Source: `media_optimizer.py` (506 LOC) — see scout §5.
- Depends on: phase-02.

## Overview
- Priority: P2
- Status: pending
- Goal: port ffmpeg/imagemagick wrappers as `multix media ...`.

## Key Insights
- Source uses ffmpeg for video/audio + Pillow for images. We replace Pillow with `magick` (ImageMagick) shell-out — keeps deps minimal (no native modules).
- All operations are subprocess invocations of ffmpeg/magick via `execa`. No HTTP.
- File-type dispatch by extension; same extension sets as Python (see scout).

## Requirements
Subcommands:
- `multix media optimize --input <file> --output <file> [--target-size <MB>] [--quality <int>] [--max-width <int>] [--bitrate <str>] [--resolution <WxH>] [-v]`
- `multix media split --input <video> [--output-dir <dir>] [--chunk-duration <sec>] [-v]`
- `multix media batch --input-dir <dir> --output-dir <dir> [--quality] [--max-width] [--bitrate] [-v]`

Defaults match Python source: quality 85, max-width 1920, bitrate 64k, chunk 3600s.

## Architecture
```
src/commands/media/
  ffmpeg-runner.ts     # runFfmpeg(args, {verbose}) → execa wrapper, parses errors
  magick-runner.ts     # runMagick(args, {verbose})
  optimize-video.ts
  optimize-audio.ts
  optimize-image.ts
  split-video.ts
  batch.ts
  detect-type.ts       # extToKind(ext): "video"|"audio"|"image"|undefined
  schemas.ts
  index.ts             # registerMediaCommands(program)
```

## Related Code Files
Create: `src/commands/media/**`.
Modify: `src/commands/index.ts` — register.

## Implementation Steps
1. `detect-type.ts`: extension Sets per type.
2. `ffmpeg-runner.ts` / `magick-runner.ts`: wrap `execa("ffmpeg",[...])` capturing stderr; throw `ProviderError` on non-zero exit; preflight check that binary on PATH.
3. `optimize-video.ts`: build ffmpeg args (CRF from quality, scale filter from resolution, target-size two-pass if set).
4. `optimize-audio.ts`: ffmpeg `-b:a <bitrate>`.
5. `optimize-image.ts`: `magick input -resize <max-width>x -quality <q> output`.
6. `split-video.ts`: ffmpeg `-f segment -segment_time <chunk-duration> -c copy output_%03d.<ext>`.
7. `batch.ts`: glob input-dir, dispatch by extension.
8. `commands.ts` parsers wire each.

## Todo List
- [ ] detect-type.ts
- [ ] ffmpeg-runner.ts
- [ ] magick-runner.ts
- [ ] optimize-video.ts
- [ ] optimize-audio.ts
- [ ] optimize-image.ts
- [ ] split-video.ts
- [ ] batch.ts
- [ ] schemas + register

## Success Criteria
- `multix media --help` lists 3 subcommands.
- Missing-binary error names which binary is missing and how to install.
- Unit test: `detectType(".mp4")==="video"` etc.

## Risk Assessment
| Risk | L | I | Mitigation |
|------|---|---|-----------|
| ffmpeg/magick not installed | H | H | Preflight check, friendly install hint per OS |
| Two-pass target-size flaky on small inputs | M | L | Fallback to single-pass with computed bitrate |
| Windows path quoting in args | M | M | Pass args as array (execa) — no shell parsing |
| Stderr noise treated as error | M | L | Only check exit code, log stderr at -v |

## Security Considerations
- Validate `--input`/`--input-dir` paths exist before exec.
- Reject `--output` paths that resolve outside cwd unless absolute.
- No shell interpolation — execa array form throughout.

## Next Steps
phase-09 unit tests; phase-10 README documents prereqs.
