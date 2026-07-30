---
title: For AI agents
description: A compact, reliable way for agents to discover multix capabilities and produce reproducible commands.
---

## Prefer Markdown routes

Every documentation route has the same path with `.md` appended. Fetch those
routes when compact, source-oriented context is more useful than rendered HTML.

```text
https://multix.zuey.me/commands/gemini.md
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
| Analyze or transcribe files | `multix gemini` |
| Generate or edit images, speech, or transcription | `multix openai` |
| Provider-specific image, video, speech, music, or 3D | [Other providers](/commands/providers/) |
| Convert a document or optimize media locally | [Media and documents](/commands/media-and-documents/) |

Treat `--help` and a successful local check as the source of truth when they
differ from any saved documentation.
