---
title: Command overview
description: Choose the multix command group that matches your media workflow.
---

## Top-level commands

| Command | Use it for |
| --- | --- |
| `multix check` | Verify tools, credentials, Gemini connectivity, and Codex image availability. |
| [Gemini](/commands/gemini/) | Analyze, transcribe, extract, generate images, generate/edit/extend video, image-to-video, and Gemini TTS. |
| [OpenAI](/commands/openai/) | Image generation/editing, Codex image driver, TTS, and transcription. |
| [MiniMax](/commands/minimax/) | Image/video, subject-preserving image-to-image, speech, and music. |
| [OpenRouter](/commands/openrouter/) | Routed image generation/editing, async image-to-video, TTS, and STT. |
| [Leonardo](/commands/leonardo/) | Account, models, image/video, image-to-image, upscale, and job status. |
| [BytePlus](/commands/byteplus/) | Seedream images, Seedance video, reference video, and 3D assets. |
| [Cloudflare](/commands/cloudflare/) | Workers AI image/speech and AI Gateway video jobs. |
| [ElevenLabs](/commands/elevenlabs/) | Voices, TTS, cloning, STT, music, SFX, dubbing, isolation, and alignment. |
| [Fish Audio](/commands/fish/) | Native Fish Audio TTS (Drama 3 by default), multi-speaker turns, pronunciation dictionaries, and voice models. |
| [fal.ai](/commands/fal/) | Any fal queue model, plus image/video convenience commands. |
| [Atlas Cloud](/commands/atlascloud/) | Any Atlas Cloud model: image, image edit, video, audio, 3D, and resumable async predictions. |
| [Replicate](/commands/replicate/) | Any Replicate model via the direct API, image/video wrappers, and prediction status/cancel. |
| [Runway](/commands/runway/) | Gen-4.5 and Gen-4 Turbo video, Gen-4 images, and task status/cancel. |
| [HeyGen](/commands/heygen/) | Video Agent prompt-to-video, scripted avatar videos, video translation, lipsync, and TTS. |
| [Sume](/commands/sume/) | Images and video (including lip-sync and captions) from Sume's model catalog with one key, cost pre-flight, and job status/cancel. |
| [TopView](/commands/topview/) | Product marketing videos, talking and product avatars, and product shots (Legacy API), plus API Platform models such as Seedance, Wan, and GPT Image 2. |
| [Speech](/commands/speech/) | Text-to-speech on Gemini, OpenAI, ElevenLabs, MiniMax, Atlas Cloud, or Fish Audio with one set of flags, capability checks, and opt-in fallback. |
| [Scenes](/commands/scene/) | Multi-character dialogue audio: voice profiles, per-line cached takes, approval, and stem export. |
| [Catalogue](/commands/catalog/) | Compare providers and models before a run: prices per configuration with source and check date, your usage through multix, ratings, reviews and use-case notes. |
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
