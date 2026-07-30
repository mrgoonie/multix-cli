---
title: Lệnh Gemini
description: Dùng Gemini để phân tích đa phương thức, extract tài liệu, tạo ảnh/video và speech.
---

Lệnh Gemini cần `GEMINI_API_KEY`. Chạy `multix gemini <command> --help` trước
khi tự động hóa workflow.

## Analyze, transcribe và extract

Truyền một hoặc nhiều file local bằng `--files`. Khi được hỗ trợ, chọn output
`text`, `json`, `csv` hoặc `markdown`.

```bash
multix gemini analyze --files photo.jpg clip.mp4 --prompt "Describe the scene"
multix gemini transcribe --files interview.mp3 --format markdown
multix gemini extract --files report.pdf --prompt "Extract tables as JSON" --format json
```

## Ảnh và video

`generate` hỗ trợ `--model`, `--aspect-ratio`, `--num-images`, `--size` và
`--output`. `image-to-image` (alias `i2i`) nhận nhiều input `--ref`.

```bash
multix gemini generate --prompt "A mountain lake" --aspect-ratio 16:9 --size 2K
multix gemini i2i --prompt "make it watercolor" --ref ./photo.jpg --ref ./style.png
multix gemini generate-video --prompt "Ocean waves" --resolution 1080p --aspect-ratio 16:9
multix gemini i2v ./first-frame.png --prompt "camera pans left" --last-frame ./last-frame.png
```

Tạo video là experimental và có thể cần bật Google billing. Dùng
`--wait-timeout`, `--download`, `--output` hoặc `--no-thumb` khi phù hợp.

## Speech

Dùng `generate-speech` với `--text` hoặc `--prompt`; lặp `--speaker name:voice`
cho tối đa hai người nói.

```bash
multix gemini generate-speech --text "Welcome to multix." --voice Kore --output-format wav
```
