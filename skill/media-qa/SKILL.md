---
name: media-qa
description: Optimize, compress, resize, convert, split and batch-process video, audio and image files with multix (ffmpeg + ImageMagick), and inspect or verify media offline against QA profiles (black or frozen frames, silence, clipping, truncation, loudness, duration, aspect) with sha256-bound receipts, frame extraction and receipt checks. Local only, no provider key or cost.
version: 1.26.0-beta # x-release-please-version
license: MIT
metadata:
  tasks: analysis
---

# multix media optimization and QA

The `media` commands are local utilities, not model-backed tasks, so they have no rows in the model registry. When a model must look at the content (for example frames from `media frames`), check verified models with `multix models --task analysis --ready` and `multix models --model <id>` rather than relying on a static model list. Agent protocol, setup and output dir: [../SKILL.md](../SKILL.md).

## When to use

- Optimize, resize, batch-convert, or split video/audio/image files
- Inspect a media file or QA it offline against a profile (black/frozen frames, silence, clipping, duration, aspect) with a sha256-bound receipt (`multix media inspect|verify|check-receipt`)

## Media optimization (ffmpeg + ImageMagick)

```bash
multix media optimize --input <file> --output <file> [--target-size <MB>] [--quality 85] [--max-width 1920]
multix media optimize --input voice.wav --output voice.mp3 [--bitrate 64k]   # audio codec follows output ext: mp3, m4a/aac/mp4/mka/mkv/mov, opus/ogg, wav/aiff, flac
multix media split --input <video> [--chunk-duration 3600]
multix media batch --input-dir <dir> --output-dir <dir>
```

Quick examples:

```bash
# Compress / split media
multix media optimize --input large.mp4 --output small.mp4 --target-size 50
multix media split --input long-video.mp4 --chunk-duration 600
```

## Inspect and verify media offline (`media inspect|verify|frames|check-receipt|profiles`)

Local only (ffmpeg + ffprobe): no upload, no provider call, no key, no cost. Local paths only (URLs, `concat:`, `pipe:` refused). Missing ffmpeg = `BINARY_MISSING`.

```bash
multix media inspect out.mp4 [--decode] --json      # sha256, magic bytes vs extension, streams, rational fps/timebase, rotation; unknown = null
multix media profiles --json                        # motion-graphics, camera-footage, thumbnail (image), audio — versioned thresholds
multix media verify out.mp4 --profile motion-graphics [--expect-duration 12] [--expect-aspect 9:16] \
  [--allow-black 0-0.5] [--allow-freeze 10-12] [--allow-silence 0-1] [--loudness -14] --receipt-out out.receipt.json --json
multix media frames out.mp4 --output-dir ./frames [--count 9] [--sheet]    # extraction only; frames.json manifest
multix media check-receipt out.receipt.json final.mp4                     # same bytes AND receipt passed
```

- Use `inspect` to see what a file really is before acting on it (an HTML error page saved as `.mp4` reports text, not media). Use `verify` before handing a generated or edited file to the user.
- Receipt (`data`, `multix.media-verify/v1`): `status` pass|fail|incomplete (exit non-zero unless pass). Read `checks[]` (`status`, `threshold`, `measured`, `findings[].start_s/end_s`), `summary`, `not_measured[]`. `incomplete` (timeout, unmeasured check, failed rule, file changed mid-run; a cancelled run exits 129/130/143 (`CANCELLED`) with no receipt) is never a pass: rerun, do not report success.
- Truncation: `decode` fails when the file decodes shorter than its container declares, or a WAV holds fewer bytes than both its `data` chunk and RIFF header declare (`measured.declared_data_bytes`/`present_data_bytes`; present only when the WAV header declared a length, not for a piped/streamed WAV; `media inspect` then lists the truncation in `errors` and exits non-zero). `measured.declared_duration_estimated: true` (raw ac3/AAC, Xing-less mp3) means no length was declared, so a clean cut cannot be detected: do not read a `pass` there as proof the file is complete.
- A receipt is not a content review: `coverage.model_reviewed: false`; A/V sync and content correctness are in `not_measured`. To have a model look, run `media frames`, then pass the frames to `multix gemini analyze` explicitly.
- Intended fades, holds and silences: declare them with `--allow-black|--allow-freeze|--allow-silence <start-end>` (seconds, repeatable) so they are reported as intentional; do not widen ranges to hide real defects. `--allow-black` also covers the freeze a black hold causes.
- Loudness is checked only with `--loudness <LUFS>`; there are no built-in platform targets, so pass the target the user asked for.
- Custom profile: `--profile-file` JSON `{id, version, extends?, media?, checks}` (`null` disables a check). Custom rule: `--rule <script>` reads `multix.media-rule-input/v1` on stdin, prints `{id, version, status: pass|fail|warn|unknown, message?, findings?}`; no shell, only `PATH` in env, 30 s default (`--rule-timeout`).
- After transcode/optimize/remux the bytes change: verify the final file, then `check-receipt` it. Never reuse a source receipt for a derived file. `check-receipt` `engine.current_matches: false` (with a `warnings[]` entry) = the receipt came from a different (e.g. older) verify engine that may miss defects: rerun `media verify` before relying on it.
- `--cache-dir` reuses non-incomplete receipts for identical bytes, profile, expectations, rules and ffmpeg version (only a rule's own file is hashed; clear the cache after changing what it imports). Receipts are unsigned local records. Remote MCP: no `--rule`, `--cache-dir`, `--receipt-out`.
