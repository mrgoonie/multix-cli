---
title: Command overview
description: Choose the multix command group that matches your media workflow.
---

## Top-level commands

| Command | Use it for |
| --- | --- |
| `multix check` | Verify tools, credentials, Gemini connectivity, and Codex image availability. |
| `multix gemini` | Analyze, transcribe, extract, generate images/video, image-to-video, and Gemini TTS. |
| `multix openai` | Image generation/editing, Codex image driver, TTS, and transcription. |
| `multix minimax` | Image/video, image-to-image, speech, and music. |
| `multix openrouter` | Routed image generation/editing and async video workflows. |
| `multix leonardo` | Account, models, image/video, image-to-image, upscale, and job status. |
| `multix byteplus` | Seedream images, Seedance video, reference video, and 3D assets. |
| `multix elevenlabs` | Voices, TTS, cloning, STT, music, SFX, dubbing, isolation, and alignment. |
| `multix media` | Optimize, split, and batch-process files with ffmpeg/ImageMagick. |
| `multix doc` | Convert supported documents to Markdown through Gemini. |

Run `multix <group> --help` before using a capability in automation. Provider
models and billing requirements change independently of this CLI.

```bash
multix --help
multix gemini --help
multix openai generate --help
```
