---
title: Media và tài liệu
description: Tối ưu media bằng tool local và chuyển tài liệu sang Markdown với Gemini.
---

## Tiện ích media

`multix media` chọn flow ffmpeg hoặc ImageMagick theo loại input. Dùng output
rõ ràng để không đụng tới file gốc.

```bash
multix media optimize --input video.mp4 --output optimized.mp4 --target-size 100
multix media optimize --input photo.png --output photo.webp --quality 85 --max-width 1920
multix media split --input long-video.mp4 --chunk-duration 3600
multix media batch --input-dir ./source --output-dir ./optimized
```

## Chuyển tài liệu

`multix doc convert` upload tài liệu được hỗ trợ lên Gemini và ghi Markdown.
Dùng `--output` cho đường dẫn xác định hoặc `--auto-name` cho tên tự tạo.

```bash
multix doc convert --input report.pdf --output report.md
multix doc convert --input presentation.pptx --auto-name
```
