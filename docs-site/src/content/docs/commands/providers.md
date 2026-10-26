---
title: Provider directory
description: Choose a source-backed command reference for any multix AI provider.
---

## Provider pages

| Provider | Start here | Use it for | Constraint to remember |
| --- | --- | --- | --- |
| Gemini | [Commands](/commands/gemini/) | Analysis, image/video, and TTS | Video uses Gemini Omni Flash and needs a billing-enabled key. |
| OpenAI | [Commands](/commands/openai/) | Image, TTS, and STT | Codex is an experimental image-only driver. |
| MiniMax | [Commands](/commands/minimax/) | Image, video, TTS, and music | `i2i` preserves a subject for a new scene; it does not edit an input image. |
| OpenRouter | [Commands](/commands/openrouter/) | Routed image, image-to-video, TTS, and STT models | i2v first/last frames are HTTPS URLs and jobs can be polled. |
| Leonardo | [Commands](/commands/leonardo/) | Image, video, upscaling, and account tools | i2i/i2v work with existing Leonardo image IDs. |
| BytePlus | [Commands](/commands/byteplus/) | Seedream, Seedance, reference video, and 3D | Use `status` after an async submission. |
| Cloudflare | [Commands](/commands/cloudflare/) | Workers AI image/speech and AI Gateway video | Video needs an AI Gateway ID and Replicate token. |
| ElevenLabs | [Commands](/commands/elevenlabs/) | Voice, speech, audio, and dubbing | Dubbing has a job/status workflow. |
| fal.ai | [Commands](/commands/fal/) | Any queue model, plus image/video convenience commands | Status/result use the model's app id (first two path segments), not the full model id. |
| Atlas Cloud | [Commands](/commands/atlascloud/) | Any model: image, image edit, video, audio, and 3D | Inputs are validated against each model's schema; `--async` plus `status --wait --download` resumes a job. |
| Replicate | [Commands](/commands/replicate/) | Any model via the direct API, plus image/video convenience commands | Community models need a version; resume or cancel jobs by prediction ID. |
| Runway | [Commands](/commands/runway/) | Gen-4.5 / Gen-4 Turbo video and Gen-4 images | `video` prints a task ID unless `--wait`; resume with `status <id> --wait --download`. |
| HeyGen | [Commands](/commands/heygen/) | Video Agent (prompt-to-video), scripted avatar video, translation, lipsync, TTS, templates | API credits are billed separately from HeyGen web plans; use `status --type` matching the job (`agent` takes a session ID). |

Use `multix <provider> --help` and the specific subcommand's `--help` before
automating a workflow. Those commands own current options and defaults.
