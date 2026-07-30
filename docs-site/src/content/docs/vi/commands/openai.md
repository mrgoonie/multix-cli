---
title: Lệnh OpenAI
description: Tạo/chỉnh ảnh, tổng hợp giọng nói và transcript audio bằng OpenAI hoặc Codex image driver đã đăng nhập.
---

Lệnh OpenAI API cần `OPENAI_API_KEY`. Chạy `multix openai <command> --help`
trước khi tự động hóa workflow.

## Ảnh

Driver thông thường dùng `OPENAI_API_KEY`. `--driver codex` dùng Codex CLI đã
đăng nhập cho image generation experimental; multix không đăng nhập Codex thay
bạn. `auto` ưu tiên API và fallback khi có thể.

```bash
multix openai generate --prompt "A titanium travel mug" --model gpt-image-2 --size 1024x1024
multix openai generate --prompt "A midnight jazz poster" --driver codex --output poster.png
multix openai i2i --prompt "turn this into a watercolor" --ref ./photo.jpg --output sketch.png
```

## Speech và transcription

Dùng `generate-speech` cho TTS. `diarized_json` cần model hỗ trợ diarization.
Speaker ref có tên phải đi cùng file audio tham chiếu.

```bash
multix openai generate-speech --text "Welcome to multix." --voice alloy --output-format mp3
multix openai transcribe --input meeting.mp3 --format text --language vi
```
