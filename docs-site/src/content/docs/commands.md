---
title: Command overview
description: Choose the multix command group that matches your media workflow.
---

## Top-level commands

| Command | Use it for |
| --- | --- |
| `multix check` | Verify tools, credentials, Gemini connectivity, and Codex image availability. |
| [Gemini](/commands/gemini/) | Analyze, transcribe, extract, generate images/video, image-to-video, and Gemini TTS. |
| [OpenAI](/commands/openai/) | Image generation/editing, Codex image driver, TTS, and transcription. |
| [MiniMax](/commands/minimax/) | Image/video, subject-preserving image-to-image, speech, and music. |
| [OpenRouter](/commands/openrouter/) | Routed image generation/editing and async image-to-video. |
| [Leonardo](/commands/leonardo/) | Account, models, image/video, image-to-image, upscale, and job status. |
| [BytePlus](/commands/byteplus/) | Seedream images, Seedance video, reference video, and 3D assets. |
| [Cloudflare](/commands/cloudflare/) | Workers AI image/speech and AI Gateway video jobs. |
| [ElevenLabs](/commands/elevenlabs/) | Voices, TTS, cloning, STT, music, SFX, dubbing, isolation, and alignment. |
| [fal.ai](/commands/fal/) | Any fal queue model, plus image/video convenience commands. |
| `multix media` | Optimize, split, and batch-process files with ffmpeg/ImageMagick. |
| `multix doc` | Convert supported documents to Markdown through Gemini. |
| `multix update` | Self-update multix to the latest, or a specific, published version. |

Run `multix <group> --help` before using a capability in automation. Provider
models and billing requirements change independently of this CLI.

```bash
multix --help
multix gemini --help
multix openai generate --help
```

Use the [provider directory](/commands/providers/) to compare the groups and
choose a provider page.

## Self-update

```bash
multix update [--check] [--tag <tag>] [--dry-run] [-v]
```

Detects how `multix` was installed (npm, pnpm, yarn, or bun global) from the
running binary's path and runs the matching install command. `--check` only
compares the current version against the npm registry; it never installs.
`--tag <tag>` installs a dist-tag such as `beta` and always installs it,
skipping the "already up to date" comparison used by the default `latest`
flow. `--dry-run` prints the install command instead of running it.
