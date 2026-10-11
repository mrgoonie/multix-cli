---
title: Gemini commands
description: Use Gemini for multimodal analysis, document extraction, image/video generation, and speech.
---

Gemini commands require `GEMINI_API_KEY`. Extra keys in `GEMINI_API_KEY_2`, `GEMINI_API_KEY_3`, … are used when a key hits its quota; see [Environment variables](/reference/environment/#gemini-key-rotation). Run `multix gemini <command> --help`
before automating a workflow.

## Analyze, transcribe, and extract

Pass one or more local files with `--files`. Choose `text`, `json`, `csv`, or
`markdown` output where supported. Files over 20 MB are streamed from disk to
the Gemini Files API, which accepts files up to 2 GB (2,000,000,000 bytes); a
larger file is rejected before anything is uploaded. The upload may take as
long as the file needs at 1 MB/s plus one minute (about 35 minutes for 2 GB)
before it times out.

```bash
multix gemini analyze --files photo.jpg clip.mp4 --prompt "Describe the scene"
multix gemini transcribe --files interview.mp3 --format markdown
multix gemini extract --files report.pdf --prompt "Extract tables as JSON" --format json
```

Use `-` as a file name to read piped stdin. The type is detected from the
content (common image, audio, video, PDF and UTF-8 text formats). When it
cannot be detected the command stops and asks for `--stdin-ext`. `-` may appear
once and can be mixed with other files, and results label it `<stdin>`. Piped
input is limited to 2 GB. It is copied to a private temporary file that is
removed when the command finishes or is interrupted with Ctrl+C; a hard kill
can leave it in the system temp folder. If nothing arrives on stdin, a hint is
printed after two seconds. In Windows PowerShell 5.1, piping binary data between
programs corrupts it; use PowerShell 7.4+, cmd or Git Bash instead.

```bash
cat screenshot.png | multix gemini analyze --files - --prompt "What is shown?"
curl -s https://example.com/talk.mp3 | multix gemini transcribe --files - --stdin-ext mp3
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

The default TTS model is `gemini-3.8-flash-lite-tts`. Other supported models
are `gemini-3.8-flash-tts`, `gemini-3.1-flash-tts-preview`,
`gemini-2.5-flash-preview-tts`, and `gemini-2.5-pro-preview-tts` (override
with `--model` or `GEMINI_TTS_MODEL`). The Gemini 3.8 models (`gemini-3.8-flash-tts`,
`gemini-3.8-flash-lite-tts`) read text verbatim and accept a `--style`
delivery direction instead of inline prompt cues:

```bash
multix gemini generate-speech --text "Welcome to multix." \
  --model gemini-3.8-flash-tts --voice Kore --style "cheerful and friendly"
```

`--style` requires a Gemini 3.8 TTS model and is rejected for older models.
