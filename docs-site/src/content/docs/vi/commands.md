---
title: Tổng quan lệnh
description: Chọn nhóm lệnh multix phù hợp với workflow media của bạn.
---

## Các lệnh cấp cao nhất

| Lệnh | Dùng cho |
| --- | --- |
| `multix check` | Kiểm tra tool, credential, Gemini connectivity và Codex image. |
| [Gemini](/vi/commands/gemini/) | Phân tích, transcript, extract, tạo ảnh/video và Gemini TTS. |
| [OpenAI](/vi/commands/openai/) | Tạo/chỉnh ảnh, Codex image driver, TTS và transcription. |
| [MiniMax](/vi/commands/minimax/) | Ảnh/video, i2i giữ chủ thể, speech và music. |
| [OpenRouter](/vi/commands/openrouter/) | Image generation/editing và image-to-video async qua routing. |
| [Leonardo](/vi/commands/leonardo/) | Account, models, ảnh/video, upscale và trạng thái job. |
| [BytePlus](/vi/commands/byteplus/) | Seedream, Seedance, reference video và 3D. |
| [Cloudflare](/vi/commands/cloudflare/) | Workers AI image/speech và video job qua AI Gateway. |
| [ElevenLabs](/vi/commands/elevenlabs/) | Voice, TTS, clone, STT, music, SFX, dubbing và isolation. |
| `multix media` | Tối ưu, cắt và batch file bằng ffmpeg/ImageMagick. |
| `multix doc` | Chuyển tài liệu sang Markdown qua Gemini. |

Chạy `multix <group> --help` trước khi tự động hóa. Model và yêu cầu billing của
provider có thể thay đổi độc lập với CLI.

```bash
multix --help
multix gemini --help
multix openai generate --help
```

Xem [danh mục provider](/vi/commands/providers/) để so sánh nhóm lệnh và chọn
trang provider.
