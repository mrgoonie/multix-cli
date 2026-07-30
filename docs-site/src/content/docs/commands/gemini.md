---
title: Gemini commands
description: Use Gemini for multimodal analysis, document extraction, image/video generation, and speech.
---

## Analyze, transcribe, and extract

Pass one or more local files with `--files`. Choose `text`, `json`, `csv`, or
`markdown` output where supported.

```bash
multix gemini analyze --files photo.jpg clip.mp4 --prompt "Describe the scene"
multix gemini transcribe --files interview.mp3 --format markdown
multix gemini extract --files report.pdf --prompt "Extract tables as JSON" --format json
```

## Images and video

`generate` supports `--model`, `--aspect-ratio`, `--num-images`, `--size`, and
`--output`. `image-to-image` (alias `i2i`) accepts repeated `--ref` inputs.

```bash
multix gemini generate --prompt "A mountain lake" --aspect-ratio 16:9 --size 2K
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg --ref ./style.png
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p --aspect-ratio 16:9
multix gemini i2v ./first-frame.png --prompt "camera pans left" --last-frame ./last-frame.png
```

Video generation is experimental and can require enabled Google billing. Use
`--wait-timeout`, `--download`, `--output`, or `--no-thumb` when applicable.

## Speech

Use `generate-speech` with `--text` or `--prompt`; repeat `--speaker name:voice`
for up to two speakers.

```bash
multix gemini generate-speech --text "Welcome to multix." --voice Kore --output-format wav
multix gemini generate-speech --text "Joe: Hi. Jane: Hello." --speaker Joe:Kore --speaker Jane:Puck
```
