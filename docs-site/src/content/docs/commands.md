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
| `multix media` | Optimize, split, and batch-process files with ffmpeg/ImageMagick. |
| `multix doc` | Convert supported documents to Markdown through Gemini. |

Run `multix <group> --help` before using a capability in automation. Provider
models and billing requirements change independently of this CLI.

```bash
multix --help
multix gemini --help
multix openai generate --help
```

Use the [provider directory](/commands/providers/) to compare the groups and
choose a provider page.
