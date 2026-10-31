---
name: document-conversion
description: Convert PDFs, DOCX and images to Markdown with multix doc convert, and analyze, transcribe or extract structured data from media and documents with Gemini text-output models (multix gemini analyze, transcribe, extract). Use for document-to-Markdown, summarizing a video, describing an image, or pulling data out of files.
version: 1.26.0-beta # x-release-please-version
license: MIT
metadata:
  tasks: document, analysis
---

# multix document conversion and analysis

Check verified model capabilities before picking a model: `multix models --task document --ready` (or `--task analysis`) lists each command with its default model and whether its key is set, and `multix models --model <id>` shows a verified model's inputs and example. The capability registry is authoritative; the model ids below are defaults, not a complete list. Agent protocol, keys and output dir: [../SKILL.md](../SKILL.md). Speech-to-text on other providers is in [../speech-production/SKILL.md](../speech-production/SKILL.md#voice-cloning--stt).

## When to use

- Analyze, transcribe, or extract structured data from media/docs
- Convert PDFs / DOCX / images to Markdown

## Gemini text-output tasks

`gemini-3.6-flash` is the default for Gemini analyze, transcribe, extract, and doc conversion. It is text-output only; use Nano Banana for images, Gemini Omni Flash for video, and Gemini Flash TTS for speech. Override analyze/transcribe/extract with `GEMINI_MODEL` or `MULTIMODAL_MODEL`; override doc conversion with `--model`.

```bash
# Transcribe / analyze media
multix gemini analyze --files ./video.mp4 --prompt "Summarize this video"
multix gemini transcribe --files ./audio.mp3
cat ./shot.png | multix gemini analyze --files - --prompt "Describe"   # "-" reads stdin; --stdin-ext <ext> if undetected
```

## Docs → Markdown (Gemini)

```bash
multix doc convert --input report.pdf [--auto-name] [--output ./out.md]
cat report.pdf | multix doc convert --input - --output ./out.md   # "-" reads stdin; --stdin-ext <ext> (e.g. pdf) if undetected
multix doc convert --input report.pdf --auto-name
```

## Environment variables

| Variable | Purpose |
|---|---|
| `GEMINI_MODEL` / `MULTIMODAL_MODEL` | Override Gemini analyze/transcribe/extract defaults (doc convert uses `--model`; default `gemini-3.6-flash`) |
