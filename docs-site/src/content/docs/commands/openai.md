---
title: OpenAI commands
description: Generate and edit images, synthesize speech, and transcribe audio with OpenAI or an authenticated Codex image driver.
---

OpenAI API commands require `OPENAI_API_KEY`. Run `multix openai <command>
--help` before automating a workflow.

## Images

The normal driver uses `OPENAI_API_KEY`. `--driver codex` uses an already logged
in Codex CLI for experimental image generation only; multix never logs Codex in
for you. `auto` prefers the API and falls back when possible.

```bash
multix openai generate --prompt "A titanium travel mug" --model gpt-image-2 --size 1024x1024
multix openai generate --prompt "A midnight jazz poster" --driver codex --output poster.png
multix openai i2i --prompt "turn this into a watercolor" --ref ./photo.jpg --output sketch.png
```

## Speech and transcription

Use `generate-speech` for TTS. `diarized_json` requires a diarization-capable
model. Named speaker references must be paired with reference audio files.

```bash
multix openai generate-speech --text "Welcome to multix." --voice alloy --output-format mp3
multix openai transcribe --input meeting.mp3 --format text --language vi
multix openai transcribe --input call.mp3 --format json \
  --known-speaker-name Alice --known-speaker-reference ./alice.wav
```
