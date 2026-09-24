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
| [fal.ai](/vi/commands/fal/) | Bất kỳ model queue nào của fal, cộng lệnh tiện lợi image/video. |
| `multix media` | Tối ưu, cắt và batch file bằng ffmpeg/ImageMagick. |
| `multix doc` | Chuyển tài liệu sang Markdown qua Gemini. |
| `multix update` | Tự cập nhật multix lên version mới nhất, hoặc một version cụ thể đã publish. |

Chạy `multix <group> --help` trước khi tự động hóa. Model và yêu cầu billing của
provider có thể thay đổi độc lập với CLI.

```bash
multix --help
multix gemini --help
multix openai generate --help
```

Xem [danh mục provider](/vi/commands/providers/) để so sánh nhóm lệnh và chọn
trang provider.

## Tự cập nhật

```bash
multix update [--check] [--tag <tag>] [--dry-run] [-v]
```

Tự nhận diện cách `multix` được cài (npm, pnpm, yarn hoặc bun global) dựa
trên path của binary đang chạy, rồi chạy đúng lệnh cài tương ứng. `--check`
chỉ so sánh version hiện tại với npm registry, không cài đặt. `--tag <tag>`
cài một dist-tag như `beta` và luôn cài tag đó, bỏ qua so sánh "đã up to
date" áp dụng cho luồng `latest` mặc định. `--dry-run` in lệnh cài đặt thay
vì chạy.
