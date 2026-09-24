---
title: Provider directory
description: Choose a source-backed command reference for any multix AI provider.
---

## Provider pages

| Provider | Start here | Use it for | Constraint to remember |
| --- | --- | --- | --- |
| Gemini | [Commands](/commands/gemini/) | Analysis, image/video, and TTS | Video commands are experimental. |
| OpenAI | [Commands](/commands/openai/) | Image, TTS, and STT | Codex is an experimental image-only driver. |
| MiniMax | [Commands](/commands/minimax/) | Image, video, TTS, and music | `i2i` preserves a subject for a new scene; it does not edit an input image. |
| OpenRouter | [Commands](/commands/openrouter/) | Routed image and image-to-video models | i2v first/last frames are HTTPS URLs and jobs can be polled. |
| Leonardo | [Commands](/commands/leonardo/) | Image, video, upscaling, and account tools | i2i/i2v work with existing Leonardo image IDs. |
| BytePlus | [Commands](/commands/byteplus/) | Seedream, Seedance, reference video, and 3D | Use `status` after an async submission. |
| Cloudflare | [Commands](/commands/cloudflare/) | Workers AI image/speech and AI Gateway video | Video needs an AI Gateway ID and Replicate token. |
| ElevenLabs | [Commands](/commands/elevenlabs/) | Voice, speech, audio, and dubbing | Dubbing has a job/status workflow. |
| fal.ai | [Commands](/commands/fal/) | Any queue model, plus image/video convenience commands | Status/result use the model's app id (first two path segments), not the full model id. |

Use `multix <provider> --help` and the specific subcommand's `--help` before
automating a workflow. Those commands own current options and defaults.
