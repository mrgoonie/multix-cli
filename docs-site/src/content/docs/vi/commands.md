---
title: Tổng quan lệnh
description: Chọn nhóm lệnh multix phù hợp với workflow media của bạn.
---

## Các lệnh cấp cao nhất

| Lệnh | Dùng cho |
| --- | --- |
| `multix check` | Kiểm tra tool, credential, Gemini connectivity và Codex image. |
| [Gemini](/vi/commands/gemini/) | Phân tích, transcript, extract, tạo ảnh, tạo/chỉnh sửa/nối dài video và Gemini TTS. |
| [OpenAI](/vi/commands/openai/) | Tạo/chỉnh ảnh, Codex image driver, TTS và transcription. |
| [MiniMax](/vi/commands/minimax/) | Ảnh/video, i2i giữ chủ thể, speech và music. |
| [OpenRouter](/vi/commands/openrouter/) | Image generation/editing, image-to-video async, TTS và STT qua routing. |
| [Leonardo](/vi/commands/leonardo/) | Account, models, ảnh/video, upscale và trạng thái job. |
| [BytePlus](/vi/commands/byteplus/) | Seedream, Seedance, reference video và 3D. |
| [Cloudflare](/vi/commands/cloudflare/) | Workers AI image/speech và video job qua AI Gateway. |
| [ElevenLabs](/vi/commands/elevenlabs/) | Voice, TTS, clone, STT, music, SFX, dubbing và isolation. |
| [Fish Audio](/vi/commands/fish/) | TTS qua API gốc của Fish Audio (mặc định Drama 3), hội thoại nhiều giọng, từ điển phát âm và voice model. |
| [fal.ai](/vi/commands/fal/) | Bất kỳ model queue nào của fal, cộng lệnh tiện lợi image/video. |
| [Atlas Cloud](/vi/commands/atlascloud/) | Bất kỳ model Atlas Cloud nào: ảnh, chỉnh sửa ảnh, video, âm thanh, 3D và prediction bất đồng bộ có thể tiếp tục. |
| [Replicate](/vi/commands/replicate/) | Bất kỳ model Replicate nào qua API trực tiếp, lệnh tiện lợi image/video, cùng status/cancel prediction. |
| [Runway](/vi/commands/runway/) | Video Gen-4.5 và Gen-4 Turbo, ảnh Gen-4, cùng status/cancel task. |
| [HeyGen](/vi/commands/heygen/) | Video Agent tạo video từ prompt, video avatar theo kịch bản, dịch video, lipsync và TTS. |
| [TopView](/vi/commands/topview/) | Video marketing từ link sản phẩm hoặc tư liệu của bạn, avatar nói và product avatar, ảnh sản phẩm (credit gói web), cùng model video/ảnh của API Platform (số dư USD). |
| [Speech](/vi/commands/speech/) | Text-to-speech trên Gemini, OpenAI, ElevenLabs, MiniMax, Atlas Cloud hoặc Fish Audio với một bộ flag, kiểm tra khả năng của model và fallback phải tự bật. |
| [Scene](/vi/commands/scene/) | Audio hội thoại nhiều nhân vật: voice profile, take được cache theo từng câu, duyệt take và xuất stem. |
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
