---
title: Media and documents
description: Optimize media with local tooling and convert documents to Markdown with Gemini.
---

## Media utilities

`multix media` chooses an appropriate ffmpeg or ImageMagick flow from the input
type. Use explicit outputs so original files remain untouched.

```bash
multix media optimize --input video.mp4 --output optimized.mp4 --target-size 100
multix media optimize --input photo.png --output photo.webp --quality 85 --max-width 1920
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

The command requires a configured Gemini key and can be affected by file size,
model availability, and account policy.
