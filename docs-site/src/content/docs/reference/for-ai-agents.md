---
title: For AI agents
description: A compact, reliable way for agents to discover multix capabilities and produce reproducible commands.
---

## Prefer Markdown routes

Every documentation route has the same path with `.md` appended. Fetch those
routes when compact, source-oriented context is more useful than rendered HTML.

```text
https://multix.zuey.me/commands/gemini.md
https://multix.zuey.me/commands/minimax.md
https://multix.zuey.me/reference/environment.md
https://multix.zuey.me/llms.txt
```

## Safe command workflow

1. Read the relevant command page, then use `multix <group> <command> --help`
   for the installed version.
2. Run `multix check` before a provider operation; do not print or request
   secret values.
3. Use explicit `--input`, `--output`, and provider flags when reproducibility
   matters.
4. State whether a provider operation is asynchronous and retain any job ID.

## Capability map

| Need | Start with |
| --- | --- |
| Analyze or transcribe files | [Gemini](/commands/gemini/) |
| Generate or edit images, speech, or transcription | [OpenAI](/commands/openai/) |
| MiniMax image, video, speech, or music | [MiniMax](/commands/minimax/) |
| Routed image or image-to-video | [OpenRouter](/commands/openrouter/) |
| Leonardo image IDs, video, or upscale jobs | [Leonardo](/commands/leonardo/) |
| Seedream, Seedance, reference video, or 3D | [BytePlus](/commands/byteplus/) |
| Workers AI image/speech or AI Gateway video | [Cloudflare](/commands/cloudflare/) |
| Voice workflows, dubbing, or generated audio | [ElevenLabs](/commands/elevenlabs/) |
| Any fal.ai queue model, image, or video | [fal.ai](/commands/fal/) |
| Convert a document or optimize media locally | [Media and documents](/commands/media-and-documents/) |
| Self-update the CLI | [Command overview](/commands/#self-update) |

Treat `--help` and a successful local check as the source of truth when they
differ from any saved documentation.
