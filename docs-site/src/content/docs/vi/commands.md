---
title: Tổng quan lệnh
description: Chọn nhóm lệnh multix phù hợp với workflow media của bạn.
---

## Các lệnh cấp cao nhất

| Lệnh | Dùng cho |
| --- | --- |
| `multix check` | Kiểm tra tool, credential, Gemini connectivity và Codex image. |
| `multix gemini` | Phân tích, transcript, extract, tạo ảnh/video và Gemini TTS. |
| `multix openai` | Tạo/chỉnh ảnh, Codex image driver, TTS và transcription. |
| `multix minimax` | Ảnh/video, image-to-image, speech và music. |
| `multix openrouter` | Image generation/editing và video async thông qua routing. |
| `multix leonardo` | Account, models, ảnh/video, upscale và trạng thái job. |
| `multix byteplus` | Seedream, Seedance, reference video và 3D. |
| `multix elevenlabs` | Voice, TTS, clone, STT, music, SFX, dubbing và isolation. |
| `multix media` | Tối ưu, cắt và batch file bằng ffmpeg/ImageMagick. |
| `multix doc` | Chuyển tài liệu sang Markdown qua Gemini. |

Chạy `multix <group> --help` trước khi tự động hóa. Model và yêu cầu billing của
provider có thể thay đổi độc lập với CLI.

```bash
multix --help
multix gemini --help
multix openai generate --help
```
