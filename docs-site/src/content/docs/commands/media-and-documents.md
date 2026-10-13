---
title: Media and documents
description: Optimize media with local tooling and convert documents to Markdown with Gemini.
---

## Prerequisites

Media commands run local executables: `ffmpeg` handles audio and video, while
the ImageMagick 7 `magick` command handles images. Install both before running
`multix media`.

### macOS (Homebrew)

```bash
brew install ffmpeg imagemagick
```

### Ubuntu or Debian

```bash
sudo apt update
sudo apt install -y ffmpeg imagemagick
```

Some Linux distributions package ImageMagick 6, which exposes `convert` rather
than the required `magick` executable. If the verification below cannot find
`magick`, install ImageMagick 7 using the [official download instructions](https://imagemagick.org/download/).

### Windows (winget)

```powershell
winget install -e --id Gyan.FFmpeg.Shared
winget install -e --id ImageMagick.ImageMagick
```

Open a new terminal after installation, then verify both tools and multix:

```bash
ffmpeg -version
magick -version
multix check
```

For another operating system or package manager, use the [FFmpeg download
page](https://ffmpeg.org/download.html) and [ImageMagick download page](https://imagemagick.org/download/), then ensure `ffmpeg` and `magick` are on `PATH`.

## Media utilities

`multix media` chooses an appropriate ffmpeg or ImageMagick flow from the input
type. Use explicit outputs so original files remain untouched.

Audio is re-encoded to mono 16 kHz with the codec that matches the output
extension: `.mp3` (MP3), `.m4a`/`.aac`/`.mp4`/`.mka`/`.mkv`/`.mov` (AAC),
`.opus`/`.ogg` (Opus), `.wav`/`.aiff` (PCM) or `.flac` (FLAC). `--bitrate`
applies to the lossy formats only. Any other output extension is rejected before
ffmpeg runs. Embedded cover art is dropped, so the output holds audio only.

```bash
multix media optimize --input video.mp4 --output optimized.mp4 --target-size 100
multix media optimize --input photo.png --output photo.webp --quality 85 --max-width 1920
multix media optimize --input voice.wav --output voice.mp3 --bitrate 64k
multix media split --input long-video.mp4 --chunk-duration 3600
multix media batch --input-dir ./source --output-dir ./optimized
```

## Document conversion

`multix doc convert` uploads a supported document to Gemini and writes a
Markdown result. Use `--output` for a deterministic path or `--auto-name` for
a generated output name.

```bash
multix doc convert --input report.pdf --output report.md
multix doc convert --input presentation.pptx --auto-name
```

Pass `-` as the input to read a piped document from stdin. PDFs, images and
text are detected automatically; when the type cannot be detected, pass
`--stdin-ext` (for example `--stdin-ext pdf`). `-` can be given only once per
command; to convert a real file named `-`, write it as `./-`. Piped input is
labelled `<stdin>` in the output and in errors,
`--auto-name` writes `stdin-extraction.md`, and the temporary copy is removed
when the command ends. Without `--output` or `--auto-name` the result goes to
`document-extraction.md` in the output directory, as for regular files.

```bash
cat report.pdf | multix doc convert --input - --output report.md
```

The command requires a configured Gemini key and can be affected by file size,
model availability, and account policy.
